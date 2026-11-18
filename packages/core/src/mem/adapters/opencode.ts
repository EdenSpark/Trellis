/**
 * OpenCode persisted-session reader (v1 + v2 stores).
 *
 * OpenCode stores sessions in a WAL-mode SQLite database under its XDG data
 * dir (see `internal/paths.ts:opencodeDbPath`). Two schema generations share
 * that one file; which one is live is detected by table presence in
 * `sqlite_master`.
 *
 * v1 (OpenCode 1.x), confirmed against a live 1.18 store:
 *
 *   - `session`  — id / parent_id (sub-agent chain) / title / directory
 *                  (workspace cwd) / time_created / time_updated
 *   - `message`  — id / session_id / time_created / data (JSON: {role, ...})
 *   - `part`     — message_id / session_id / time_created /
 *                  data (JSON: {type: "text"|"tool"|"reasoning"|..., ...})
 *
 * v2 (OpenCode 2.x), confirmed against the 2.x source (`session/sql.ts`,
 * `schema/session-message.ts`):
 *
 *   - `session_v2`     — id / project_id / parent_id / directory / title /
 *                        time_created / time_updated / ...
 *   - `session_message`— id / session_id / type (discriminated union:
 *                        user / assistant / compaction / system / synthetic /
 *                        skill / shell / idle / *-switched) / seq (monotonic
 *                        per session, unique with session_id) / data (JSON;
 *                        user text in `data.text`, assistant text in
 *                        `data.content[]` elements of type "text", completed
 *                        compactions carry `data.summary`)
 *   - `session_part`   — (message_id, ordinal) expansion of assistant
 *                        `content[]`; redundant for dialogue extraction and
 *                        not read here
 *   - `kv`             — v1→v2 migration state under MIGRATION_STATE_KEY;
 *                        while its phase is not "completed" the v1 tables may
 *                        still hold sessions the importer has not copied, so
 *                        both generations are read and de-duplicated by
 *                        session id (the v2 copy wins)
 *
 * SQLite access is via the zero-dependency parser in
 * `internal/sqlite-readonly.ts`. A `better-sqlite3`-backed reader shipped in
 * 0.6.0-beta.3 and was reverted one release later because its prebuild
 * download + node-gyp fallback broke `npm install` on Windows and restricted
 * networks; no native module, WASM blob, system `sqlite3`, or install-time
 * build step may come back with this adapter.
 *
 * Everything here is read-only: the database is snapshotted and parsed, never
 * opened for write, locked, checkpointed, or copied over.
 */

import * as fs from "node:fs";

import {
  compactionBoundaryTurn,
  stripInjectionTags,
  isBootstrapTurn,
} from "../dialogue.js";
import { inRangeOverlap, sameProject } from "../filter.js";
import { opencodeDbPath } from "../internal/paths.js";
import {
  createSqlitePreparedStore,
  declaresColumn,
  findTable,
  requireColumns,
  requireOneOfColumns,
  requireRowColumns,
  withSqliteDb,
  type SqliteWarningCopy,
} from "../internal/sqlite-adapter.js";
import { type SqliteRow } from "../internal/sqlite-readonly.js";
import { searchInDialogue } from "../search.js";
import type {
  DialogueRole,
  DialogueTurn,
  MemFilter,
  MemSessionInfo,
  MemWarning,
  SearchHit,
} from "../types.js";

// ---------- loose external shapes ----------

interface OpencodeMessageData {
  role?: string;
}

interface OpencodePartData {
  type?: string;
  text?: string;
  summaryMessageId?: unknown;
  tail_start_id?: unknown;
  compactBoundary?: unknown;
  replace?: unknown;
}

function parseDialogueRole(v: unknown): DialogueRole | undefined {
  return v === "user" || v === "assistant" ? v : undefined;
}

/** Safely parse the JSON stored in a `data` column. Returns null on failure —
 * a row carrying hostile or truncated JSON is dropped, never thrown on. */
function parseDataJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---------- schema contract ----------

const SESSION_TABLE = "session";
const MESSAGE_TABLE = "message";
const PART_TABLE = "part";

/** Accepted spellings for the session's workspace directory, in preference
 * order. Current OpenCode uses `directory`; `cwd` is accepted so an older or
 * renamed store still lists rather than failing closed. */
const SESSION_CWD_COLUMNS = ["directory", "cwd"] as const;

