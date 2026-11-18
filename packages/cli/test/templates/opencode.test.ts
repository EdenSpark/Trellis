import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contextCollector,
  isTrellisSubagent,
  readContextInjectionLimits,
  TrellisContext,
  truncateUtf8,
} from "../../src/templates/opencode/lib/trellis-context.js";
import {
  findUserTextPart,
  prependEphemeralText,
} from "../../src/templates/opencode/lib/context-visibility.js";
import { buildSessionContext } from "../../src/templates/opencode/lib/session-utils.js";
import injectSubagentContextPlugin from "../../src/templates/opencode/plugins/inject-subagent-context.js";
import sessionStartPlugin from "../../src/templates/opencode/plugins/session-start.js";
import injectWorkflowStatePlugin from "../../src/templates/opencode/plugins/inject-workflow-state.js";
import { collectOpenCodeTemplates } from "../../src/configurators/opencode.js";

interface TestContextCollector {
  processed: Set<string>;
  markProcessed(directory: string, sessionID: string): void;
  isProcessed(directory: string, sessionID: string): boolean;
  clear(sessionID: string): void;
}

// ---------------------------------------------------------------------------
// OpenCode v2 mock plugin context
//
// v2 plugins default-export `{ id, setup(ctx) }` and register hooks through
// `ctx.session.hook` / `ctx.tool.hook` / `ctx.shell.hook`. The mock captures
// the registered callbacks so tests can drive them with fabricated events.
// ---------------------------------------------------------------------------

type HookCallback = (event: never) => Promise<void> | void;

interface CapturedHooks {
  session: Map<string, HookCallback>;
  tool: Map<string, HookCallback>;
  shell: Map<string, HookCallback>;
}

interface MockPluginCtx {
  location: { directory: string };
  session: { hook: (name: string, cb: HookCallback) => Promise<{ dispose(): void }> };
  tool: { hook: (name: string, cb: HookCallback) => Promise<{ dispose(): void }> };
  shell: { hook: (name: string, cb: HookCallback) => Promise<{ dispose(): void }> };
}

function createMockPluginCtx(directory: string): {
  ctx: MockPluginCtx;
  hooks: CapturedHooks;
} {
  const hooks: CapturedHooks = {
    session: new Map(),
    tool: new Map(),
    shell: new Map(),
  };
  const register =
    (map: Map<string, HookCallback>) =>
    async (name: string, cb: HookCallback) => {
      map.set(name, cb);
      return {
        dispose: () => {
          map.delete(name);
        },
      };
    };
  return {
    ctx: {
      location: { directory },
      session: { hook: register(hooks.session) },
      tool: { hook: register(hooks.tool) },
      shell: { hook: register(hooks.shell) },
    },
    hooks,
  };
}

// ---------------------------------------------------------------------------
// v2 message fixtures
//
// SessionRequestMessage = Message & { metadata? } — flat objects with
// `role` and a `content` part array. Text parts are `{ type, text }`.
// ---------------------------------------------------------------------------

interface V2Message {
  id?: string;
  role: string;
  content: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
}

interface SessionContextEvent {
  sessionID: string;
  agent: string;
  system: Record<string, unknown>[];
  messages: V2Message[];
  options: Record<string, unknown>;
  tools: Record<string, unknown>;
}

function userTurn(
  text: string,
  opts: { sessionID?: string; agent?: string; messageID?: string } = {},
): V2Message {
  return {
    id: opts.messageID ?? "message-a",
    role: "user",
    content: [{ type: "text", text }],
  };
}

function contextEvent(
  messages: V2Message[],
  opts: { sessionID?: string; agent?: string } = {},
): SessionContextEvent {
  return {
    sessionID: opts.sessionID ?? "main-session",
    agent: opts.agent ?? "build",
    system: [],
    messages,
    options: {},
    tools: {},
  };
}

type ContextHook = (event: SessionContextEvent) => Promise<void>;

interface ToolBeforeEvent {
  tool: string;
  sessionID: string;
  agent: string;
  input: Record<string, unknown>;
}

type ToolBeforeHook = (event: ToolBeforeEvent) => Promise<void>;

async function loadSessionContextHook(directory: string): Promise<ContextHook> {
  const { ctx, hooks } = createMockPluginCtx(directory);
  await sessionStartPlugin.setup(ctx as never);
  const hook = hooks.session.get("context");
  expect(hook).toBeDefined();
  return hook as ContextHook;
}

async function loadWorkflowContextHook(directory: string): Promise<ContextHook> {
  const { ctx, hooks } = createMockPluginCtx(directory);
  await injectWorkflowStatePlugin.setup(ctx as never);
  const hook = hooks.session.get("context");
  expect(hook).toBeDefined();
  return hook as ContextHook;
}

async function loadSubagentHooks(directory: string): Promise<{
  toolBefore: ToolBeforeHook;
}> {
  const { ctx, hooks } = createMockPluginCtx(directory);
  await injectSubagentContextPlugin.setup(ctx as never);
  const toolBefore = hooks.tool.get("execute.before");
  expect(toolBefore).toBeDefined();
  return { toolBefore: toolBefore as ToolBeforeHook };
}

describe("opencode session context dedupe", () => {
  let collector: TestContextCollector;

  beforeEach((): void => {
    collector = contextCollector as TestContextCollector;
  });

  afterEach((): void => {
    collector.clear("session-a");
    collector.clear("session-b");
    collector.processed.clear();
  });

  it("tracks processed sessions in memory for the active process", () => {
    expect(collector.isProcessed("session-a")).toBe(false);

    collector.markProcessed("session-a");
    expect(collector.isProcessed("session-a")).toBe(true);

    collector.clear("session-a");

    expect(collector.isProcessed("session-a")).toBe(false);
  });

  it("does not treat a different session id as already processed", () => {
    collector.markProcessed("session-a");

    expect(collector.isProcessed("session-b")).toBe(false);
  });
});