const SQLITE_WARNINGS: SqliteWarningCopy = {
  unreadableCode: "opencode-db-unreadable",
  snapshotUnstableCode: "opencode-db-snapshot-unstable",
  schemaUnsupportedCode: "opencode-db-schema-unsupported",
  writingMessage: (dbPath) =>
    `OpenCode is writing to its session database; retry in a moment (${dbPath})`,
  unreadableMessage: (dbPath, error) =>
    `cannot read OpenCode session database (${dbPath}): ${error.message}`,
  unsupportedMessage: (dbPath, error) =>
    `unsupported OpenCode session schema (${dbPath}): ${error.message}`,
};

type ReadOnlyDb = Parameters<
  typeof findTable
>[0];

// ---------- schema version detection ----------

const SESSION_V2_TABLE = "session_v2";
const SESSION_MESSAGE_TABLE = "session_message";
const KV_TABLE = "kv";

/** Key under which OpenCode 2.x records v1→v2 import progress in `kv`, as a
 * JSON value like `{"phase":"sessions","cursor":...}` / `{"phase":"completed"}`. */
const MIGRATION_STATE_KEY = "migration.v1-v2";

interface OpencodeSchemaShape {
  /** `session_v2` exists: this is a v2 store and new sessions land there. */
  v2: boolean;
  /** The v1→v2 import is unfinished, so the v1 tables may still hold
   * sessions that only exist there. Both generations must be read. */
  v1Pending: boolean;
}

/** The import is finished only when the kv marker says so; a missing kv table
 * or key is read conservatively as "possibly incomplete" — reading the
 * leftover v1 tables too is cheap and the id de-dup makes it harmless. */
function migrationCompleted(
  db: ReadOnlyDb,
  names: ReadonlySet<string>,
): boolean {
  if (!names.has(KV_TABLE)) return false;
  const rows = db.scanTable(KV_TABLE, (row) => row.key === MIGRATION_STATE_KEY);
  for (const row of rows) {
    const value = parseDataJson(row.value);
    if (value?.phase === "completed") return true;
  }
  return false;
}

function detectSchemaShape(db: ReadOnlyDb): OpencodeSchemaShape {
  const names = new Set(db.listTables().map((table) => table.name));
  if (!names.has(SESSION_V2_TABLE)) return { v2: false, v1Pending: false };
  const v1Present =
    names.has(SESSION_TABLE) &&
    names.has(MESSAGE_TABLE) &&
    names.has(PART_TABLE);
  return { v2: true, v1Pending: v1Present && !migrationCompleted(db, names) };
}

// ---------- message / part store (v1) ----------

interface OpencodeMessageRow {
  id: string;
  time_created: number;
  /** Scan position, used to break ties so equal timestamps still order
   * deterministically instead of depending on sort stability. */
  seq: number;
  role: DialogueRole;
}

interface OpencodePartRow {
  time_created: number;
  seq: number;
  data: Record<string, unknown>;
}

/**
 * Messages + parts grouped by session. Only the search path builds this for a
 * whole database; extract / context populate it with one session's rows.
 */
interface OpencodeSessionStore {
  messagesBySession: Map<string, OpencodeMessageRow[]>;
  partsByMsg: Map<string, OpencodePartRow[]>;
}

/** Scan position breaks ties so rows written in the same millisecond still
 * order the same way on every run. */
function byTimeThenScan(
  a: { time_created: number; seq: number },
  b: { time_created: number; seq: number },
): number {
  return a.time_created !== b.time_created
    ? a.time_created - b.time_created
    : a.seq - b.seq;
}

function buildSessionStore(
  allMessages: readonly SqliteRow[],
  allParts: readonly SqliteRow[],
): OpencodeSessionStore {
  const messagesBySession = new Map<string, OpencodeMessageRow[]>();
  for (let i = 0; i < allMessages.length; i++) {
    const row = allMessages[i];
    if (!row) continue;
    const sessionId = typeof row.session_id === "string" ? row.session_id : "";
    const id = typeof row.id === "string" ? row.id : "";
    if (!sessionId || !id) continue;
    const data = parseDataJson(row.data) as OpencodeMessageData | null;
    const role = parseDialogueRole(data?.role);
    if (!role) continue;
    const list = messagesBySession.get(sessionId) ?? [];
    list.push({
      id,
      time_created: typeof row.time_created === "number" ? row.time_created : 0,
      seq: i,
      role,
    });
    messagesBySession.set(sessionId, list);
  }

  const partsByMsg = new Map<string, OpencodePartRow[]>();
  for (let i = 0; i < allParts.length; i++) {
    const row = allParts[i];
    if (!row) continue;
    const msgId = typeof row.message_id === "string" ? row.message_id : "";
    if (!msgId) continue;
    const data = parseDataJson(row.data);
    if (!data) continue;
    const list = partsByMsg.get(msgId) ?? [];
    list.push({
      time_created: typeof row.time_created === "number" ? row.time_created : 0,
      seq: i,
      data,
    });
    partsByMsg.set(msgId, list);
  }

  for (const list of messagesBySession.values()) list.sort(byTimeThenScan);
  for (const list of partsByMsg.values()) list.sort(byTimeThenScan);

  return { messagesBySession, partsByMsg };
}

/** Validate `message` / `part` and return the rows selected by `sessionId`, or
 * every row when `sessionId` is undefined (the search store). */
function scanMessagesAndParts(
  db: ReadOnlyDb,
  sessionId: string | undefined,
): OpencodeSessionStore {
  const messageTable = findTable(db, MESSAGE_TABLE);
  requireColumns(messageTable, ["id", "session_id", "data"]);
  const partTable = findTable(db, PART_TABLE);
  requireColumns(partTable, ["message_id", "data"]);

  const messages =
    sessionId === undefined
      ? db.scanTable(MESSAGE_TABLE)
      : db.scanTable(MESSAGE_TABLE, (row) => row.session_id === sessionId);
  requireRowColumns(messages, MESSAGE_TABLE, ["id", "session_id", "data"]);

  let parts: SqliteRow[];
  if (sessionId === undefined) {
    parts = db.scanTable(PART_TABLE);
  } else if (declaresColumn(partTable, "session_id")) {
    // Current OpenCode denormalizes `session_id` onto `part`, so one session's
    // parts can be selected without first materializing its message ids.
    parts = db.scanTable(PART_TABLE, (row) => row.session_id === sessionId);
  } else {
    const messageIds = new Set(
      messages
        .map((row) => row.id)
        .filter((id): id is string => typeof id === "string"),
    );
    parts = db.scanTable(
      PART_TABLE,
      (row) =>
        typeof row.message_id === "string" && messageIds.has(row.message_id),
    );
  }
  requireRowColumns(parts, PART_TABLE, ["message_id", "data"]);

  return buildSessionStore(messages, parts);
}

// ---------- message store (v2) ----------

interface OpencodeV2MessageRow {
  id: string;
  /** Per-session monotonic order; `(session_id, seq)` is unique in v2, so it
   * orders the timeline where v1 needed time_created + scan position. */
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

/** Ids present in `session_v2`, optionally narrowed to one session. Extract
 * uses membership to decide whether a session id is v2-authoritative. */
function scanV2SessionIds(
  db: ReadOnlyDb,
  sessionId: string | undefined,
): Set<string> {
  const table = findTable(db, SESSION_V2_TABLE);
  requireColumns(table, ["id"]);
  const rows =
    sessionId === undefined
      ? db.scanTable(SESSION_V2_TABLE)
      : db.scanTable(SESSION_V2_TABLE, (row) => row.id === sessionId);
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.id === "string") ids.add(row.id);
  }
  return ids;
}

/** Validate `session_message` and return its rows grouped by session, sorted
 * by `seq`. `session_part` is deliberately not read: `session_message.data`
 * already carries the full assistant `content[]`. */
function scanV2Messages(
  db: ReadOnlyDb,
  sessionId: string | undefined,
): Map<string, OpencodeV2MessageRow[]> {
  const table = findTable(db, SESSION_MESSAGE_TABLE);
  requireColumns(table, ["id", "session_id", "type", "seq", "data"]);
  const rows =
    sessionId === undefined
      ? db.scanTable(SESSION_MESSAGE_TABLE)
      : db.scanTable(SESSION_MESSAGE_TABLE, (row) => row.session_id === sessionId);
  requireRowColumns(rows, SESSION_MESSAGE_TABLE, [
    "id",
    "session_id",
    "type",
    "seq",
    "data",
  ]);

  const bySession = new Map<string, OpencodeV2MessageRow[]>();
  for (const row of rows) {
    const sessionId_ = typeof row.session_id === "string" ? row.session_id : "";
    const id = typeof row.id === "string" ? row.id : "";
    const type = typeof row.type === "string" ? row.type : "";
    if (!sessionId_ || !id || !type) continue;
    const data = parseDataJson(row.data);
    if (!data) continue;
    const list = bySession.get(sessionId_) ?? [];
    list.push({
      id,
      seq: typeof row.seq === "number" ? row.seq : 0,
      type,
      data,
    });
    bySession.set(sessionId_, list);
  }
  for (const list of bySession.values()) list.sort((a, b) => a.seq - b.seq);
  return bySession;
}