describe("opencode session-start history detection", () => {
  afterEach((): void => {
    contextCollector.clear("session-a");
  });

  it("builds compact startup context with an adaptive one-shot acknowledgment", () => {
    const context = buildSessionContext({
      directory: "/tmp/trellis-opencode-test",
      getActiveTask: () => ({ taskPath: null, source: "none", stale: false }),
      getContextKey: () => null,
      getCurrentTask: () => null,
      readFile: () => "",
      readProjectFile: () => "",
      resolveTaskDir: () => null,
      runScript: () => "",
    });

    expect(context.startsWith("<session-context>")).toBe(true);
    expect(context).toContain("Trellis compact SessionStart context");
    expect(context).toContain("<first-reply-notice>");
    expect(context).toContain("the user's current request");
    expect(context).toContain("the user message that triggered this reply");
    expect(context).toContain("has no clear natural language");
    expect(context).toContain(
      "explicitly established project communication language",
    );
    expect(context).toContain("Trellis SessionStart ✓");
    expect(context).toContain("Continue directly with the user's request");
    expect(context).toContain(
      "must not alter the language used for the remainder of the response",
    );
    expect(context).toContain("This notice is one-shot");
    expect(context.indexOf("the user's current request")).toBeLessThan(
      context.indexOf("explicitly established project communication language"),
    );
    expect(
      context.indexOf("explicitly established project communication language"),
    ).toBeLessThan(context.indexOf("Trellis SessionStart ✓"));
    expect(context.indexOf("<first-reply-notice>")).toBeLessThan(
      context.indexOf("<current-state>"),
    );
    expect(context).toContain("<guidelines>");
    expect(context).toContain("<ready>");
    expect(context).not.toContain("say once in Chinese");
    expect(context).not.toContain("exactly one short Chinese sentence");
    expect(context).not.toContain(
      "Trellis SessionStart 已注入：workflow、当前任务状态、开发者身份、git 状态、active tasks、spec 索引已加载。",
    );
  });

  it("injects startup context onto the latest user message without mutating stored parts", async () => {
    const hook = await loadSessionContextHook("/tmp/trellis-opencode-test");

    const firstUser = userTurn("First request", { sessionID: "session-a" });
    const originalFirstContent = firstUser.content;
    const firstEvent = contextEvent([firstUser], { sessionID: "session-a" });
    await hook(firstEvent);

    expect(originalFirstContent).toHaveLength(1);
    expect(originalFirstContent[0].text).toBe("First request");
    const injectedFirst = firstEvent.messages[0];
    expect(injectedFirst).not.toBe(firstUser);
    expect(injectedFirst.content[0]).toMatchObject({ type: "text" });
    expect(injectedFirst.content[0].text).toMatch(/^<session-context>/);
    expect(injectedFirst.content[0].text).toContain("<first-reply-notice>");
    expect(injectedFirst.content[0].text).toContain("Trellis SessionStart ✓");
    expect(injectedFirst.content[1]).toEqual(originalFirstContent[0]);

    const laterUser = userTurn("Second request", { messageID: "message-b" });
    const originalLaterContent = laterUser.content;
    const laterEvent = contextEvent(
      [firstUser, { role: "assistant", content: [] }, laterUser],
      { sessionID: "session-a" },
    );
    await hook(laterEvent);

    expect(laterEvent.messages[0]).toBe(firstUser);
    expect(laterEvent.messages[0].content).toBe(originalFirstContent);
    expect(originalLaterContent).toHaveLength(1);
    const injectedLater = laterEvent.messages[2];
    expect(injectedLater.content[0].text).toMatch(/^<session-context>/);
    expect(injectedLater.content[0].text).not.toContain("<first-reply-notice>");
    expect(injectedLater.content[1]).toEqual(originalLaterContent[0]);
  });
});