// ---------- combined store ----------

/**
 * What one open of the database yields. A v1 store fills only `v1`; a v2
 * store fills `v2SessionIds` + `v2Messages` and — while the migration marker
 * is unfinished — also `v1` for the sessions not yet imported.
 */
interface OpencodeStore {
  /** Ids present in `session_v2`; null when the database is a v1 store. */
  v2SessionIds: ReadonlySet<string> | null;
  v2Messages: ReadonlyMap<string, OpencodeV2MessageRow[]>;
  v1: OpencodeSessionStore | null;
}

function emptyStore(): OpencodeStore {
  return { v2SessionIds: null, v2Messages: new Map(), v1: null };
}

function scanStore(
  db: ReadOnlyDb,
  sessionId: string | undefined,
): OpencodeStore {
  const shape = detectSchemaShape(db);
  if (!shape.v2) {
    return {
      v2SessionIds: null,
      v2Messages: new Map(),
      v1: scanMessagesAndParts(db, sessionId),
    };
  }
  return {
    v2SessionIds: scanV2SessionIds(db, sessionId),
    v2Messages: scanV2Messages(db, sessionId),
    v1: shape.v1Pending ? scanMessagesAndParts(db, sessionId) : null,
  };
}

/** Search-scoped whole-db store, prepared and released by the orchestrator.
 * One-session extract / context calls never populate it. */
const preparedStore = createSqlitePreparedStore<OpencodeStore>();

function loadSessionStore(
  dbPath: string,
  warnings: MemWarning[],
  sessionId?: string,
): OpencodeStore {
  return withSqliteDb(dbPath, warnings, SQLITE_WARNINGS, emptyStore(), (db) =>
    scanStore(db, sessionId),
  );
}

export function prepareOpencodeSessionStore(
  dbPath: string,
  warnings: MemWarning[] = [],
): void {
  preparedStore.prepare(dbPath, () => loadSessionStore(dbPath, warnings));
}

export function releaseOpencodeSessionStore(): void {
  preparedStore.release();
}

/** Read the store for one session, reusing the search-scoped prepared store
 * when the orchestrator prepared one for this same database. */
function readSessionStore(
  dbPath: string,
  sessionId: string,
  warnings: MemWarning[],
): OpencodeStore {
  return preparedStore.get(dbPath) ?? loadSessionStore(dbPath, warnings, sessionId);
}

// ---------- compaction ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCompactionSummaryPart(data: Record<string, unknown>): boolean {
  return (
    data.type === "compaction" &&
    (typeof data.tail_start_id === "string" || isRecord(data.compactBoundary))
  );
}

function compactionMarkerSummaryId(
  data: Record<string, unknown>,
): string | undefined {
  return data.type === "compaction" &&
    data.replace === true &&
    typeof data.summaryMessageId === "string"
    ? data.summaryMessageId
    : undefined;
}

/**
 * Identify the messages that carry a compaction summary. The compacted turns
 * remain as rows in the same database, so they stay in the dialogue and the
 * summary message is rendered as a boundary marker in place.
 *
 * The marker shape (`{type:"compaction", replace, summaryMessageId}` plus a
 * summary part with `tail_start_id` / `compactBoundary`) is the one ZCode
 * inherited from its OpenCode fork. If OpenCode never writes it, no message is
 * classified as a summary and every turn reads as ordinary dialogue.
 */
function compactSummaryMessageIds(
  messages: readonly OpencodeMessageRow[],
  partsByMsg: Map<string, OpencodePartRow[]>,
): Set<string> {
  const summaryIds = new Set<string>();
  const markerSummaryIds = new Set<string>();

  for (const msg of messages) {
    if (markerSummaryIds.has(msg.id)) summaryIds.add(msg.id);
    for (const part of partsByMsg.get(msg.id) ?? []) {
      const markerSummaryId = compactionMarkerSummaryId(part.data);
      if (markerSummaryId) markerSummaryIds.add(markerSummaryId);
      if (isCompactionSummaryPart(part.data)) {
        summaryIds.add(msg.id);
        break;
      }
    }
  }
  return summaryIds;
}

/**
 * One message becomes one turn: its `text` parts concatenated, then cleaned.
 * `reasoning`, `tool`, `step-start` and `step-finish` parts are not dialogue
 * and are skipped. Messages left with no text are dropped.
 */
function buildTextTurn(
  msg: OpencodeMessageRow,
  parts: readonly OpencodePartRow[],
  compactSummaryIds: ReadonlySet<string>,
): DialogueTurn | null {
  const collected: string[] = [];
  let totalRaw = 0;
  for (const part of parts) {
    const pd = part.data as OpencodePartData;
    if (pd.type !== "text") continue;
    const txt = typeof pd.text === "string" ? pd.text : "";
    if (!txt) continue;
    totalRaw += txt.length;
    collected.push(stripInjectionTags(txt));
  }
  if (!collected.length) return null;

  const merged = collected.join("\n\n");
  if (compactSummaryIds.has(msg.id)) {
    return compactionBoundaryTurn(
      "context compacted here; the turns above are still in the OpenCode database",
      merged,
    );
  }
  if (isBootstrapTurn(merged, totalRaw)) return null;
  return merged.trim() ? { role: msg.role, text: merged } : null;
}

// ---------- v2 turn extraction ----------

/** v2 user message: `data.text` is the user input, cleaned like a v1 turn. */
function buildV2UserTurn(data: Record<string, unknown>): DialogueTurn | null {
  const raw = typeof data.text === "string" ? data.text : "";
  if (!raw) return null;
  const text = stripInjectionTags(raw);
  if (isBootstrapTurn(text, raw.length)) return null;
  return text.trim() ? { role: "user", text } : null;
}

/** v2 assistant message: text lives in `data.content[]` elements of type
 * "text". `reasoning` and `tool` elements are not dialogue and are skipped,
 * matching what the v1 path does with non-text parts. */
function buildV2AssistantTurn(
  data: Record<string, unknown>,
): DialogueTurn | null {
  const content = data.content;
  if (!Array.isArray(content)) return null;
  const collected: string[] = [];
  let totalRaw = 0;
  for (const element of content) {
    if (!isRecord(element)) continue;
    if (element.type !== "text") continue;
    const txt = typeof element.text === "string" ? element.text : "";
    if (!txt) continue;
    totalRaw += txt.length;
    collected.push(stripInjectionTags(txt));
  }
  if (!collected.length) return null;

  const merged = collected.join("\n\n");
  if (isBootstrapTurn(merged, totalRaw)) return null;
  return merged.trim() ? { role: "assistant", text: merged } : null;
}

/** A completed compaction becomes a boundary marker carrying the summary
 * OpenCode kept; a running/failed compaction changed nothing and is skipped. */
function buildV2CompactionTurn(
  data: Record<string, unknown>,
): DialogueTurn | null {
  if (data.status !== "completed") return null;
  return compactionBoundaryTurn(
    "context compacted here; the turns above are still in the OpenCode database",
    typeof data.summary === "string" ? data.summary : undefined,
  );
}

/**
 * One v2 message becomes at most one turn. `system` / `synthetic` / `skill` /
 * `shell` / `idle` / `*-switched` rows are session bookkeeping, not dialogue.
 * Rows are pre-sorted by `seq` (see {@link scanV2Messages}).
 */
function buildV2Turns(rows: readonly OpencodeV2MessageRow[]): DialogueTurn[] {
  const turns: DialogueTurn[] = [];
  for (const row of rows) {
    const turn =
      row.type === "user"
        ? buildV2UserTurn(row.data)
        : row.type === "assistant"
          ? buildV2AssistantTurn(row.data)
          : row.type === "compaction"
            ? buildV2CompactionTurn(row.data)
            : null;
    if (turn) turns.push(turn);
  }
  return turns;
}

/** v1 extraction over one session of a (possibly whole-db) store. */
function buildV1Turns(
  store: OpencodeSessionStore,
  sessionId: string,
): DialogueTurn[] {
  const messages = store.messagesBySession.get(sessionId) ?? [];
  const summaryIds = compactSummaryMessageIds(messages, store.partsByMsg);
  const turns: DialogueTurn[] = [];
  for (const msg of messages) {
    const turn = buildTextTurn(
      msg,
      store.partsByMsg.get(msg.id) ?? [],
      summaryIds,
    );
    if (turn) turns.push(turn);
  }
  return turns;
}

// ---------- list ----------

/** Largest absolute time value an ECMAScript Date can represent. */
const MAX_TIME_VALUE = 8.64e15;