describe("opencode shell command prefix injection", () => {
  let toolBefore: ToolBeforeHook;

  beforeEach(async () => {
    toolBefore = (await loadSubagentHooks("/tmp/trellis-opencode-test"))
      .toolBefore;
  });

  function shellEvent(command: string, sessionID?: string): ToolBeforeEvent {
    return {
      tool: "shell",
      sessionID: sessionID ?? "oc-a",
      agent: "build",
      input: { command },
    };
  }

  async function withMockedHost(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    run: () => Promise<void>,
  ): Promise<void> {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform });
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(env)) {
      saved[key] = process.env[key];
      process.env[key] = env[key];
    }
    try {
      await run();
    } finally {
      for (const key of Object.keys(env)) {
        if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = saved[key];
      }
      if (descriptor) Object.defineProperty(process, "platform", descriptor);
    }
  }

  it("prefixes shell commands with TRELLIS_CONTEXT_ID from the hook sessionID", async () => {
    const event = shellEvent(
      "python3 ./.trellis/scripts/task.py start .trellis/tasks/demo",
    );

    await toolBefore(event);

    expect(event.input.command).toBe(
      "export TRELLIS_CONTEXT_ID='opencode_oc-a'; python3 ./.trellis/scripts/task.py start .trellis/tasks/demo",
    );
  });

  it("does not inject without a sessionID on the event", async () => {
    const event = shellEvent("git status --short", "");
    event.sessionID = "";

    await toolBefore(event);

    expect(event.input.command).toBe("git status --short");
  });

  it("is idempotent — an already-prefixed command is left untouched", async () => {
    const event = shellEvent(
      "export TRELLIS_CONTEXT_ID='opencode_oc-a'; git status --short",
    );

    await toolBefore(event);

    expect(event.input.command).toBe(
      "export TRELLIS_CONTEXT_ID='opencode_oc-a'; git status --short",
    );
  });

  it("does not duplicate an explicit TRELLIS_CONTEXT_ID assignment", async () => {
    for (const command of [
      "TRELLIS_CONTEXT_ID=manual python3 ./.trellis/scripts/task.py current",
      "export TRELLIS_CONTEXT_ID=manual; python3 ./.trellis/scripts/task.py current",
      "env FOO=bar TRELLIS_CONTEXT_ID=manual python3 ./.trellis/scripts/task.py current",
    ]) {
      const event = shellEvent(command);
      await toolBefore(event);
      expect(event.input.command).toBe(command);
    }
  });

  it("does not treat a grep pattern as an explicit TRELLIS_CONTEXT_ID assignment", async () => {
    const event = shellEvent("env | sort | grep '^TRELLIS_CONTEXT_ID='");

    await toolBefore(event);

    expect(event.input.command).toBe(
      "export TRELLIS_CONTEXT_ID='opencode_oc-a'; env | sort | grep '^TRELLIS_CONTEXT_ID='",
    );
  });

  it("uses PowerShell environment syntax on Windows", async () => {
    await withMockedHost("win32", { SHELL: "", OSTYPE: "" }, async () => {
      const event = shellEvent(
        "python ./.trellis/scripts/task.py start .trellis/tasks/demo",
      );

      await toolBefore(event);

      expect(event.input.command).toBe(
        "$env:TRELLIS_CONTEXT_ID = 'opencode_oc-a'; python ./.trellis/scripts/task.py start .trellis/tasks/demo",
      );
    });
  });

  it("does not duplicate an explicit PowerShell TRELLIS_CONTEXT_ID assignment", async () => {
    await withMockedHost("win32", { SHELL: "", OSTYPE: "" }, async () => {
      const command =
        "$env:TRELLIS_CONTEXT_ID = 'manual'; python ./.trellis/scripts/task.py current";
      const event = shellEvent(command);

      await toolBefore(event);

      expect(event.input.command).toBe(command);
    });
  });

  it("uses POSIX environment syntax on Windows Git Bash", async () => {
    await withMockedHost("win32", { MSYSTEM: "MINGW64" }, async () => {
      const event = shellEvent("git diff --name-only");

      await toolBefore(event);

      expect(event.input.command).toBe(
        "export TRELLIS_CONTEXT_ID='opencode_oc-a'; git diff --name-only",
      );
    });
  });

  it("uses POSIX environment syntax when Windows OSTYPE indicates MSYS", async () => {
    await withMockedHost("win32", { OSTYPE: "msys" }, async () => {
      const event = shellEvent("git status --short");

      await toolBefore(event);

      expect(event.input.command).toBe(
        "export TRELLIS_CONTEXT_ID='opencode_oc-a'; git status --short",
      );
    });
  });

  it("honors the TRELLIS_HOOKS / TRELLIS_DISABLE_HOOKS gates", async () => {
    for (const [key, value] of [
      ["TRELLIS_HOOKS", "0"],
      ["TRELLIS_DISABLE_HOOKS", "1"],
    ] as const) {
      const previous = process.env[key];
      process.env[key] = value;
      try {
        const event = shellEvent("git status --short");
        await toolBefore(event);
        expect(event.input.command).toBe("git status --short");
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = previous;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #264 — sub-agent context injection + transform skip
// ---------------------------------------------------------------------------

function setupTrellisProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "trellis-opencode-264-"));
  const taskDir = join(dir, ".trellis", "tasks", "demo-task");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(join(dir, ".trellis", ".runtime", "sessions"), { recursive: true });
  writeFileSync(join(taskDir, "prd.md"), "# Demo PRD\n\nGoal: verify injection.");
  writeFileSync(join(taskDir, "implement.jsonl"), "");
  writeFileSync(join(taskDir, "check.jsonl"), "");
  writeFileSync(
    join(dir, ".trellis", "workflow.md"),
    [
      "# Workflow",
      "",
      "[workflow-state:in_progress]",
      "Active task: <task path>. Dispatch trellis-implement or trellis-check.",
      "[/workflow-state:in_progress]",
      "",
    ].join("\n"),
  );
  return dir;
}

function writeSessionFile(dir: string, key: string, taskRef: string): void {
  const file = join(dir, ".trellis", ".runtime", "sessions", `${key}.json`);
  writeFileSync(file, JSON.stringify({ current_task: taskRef }, null, 2));
}

describe("opencode subagent helper", () => {
  it("isTrellisSubagent matches the three trellis sub-agent names", () => {
    expect(isTrellisSubagent({ agent: "trellis-implement" })).toBe(true);
    expect(isTrellisSubagent({ agent: "trellis-check" })).toBe(true);
    expect(isTrellisSubagent({ agent: "trellis-research" })).toBe(true);
  });

  it("isTrellisSubagent rejects unrelated agents", () => {
    expect(isTrellisSubagent({ agent: "build" })).toBe(false);
    expect(isTrellisSubagent({ agent: "trellis-implement-extra" })).toBe(false);
    expect(isTrellisSubagent({ agent: undefined })).toBe(false);
    expect(isTrellisSubagent({})).toBe(false);
    expect(isTrellisSubagent(null)).toBe(false);
  });
});

describe("opencode TrellisContext single-session fallback", () => {
  let dir: string;

  beforeEach(() => {
    dir = setupTrellisProject();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the only session file when exactly one exists", () => {
    writeSessionFile(dir, "opencode_sole", ".trellis/tasks/demo-task");
    const ctx = new TrellisContext(dir);
    const active = ctx.getActiveTask({ sessionID: "missing-key" });

    expect(active.taskPath).toBe(".trellis/tasks/demo-task");
    expect(active.source).toBe("session-fallback:opencode_sole");
    expect(active.stale).toBe(false);
  });

  it("refuses to guess when two or more session files exist", () => {
    writeSessionFile(dir, "opencode_a", ".trellis/tasks/demo-task");
    writeSessionFile(dir, "opencode_b", ".trellis/tasks/demo-task");
    const ctx = new TrellisContext(dir);
    const active = ctx.getActiveTask({ sessionID: "missing-key" });

    expect(active.taskPath).toBeNull();
    expect(active.source).toBe("none");
  });

  it("returns no task when zero session files exist (Python parity)", () => {
    // sessions/ exists from setupTrellisProject but contains no files
    const ctx = new TrellisContext(dir);
    const active = ctx.getActiveTask({ sessionID: "missing-key" });

    expect(active.taskPath).toBeNull();
    expect(active.source).toBe("none");
  });

  it("prefers an exact context-key match over the fallback", () => {
    writeSessionFile(dir, "opencode_session_exact", ".trellis/tasks/demo-task");
    writeSessionFile(dir, "opencode_other", ".trellis/tasks/demo-task");
    const ctx = new TrellisContext(dir);
    const active = ctx.getActiveTask({ sessionID: "exact" });

    // sessionID="exact" maps to "opencode_exact" via buildContextKey; we
    // wrote "opencode_session_exact" so the exact lookup misses, but the
    // presence of ≥2 files means fallback should also refuse — proving
    // exact match is attempted first.
    expect(active.taskPath).toBeNull();
  });
});

describe("opencode inject-subagent-context (issue #264)", () => {
  let dir: string;
  let toolBefore: ToolBeforeHook;

  beforeEach(async () => {
    dir = setupTrellisProject();
    toolBefore = (await loadSubagentHooks(dir)).toolBefore;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function taskEvent(prompt: string, subagentType: string): ToolBeforeEvent {
    return {
      tool: "subagent",
      sessionID: "stranger",
      agent: "build",
      input: {
        agent: subagentType,
        description: "dispatch",
        prompt,
      },
    };
  }

  it("ignores the v1 task tool name", async () => {
    const event: ToolBeforeEvent = {
      tool: "task",
      sessionID: "stranger",
      agent: "build",
      input: {
        subagent_type: "trellis-implement",
        prompt: "do the implementation",
      },
    };

    await toolBefore(event);

    expect(event.input.prompt).toBe("do the implementation");
  });

  it("mutates implement prompt using single-session fallback when sessionID misses", async () => {
    writeSessionFile(dir, "opencode_sole", ".trellis/tasks/demo-task");
    const event = taskEvent("do the implementation", "trellis-implement");

    await toolBefore(event);

    const prompt = event.input.prompt as string;
    expect(prompt).toContain("<!-- trellis-hook-injected -->");
    expect(prompt).toContain("# Implement Agent Task");
    expect(prompt).toContain("Demo PRD");
    expect(prompt).toContain("do the implementation");
    // Marker must be at the top so generated agent definitions can detect
    // successful injection via a prefix check.
    expect(prompt.startsWith("<!-- trellis-hook-injected -->")).toBe(true);
  });

  it("inlines JSONL-referenced spec content into the implement prompt", async () => {
    // Cover AC #1: "JSONL-referenced context" — the seed-only jsonl path
    // is exercised above; this one verifies a curated entry is inlined.
    const specPath = join(dir, ".trellis", "spec", "demo.md");
    mkdirSync(join(dir, ".trellis", "spec"), { recursive: true });
    writeFileSync(specPath, "# Demo Spec\n\nUNIQUE_SPEC_MARKER_42");
    writeFileSync(
      join(dir, ".trellis", "tasks", "demo-task", "implement.jsonl"),
      JSON.stringify({ file: ".trellis/spec/demo.md", reason: "test" }) + "\n",
    );
    writeSessionFile(dir, "opencode_sole", ".trellis/tasks/demo-task");

    const event = taskEvent("do the implementation", "trellis-implement");

    await toolBefore(event);

    const prompt = event.input.prompt as string;
    expect(prompt).toContain("<!-- trellis-hook-injected -->");
    expect(prompt).toContain("=== .trellis/spec/demo.md ===");
    expect(prompt).toContain("UNIQUE_SPEC_MARKER_42");
    expect(prompt).toContain("Demo PRD");
  });

  it("mutates check prompt using Active task hint when runtime resolution fails", async () => {
    // No session file → both session lookup and single-session fallback miss.
    // Hint is the only resolver.
    const event = taskEvent(
      "Active task: .trellis/tasks/demo-task\n\nplease check",
      "trellis-check",
    );

    await toolBefore(event);

    const prompt = event.input.prompt as string;
    expect(prompt).toContain("<!-- trellis-hook-injected -->");
    expect(prompt).toContain("# Check Agent Task");
    expect(prompt).toContain("Demo PRD");
  });

  it("Active task hint takes precedence over single-session fallback", async () => {
    // Set up TWO matches: a session file pointing at demo-task AND a hint
    // pointing at a different task path. Hint should win.
    writeSessionFile(dir, "opencode_sole", ".trellis/tasks/another-task");
    const hintTask = join(dir, ".trellis", "tasks", "hint-task");
    mkdirSync(hintTask, { recursive: true });
    writeFileSync(join(hintTask, "prd.md"), "# Hint PRD\n\nfrom hint");
    writeFileSync(join(hintTask, "implement.jsonl"), "");

    const event = taskEvent(
      "Active task: .trellis/tasks/hint-task\n\ngo",
      "trellis-implement",
    );

    await toolBefore(event);

    const prompt = event.input.prompt as string;
    expect(prompt).toContain("Hint PRD");
    expect(prompt).not.toContain("Demo PRD");
  });

  it("emits the trellis-hook-injected marker for research agent too", async () => {
    const event = taskEvent("investigate something", "trellis-research");

    await toolBefore(event);

    const prompt = event.input.prompt as string;
    expect(prompt).toContain("<!-- trellis-hook-injected -->");
    expect(prompt).toContain("# Research Agent Task");
  });

  it("skips when no task can be resolved through any path", async () => {
    const event = taskEvent("implement without context", "trellis-implement");

    await toolBefore(event);

    // Prompt is left untouched when implement/check can't find a task
    expect(event.input.prompt).toBe("implement without context");
  });
});

describe("opencode context hook injection (issue #553)", () => {
  let dir: string;

  beforeEach(() => {
    dir = setupTrellisProject();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ephemeralTexts(message: V2Message): string[] {
    // Ephemeral parts are the first N text parts, N tracked in message
    // metadata (see context-visibility.js).
    const trellis = (message.metadata?.trellis ?? {}) as Record<string, unknown>;
    const count =
      typeof trellis.ephemeralParts === "number" ? trellis.ephemeralParts : 0;
    return message.content
      .slice(0, count)
      .map(part => part.text as string);
  }

  it("injects both plugins onto the latest user message without mutating history", async () => {
    for (const order of [
      ["sessionStart", "workflowState"],
      ["workflowState", "sessionStart"],
    ]) {
      const earlier = userTurn("old prompt", { messageID: "message-old" });
      const latest: V2Message = {
        id: "message-new",
        role: "user",
        content: [{ type: "text", text: "ordinary user prompt" }],
      };
      const originalEarlierContent = earlier.content;
      const originalLatestContent = latest.content;
      const event = contextEvent([
        earlier,
        { role: "assistant", content: [] },
        latest,
      ]);
      const sessionHook = await loadSessionContextHook(dir);
      const workflowHook = await loadWorkflowContextHook(dir);

      for (const kind of order) {
        const hook = kind === "sessionStart" ? sessionHook : workflowHook;
        await hook(event);
      }

      expect(event.messages[0]).toBe(earlier);
      expect(event.messages[0].content).toBe(originalEarlierContent);
      expect(originalLatestContent).toEqual([
        { type: "text", text: "ordinary user prompt" },
      ]);
      const injected = event.messages[2];
      expect(injected).not.toBe(latest);
      const texts = ephemeralTexts(injected);
      expect(texts.some(text => text.startsWith("<session-context>"))).toBe(
        true,
      );
      expect(texts.some(text => text.startsWith("<workflow-state>"))).toBe(
        true,
      );
      expect(injected.content.at(-1)).toEqual({
        type: "text",
        text: "ordinary user prompt",
      });
    }
  });

  it("prepends ephemeral text onto attachment-only latest user messages", async () => {
    const attachment: Record<string, unknown> = {
      type: "media",
      media: { source: { type: "url", url: "https://example.com/report.pdf" } },
      filename: "report.pdf",
    };
    const latest: V2Message = {
      id: "attachment-only-message",
      role: "user",
      content: [attachment],
    };
    const originalContent = latest.content;
    const event = contextEvent([latest]);
    const sessionHook = await loadSessionContextHook(dir);
    const workflowHook = await loadWorkflowContextHook(dir);
    await workflowHook(event);
    await sessionHook(event);

    expect(originalContent).toEqual([attachment]);
    const texts = ephemeralTexts(event.messages[0]);
    expect(texts.some(text => text.startsWith("<session-context>"))).toBe(true);
    expect(texts.some(text => text.startsWith("<workflow-state>"))).toBe(true);
    expect(event.messages[0].content.at(-1)).toEqual(attachment);
  });

  it("injects onto messages without a message id", async () => {
    const sessionHook = await loadSessionContextHook(dir);
    const workflowHook = await loadWorkflowContextHook(dir);
    const latest: V2Message = {
      role: "user",
      content: [{ type: "text", text: "original" }],
    };
    const originalContent = latest.content;
    const event = contextEvent([latest]);
    await sessionHook(event);
    await workflowHook(event);
    expect(originalContent).toEqual([{ type: "text", text: "original" }]);
    expect(ephemeralTexts(event.messages[0])).toHaveLength(2);
    expect(event.messages[0].content.at(-1)).toEqual({
      type: "text",
      text: "original",
    });
  });

  it("checks the skip keyword only in ordinary user text", async () => {
    const hook = await loadWorkflowContextHook(dir);
    const latest: V2Message = {
      role: "user",
      content: [
        { type: "text", text: "machine context containing no-trellis" },
        { type: "text", text: "ordinary prompt" },
      ],
      metadata: { trellis: { ephemeralParts: 1 } },
    };
    const event = contextEvent([latest]);
    await hook(event);
    expect(
      ephemeralTexts(event.messages[0]).some(text =>
        text.startsWith("<workflow-state>"),
      ),
    ).toBe(true);
    expect(event.messages[0].content.at(-1)).toEqual({
      type: "text",
      text: "ordinary prompt",
    });
  });

  it("keeps both plugins disabled by their existing environment gates", async () => {
    const sessionHook = await loadSessionContextHook(dir);
    const workflowHook = await loadWorkflowContextHook(dir);
    const cases = [
      ["TRELLIS_HOOKS", "0"],
      ["TRELLIS_DISABLE_HOOKS", "1"],
      ["OPENCODE_NON_INTERACTIVE", "1"],
    ] as const;

    for (const [key, value] of cases) {
      const previous = process.env[key];
      process.env[key] = value;
      try {
        for (const hook of [sessionHook, workflowHook]) {
          const latest = userTurn("original");
          const original = latest.content;
          const event = contextEvent([latest]);
          await hook(event);
          expect(event.messages[0]).toBe(latest);
          expect(event.messages[0].content).toBe(original);
        }
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = previous;
      }
    }
  });

  it("session-start.js early-returns when the event agent is a trellis sub-agent", async () => {
    const hook = await loadSessionContextHook(dir);
    const latest = userTurn("original");
    const original = latest.content;
    const event = contextEvent([latest], { agent: "trellis-implement" });
    await hook(event);
    expect(event.messages[0]).toBe(latest);
    expect(event.messages[0].content).toBe(original);
  });

  it("session-start.js skips trellis-check and trellis-research", async () => {
    const hook = await loadSessionContextHook(dir);
    for (const agent of ["trellis-check", "trellis-research"]) {
      const latest = userTurn("untouched");
      const event = contextEvent([latest], { agent });
      await hook(event);
      expect(event.messages[0].content[0].text).toBe("untouched");
    }
  });

  it("inject-workflow-state.js early-returns when the event agent is a trellis sub-agent", async () => {
    const hook = await loadWorkflowContextHook(dir);
    const latest = userTurn("original");
    const original = latest.content;
    const event = contextEvent([latest], { agent: "trellis-implement" });
    await hook(event);
    expect(event.messages[0]).toBe(latest);
    expect(event.messages[0].content).toBe(original);
  });

  it("inject-workflow-state.js still injects breadcrumb for main-session turns", async () => {
    const hook = await loadWorkflowContextHook(dir);
    const latest = userTurn("user prompt");
    const original = latest.content[0];
    const event = contextEvent([latest]);
    await hook(event);
    const injected = event.messages[0];
    expect(injected.content[0].text).toContain("<workflow-state>");
    expect(injected.content[1]).toEqual(original);
  });

  it("inject-workflow-state.js skips injection when the prompt contains the default skip keyword", async () => {
    const hook = await loadWorkflowContextHook(dir);
    const latest = userTurn("no-trellis what does this regex do");
    const original = latest.content;
    const event = contextEvent([latest]);
    await hook(event);
    expect(event.messages[0]).toBe(latest);
    expect(event.messages[0].content).toBe(original);
  });

  it("inject-workflow-state.js does not skip on 'no-trellisfoo' (word-boundary negative)", async () => {
    const hook = await loadWorkflowContextHook(dir);
    const latest = userTurn("no-trellisfoo is a strange word");
    const event = contextEvent([latest]);
    await hook(event);
    expect(event.messages[0].content[0].text).toContain("<workflow-state>");
  });

  it("inject-workflow-state.js honors a custom prompt_injection.skip_keyword", async () => {
    writeFileSync(
      join(dir, ".trellis", "config.yaml"),
      ["prompt_injection:", '  skip_keyword: "off-topic"'].join("\n"),
    );
    const hook = await loadWorkflowContextHook(dir);

    const skipped = userTurn("off-topic question");
    const skippedEvent = contextEvent([skipped]);
    await hook(skippedEvent);
    expect(skippedEvent.messages[0]).toBe(skipped);

    const notSkipped = userTurn("no-trellis question", {
      messageID: "message-custom-keyword",
    });
    const notSkippedEvent = contextEvent([notSkipped]);
    await hook(notSkippedEvent);
    expect(notSkippedEvent.messages[0].content[0].text).toContain(
      "<workflow-state>",
    );
  });

  it("inject-workflow-state.js disables the escape hatch with skip_keyword: \"\"", async () => {
    writeFileSync(
      join(dir, ".trellis", "config.yaml"),
      ["prompt_injection:", '  skip_keyword: ""'].join("\n"),
    );
    const hook = await loadWorkflowContextHook(dir);
    const latest = userTurn("no-trellis question");
    const event = contextEvent([latest]);
    await hook(event);
    expect(event.messages[0].content[0].text).toContain("<workflow-state>");
  });
});

describe("opencode ephemeral transform helpers", () => {
  it("clones only the latest user message when prepending text", () => {
    const earlier = userTurn("old");
    const latest = userTurn("new", { messageID: "message-b" });
    const messages = [earlier, { role: "assistant", content: [] }, latest];
    expect(prependEphemeralText(messages, "ephemeral")).toBe(true);
    expect(messages[0]).toBe(earlier);
    expect(messages[2]).not.toBe(latest);
    expect(latest.content).toHaveLength(1);
    expect(messages[2].content[0]).toEqual({ type: "text", text: "ephemeral" });
    expect(messages[2].content[1]).toBe(latest.content[0]);
    expect(messages[2].metadata).toEqual({ trellis: { ephemeralParts: 1 } });
  });

  it("tracks stacked ephemeral parts so findUserTextPart skips them", () => {
    const latest = userTurn("user prompt");
    const messages = [latest];
    expect(prependEphemeralText(messages, "first")).toBe(true);
    expect(prependEphemeralText(messages, "second")).toBe(true);
    expect(messages[0].content.map(part => part.text)).toEqual([
      "second",
      "first",
      "user prompt",
    ]);
    expect(findUserTextPart(messages[0])).toEqual({
      type: "text",
      text: "user prompt",
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #441 — sub-agent context injection limits
// ---------------------------------------------------------------------------

describe("opencode context injection limits (issue #441)", () => {
  let dir: string;

  beforeEach(() => {
    dir = setupTrellisProject();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    writeFileSync(join(dir, ".trellis", "config.yaml"), yaml, "utf-8");
  }

  function writeJsonlEntries(entries: Record<string, string>[]): void {
    writeFileSync(
      join(dir, ".trellis", "tasks", "demo-task", "implement.jsonl"),
      entries.map(e => JSON.stringify(e)).join("\n") + "\n",
      "utf-8",
    );
  }

  async function runImplementHook(): Promise<string> {
    writeSessionFile(dir, "opencode_sole", ".trellis/tasks/demo-task");
    const { toolBefore } = await loadSubagentHooks(dir);
    const event: ToolBeforeEvent = {
      tool: "subagent",
      sessionID: "stranger",
      agent: "build",
      input: {
        agent: "trellis-implement",
        description: "dispatch",
        prompt: "do the implementation",
      },
    };
    await toolBefore(event);
    return (event.input.prompt as string) ?? "";
  }

  describe("truncateUtf8", () => {
    it("leaves data untouched when cap is 0 (unlimited)", () => {
      const data = Buffer.from("X".repeat(1000));
      expect(truncateUtf8(data, 0)).toEqual(data);
    });

    it("leaves data untouched when data is at or under the cap", () => {
      const data = Buffer.from("hello world");
      expect(truncateUtf8(data, data.length)).toEqual(data);
      expect(truncateUtf8(data, data.length + 5)).toEqual(data);
    });

    it("truncates ASCII data exactly at the cap (1 byte over cap)", () => {
      const data = Buffer.from("abcdefghij"); // 10 bytes
      expect(truncateUtf8(data, 9)).toEqual(Buffer.from("abcdefghi"));
    });

    it("never splits a 2-byte UTF-8 sequence at the boundary (café)", () => {
      const data = Buffer.from("café", "utf-8");
      for (let cap = 0; cap <= data.length; cap++) {
        // Buffer#toString replaces invalid sequences with U+FFFD; a correct
        // cut never produces one.
        expect(truncateUtf8(data, cap).toString("utf-8")).not.toContain("�");
      }
      expect(truncateUtf8(data, 4).toString("utf-8")).toBe("caf");
    });

    it("never splits a 3-byte UTF-8 sequence at the boundary (euro sign)", () => {
      const data = Buffer.from("x€", "utf-8"); // x + 3-byte euro sign
      for (let cap = 0; cap <= data.length; cap++) {
        expect(truncateUtf8(data, cap).toString("utf-8")).not.toContain("�");
      }
    });
  });

  describe("readContextInjectionLimits", () => {
    it("returns built-in defaults when config.yaml is absent", () => {
      expect(readContextInjectionLimits(dir)).toEqual({
        max_file_bytes: 32768,
        max_artifact_bytes: 65536,
        max_total_bytes: 131072,
      });
    });

    it("returns built-in defaults when config.yaml has no context_injection section", () => {
      writeConfig("session_auto_commit: true\n");
      expect(readContextInjectionLimits(dir)).toEqual({
        max_file_bytes: 32768,
        max_artifact_bytes: 65536,
        max_total_bytes: 131072,
      });
    });

    it("applies explicit overrides for all three keys", () => {
      writeConfig(
        [
          "context_injection:",
          "  max_file_bytes: 100",
          "  max_artifact_bytes: 200",
          "  max_total_bytes: 300",
        ].join("\n"),
      );
      expect(readContextInjectionLimits(dir)).toEqual({
        max_file_bytes: 100,
        max_artifact_bytes: 200,
        max_total_bytes: 300,
      });
    });

    it("0 means unlimited and is preserved as-is (not replaced by default)", () => {
      writeConfig(["context_injection:", "  max_total_bytes: 0"].join("\n"));
      expect(readContextInjectionLimits(dir).max_total_bytes).toBe(0);
    });

    it("falls back to default for a negative value", () => {
      writeConfig(["context_injection:", "  max_file_bytes: -5"].join("\n"));
      expect(readContextInjectionLimits(dir).max_file_bytes).toBe(32768);
    });

    it("falls back to default for a non-integer value", () => {
      writeConfig(
        ["context_injection:", "  max_artifact_bytes: not-a-number"].join("\n"),
      );
      expect(readContextInjectionLimits(dir).max_artifact_bytes).toBe(65536);
    });
  });

  describe("inject-subagent-context plugin", () => {
    it("inlines under-cap content unchanged with no notices (golden)", async () => {
      writeFileSync(join(dir, "small.md"), "small spec content\n", "utf-8");
      writeJsonlEntries([{ file: "small.md", reason: "r" }]);

      const prompt = await runImplementHook();

      expect(prompt).toContain("=== small.md ===\nsmall spec content");
      expect(prompt).toContain(
        "=== .trellis/tasks/demo-task/prd.md (Requirements) ===\n# Demo PRD",
      );
      expect(prompt).not.toContain("[Trellis: truncated");
      expect(prompt).not.toContain("[Trellis: not inlined");
    });

    it("keeps binary jsonl references as notices even when limits are unlimited", async () => {
      const binary = Buffer.from([
        0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x41, 0x42,
      ]);
      writeFileSync(join(dir, "design.png"), binary);
      writeFileSync(join(dir, "invalid.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
      writeJsonlEntries([
        { file: "design.png", reason: "visual baseline" },
        { file: "invalid.bin", reason: "legacy export" },
      ]);
      writeConfig(
        [
          "context_injection:",
          "  max_file_bytes: 0",
          "  max_total_bytes: 0",
        ].join("\n"),
      );

      const prompt = await runImplementHook();

      expect(prompt).toContain(
        "[Trellis: not inlined (binary file) — design.png (10 bytes): visual baseline]",
      );
      expect(prompt).toContain(
        "[Trellis: not inlined (binary file) — invalid.bin (3 bytes): legacy export]",
      );
      expect(prompt).not.toContain("=== design.png ===");
      expect(prompt).not.toContain("=== invalid.bin ===");
      expect(prompt).not.toContain(String.fromCharCode(0));
      expect(prompt).not.toContain("�");
    });

    it("does not misclassify legitimate multi-byte UTF-8 content as binary", async () => {
      const multiByteContent =
        "emoji: 🎉🚀 cjk: 中文测试 bmp: café naïve\n";
      writeFileSync(join(dir, "multibyte.md"), multiByteContent, "utf-8");
      writeJsonlEntries([{ file: "multibyte.md", reason: "unicode spec" }]);

      const prompt = await runImplementHook();

      expect(prompt).toContain(`=== multibyte.md ===\n${multiByteContent}`);
      expect(prompt).not.toContain("[Trellis: not inlined (binary file)");
    });

    it("classifies a file as binary when binary bytes appear only at the end", async () => {
      const mixed = Buffer.concat([
        Buffer.from("looks like a normal text file up front\n", "utf-8"),
        Buffer.from([0x00, 0xff, 0xfe]),
      ]);
      writeFileSync(join(dir, "mixed.dat"), mixed);
      writeJsonlEntries([{ file: "mixed.dat", reason: "mixed content" }]);

      const prompt = await runImplementHook();

      expect(prompt).toContain(
        `[Trellis: not inlined (binary file) — mixed.dat (${mixed.length} bytes): mixed content]`,
      );
      expect(prompt).not.toContain("=== mixed.dat ===");
    });

    it("truncates an oversized jsonl-referenced file at max_file_bytes with a notice", async () => {
      writeFileSync(join(dir, "big.txt"), "A".repeat(2 * 1024 * 1024), "utf-8");
      writeJsonlEntries([{ file: "big.txt", reason: "big" }]);

      const prompt = await runImplementHook();

      expect(Buffer.byteLength(prompt, "utf-8")).toBeLessThanOrEqual(
        128 * 1024 + 4096, // total cap + slack for the prompt template/notices
      );
      expect(prompt).toContain(
        "[Trellis: truncated at 32768 bytes — read big.txt for the full content]",
      );
    });

    it("never splits a multi-byte UTF-8 sequence at the 32768-byte cut point", async () => {
      // 32767 ASCII bytes + Chinese text: the default cap lands inside the
      // first 3-byte character and must back off, not emit mojibake.
      writeFileSync(
        join(dir, "zh.md"),
        "a".repeat(32767) + "中文内容",
        "utf-8",
      );
      writeJsonlEntries([{ file: "zh.md", reason: "zh" }]);

      const prompt = await runImplementHook();

      expect(prompt).not.toContain("�");
      expect(prompt).toContain(
        "a".repeat(32767) +
          "\n[Trellis: truncated at 32768 bytes — read zh.md for the full content]",
      );
    });

    it("truncates an oversized artifact (prd.md) at max_artifact_bytes", async () => {
      writeFileSync(
        join(dir, ".trellis", "tasks", "demo-task", "prd.md"),
        "P".repeat(100000),
        "utf-8",
      );

      const prompt = await runImplementHook();

      expect(prompt).toContain("P".repeat(65536));
      expect(prompt).not.toContain("P".repeat(65537));
      expect(prompt).toContain(
        "[Trellis: truncated at 65536 bytes — read .trellis/tasks/demo-task/prd.md for the full content]",
      );
    });

    it("degrades to an index line once the total budget is exhausted (3 files)", async () => {
      writeFileSync(join(dir, "f1.txt"), "1".repeat(50), "utf-8");
      writeFileSync(join(dir, "f2.txt"), "2".repeat(50), "utf-8");
      writeFileSync(join(dir, "f3.txt"), "3".repeat(50), "utf-8");
      writeJsonlEntries([
        { file: "f1.txt", reason: "first" },
        { file: "f2.txt", reason: "second" },
        { file: "f3.txt", reason: "third" },
      ]);
      writeConfig(
        [
          "context_injection:",
          "  max_file_bytes: 0",
          "  max_artifact_bytes: 0",
          "  max_total_bytes: 120", // fits f1 fully, degrades f2/f3
        ].join("\n"),
      );

      const prompt = await runImplementHook();

      expect(prompt).toContain("=== f1.txt ===\n" + "1".repeat(50));
      expect(prompt).toContain(
        "[Trellis: not inlined (total context limit reached) — f2.txt (50 bytes): second]",
      );
      expect(prompt).toContain(
        "[Trellis: not inlined (total context limit reached) — f3.txt (50 bytes): third]",
      );
      expect(prompt).not.toContain("=== f2.txt ===");
      expect(prompt).not.toContain("=== f3.txt ===");
    });

    it("honors a max_file_bytes override from .trellis/config.yaml", async () => {
      writeFileSync(join(dir, "ref.md"), "R".repeat(100), "utf-8");
      writeJsonlEntries([{ file: "ref.md", reason: "ref" }]);
      writeConfig(["context_injection:", "  max_file_bytes: 10"].join("\n"));

      const prompt = await runImplementHook();

      expect(prompt).toContain(
        "[Trellis: truncated at 10 bytes — read ref.md for the full content]",
      );
      expect(prompt).not.toContain("R".repeat(11));
    });

    it("max_file_bytes: 0 and max_total_bytes: 0 restore fully unlimited inlining", async () => {
      const bigContent = "Z".repeat(40000); // over the 32768 default file cap
      writeFileSync(join(dir, "big.txt"), bigContent, "utf-8");
      writeJsonlEntries([{ file: "big.txt", reason: "big" }]);
      writeConfig(
        [
          "context_injection:",
          "  max_file_bytes: 0",
          "  max_total_bytes: 0",
        ].join("\n"),
      );

      const prompt = await runImplementHook();

      expect(prompt).toContain("=== big.txt ===\n" + bigContent);
      expect(prompt).not.toContain("[Trellis: truncated");
      expect(prompt).not.toContain("[Trellis: not inlined");
    });

    it("invalid config values fall back to the default cap", async () => {
      writeFileSync(join(dir, "big.txt"), "A".repeat(40000), "utf-8");
      writeJsonlEntries([{ file: "big.txt", reason: "big" }]);
      writeConfig(
        ["context_injection:", "  max_file_bytes: not-a-number"].join("\n"),
      );

      const prompt = await runImplementHook();

      expect(prompt).toContain(
        "[Trellis: truncated at 32768 bytes — read big.txt for the full content]",
      );
    });

    it("directory entries respect the per-file cap and only inline .md files", async () => {
      mkdirSync(join(dir, "refdir"), { recursive: true });
      writeFileSync(join(dir, "refdir", "a.md"), "A".repeat(1000), "utf-8");
      writeFileSync(join(dir, "refdir", "b.md"), "B".repeat(1000), "utf-8");
      writeFileSync(join(dir, "refdir", "c.txt"), "IGNORED_TXT_CONTENT", "utf-8");
      writeJsonlEntries([
        { file: "refdir/", type: "directory", reason: "reference dir" },
      ]);
      writeConfig(
        [
          "context_injection:",
          "  max_file_bytes: 10",
          "  max_total_bytes: 0",
        ].join("\n"),
      );

      const prompt = await runImplementHook();

      expect(prompt).toContain(
        "[Trellis: truncated at 10 bytes — read refdir/a.md for the full content]",
      );
      expect(prompt).toContain(
        "[Trellis: truncated at 10 bytes — read refdir/b.md for the full content]",
      );
      expect(prompt).not.toContain("IGNORED_TXT_CONTENT");
    });
  });
});

// ---------------------------------------------------------------------------
// Dogfood parity — the repo's own committed .opencode/ copies must match the
// shipped template bytes (spec: workflow-state-contract.md §6). These are the
// files the maintainers' own OpenCode loads; silent drift here means Trellis
// development runs on stale plugins while tests exercise the new ones.
// ---------------------------------------------------------------------------

describe("opencode dogfood parity", () => {
  const MANAGED_FILES = [
    ".opencode/plugins/session-start.js",
    ".opencode/plugins/inject-workflow-state.js",
    ".opencode/plugins/inject-subagent-context.js",
    ".opencode/lib/context-visibility.js",
    ".opencode/lib/session-utils.js",
    ".opencode/lib/trellis-context.js",
    ".opencode/agents/trellis-check.md",
    ".opencode/agents/trellis-implement.md",
    ".opencode/agents/trellis-research.md",
  ];

  it("collectOpenCodeTemplates ships every managed plugin/lib/agent file", () => {
    const files = collectOpenCodeTemplates();
    for (const relPath of MANAGED_FILES) {
      expect(files.has(relPath), `${relPath} missing from shipped set`).toBe(
        true,
      );
    }
    // v2 reads no .opencode/package.json — it must not come back.
    expect(files.has(".opencode/package.json")).toBe(false);
  });

  it("dogfood .opencode/ copies match the shipped template bytes", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    // packages/cli/test/templates → repo root
    const repoRoot = resolve(testDir, "../../../..");
    const files = collectOpenCodeTemplates();
    for (const relPath of MANAGED_FILES) {
      const shipped = files.get(relPath);
      if (shipped === undefined) {
        throw new Error(`${relPath} missing from collectOpenCodeTemplates()`);
      }
      const dogfood = readFileSync(join(repoRoot, relPath), "utf-8");
      expect(
        dogfood,
        `${relPath} dogfood copy drifted from the template — re-run trellis update or re-sync .opencode/`,
      ).toBe(shipped);
    }
  });
});