function toIso(epochMs: unknown): string | undefined {
  // A corrupt or hostile timestamp must degrade to "no timestamp", not throw
  // RangeError out of the row loop and fail the whole command.
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return undefined;
  if (epochMs <= 0 || epochMs > MAX_TIME_VALUE) return undefined;
  return new Date(epochMs).toISOString();
}

interface SessionRowSource {
  rows: SqliteRow[];
  cwdColumn: string;
}

/** Validate the v1 `session` table and return its rows plus the column
 * carrying the workspace directory. */
function scanV1SessionRows(db: ReadOnlyDb): SessionRowSource {
  const table = findTable(db, SESSION_TABLE);
  requireColumns(table, ["id", "time_created", "time_updated"]);
  const cwdColumn = requireOneOfColumns(table, SESSION_CWD_COLUMNS);
  const rows = db.scanTable(SESSION_TABLE);
  requireRowColumns(rows, SESSION_TABLE, [
    "id",
    cwdColumn,
    "time_created",
    "time_updated",
  ]);
  return { rows, cwdColumn };
}

/** Validate `session_v2` and return its rows. `directory` is the only
 * workspace-column spelling in the v2 schema (NOT NULL there). */
function scanV2SessionRows(db: ReadOnlyDb): SessionRowSource {
  const table = findTable(db, SESSION_V2_TABLE);
  requireColumns(table, ["id", "directory", "time_created", "time_updated"]);
  const rows = db.scanTable(SESSION_V2_TABLE);
  requireRowColumns(rows, SESSION_V2_TABLE, [
    "id",
    "directory",
    "time_created",
    "time_updated",
  ]);
  return { rows, cwdColumn: "directory" };
}

/**
 * List OpenCode sessions from the session table(s) only — listing never
 * touches message rows. A machine with no OpenCode store lists nothing and
 * warns about nothing. On a v2 store whose v1→v2 import is still running,
 * both generations are listed and de-duplicated by session id, keeping the
 * v2 copy.
 */
export function opencodeListSessions(
  f: MemFilter,
  warnings: MemWarning[] = [],
): MemSessionInfo[] {
  const dbPath = opencodeDbPath();
  if (dbPath === undefined || !fs.existsSync(dbPath)) return [];

  const sources = withSqliteDb(
    dbPath,
    warnings,
    SQLITE_WARNINGS,
    null as SessionRowSource[] | null,
    (db) => {
      const shape = detectSchemaShape(db);
      if (!shape.v2) return [scanV1SessionRows(db)];
      // v2 first: the id de-dup below keeps the v2 copy of a shared id.
      const listed = [scanV2SessionRows(db)];
      if (shape.v1Pending) listed.push(scanV1SessionRows(db));
      return listed;
    },
  );
  if (!sources) return [];

  const seen = new Set<string>();
  const out: MemSessionInfo[] = [];
  for (const { rows, cwdColumn } of sources) {
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const directory =
        typeof row[cwdColumn] === "string"
          ? (row[cwdColumn] as string)
          : undefined;
      if (f.cwd && !sameProject(directory, f.cwd)) continue;

      const created = toIso(row.time_created);
      const updated = toIso(row.time_updated) ?? created;
      if (!inRangeOverlap(created, updated, f)) continue;

      out.push({
        platform: "opencode",
        id,
        title: typeof row.title === "string" ? row.title : undefined,
        cwd: directory,
        created,
        updated,
        filePath: dbPath,
        // Sub-agent sessions point at their dispatcher; `--include-children`
        // merges them into the parent.
        ...(typeof row.parent_id === "string" && row.parent_id
          ? { parent_id: row.parent_id }
          : {}),
      });
    }
  }
  return out;
}

// ---------- extract / search ----------

export function opencodeExtractDialogue(
  s: MemSessionInfo,
  warnings: MemWarning[] = [],
): DialogueTurn[] {
  const store = readSessionStore(s.filePath, s.id, warnings);
  // A session id present in `session_v2` is authoritative there; the v1 copy
  // the migration left behind must not double its turns.
  if (store.v2SessionIds?.has(s.id)) {
    return buildV2Turns(store.v2Messages.get(s.id) ?? []);
  }
  if (store.v1) return buildV1Turns(store.v1, s.id);
  return [];
}

export function opencodeSearch(
  s: MemSessionInfo,
  kw: string,
  warnings: MemWarning[] = [],
): SearchHit {
  return searchInDialogue(opencodeExtractDialogue(s, warnings), kw);
}
