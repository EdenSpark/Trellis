# OpenCode v2 Session 存储架构研究

> 研究日期: 2026-11-18
> 主要来源: `github.com/anomalyco/opencode`（原 sst/opencode）`dev` 分支，commit `a0fdbf9b91ed2cf8bfd778ccec340285403eddc2`（2026-11-17），已浅克隆至本地核对源码。
> 目的: 为 Trellis `trellis mem` 的 `packages/core/src/mem/adapters/opencode.ts` 适配器重建提供事实基础。

---

## 0. TL;DR

- **v2 仍是单个 SQLite 数据库**，路径 `~/.local/share/opencode/opencode.db`（`$XDG_DATA_HOME/opencode/opencode.db`），不是 JSON 文件目录，也不是纯内存。
- **v2 换了新表**：`session_v2` / `session_message` / `session_part`（另有 `project`、`session_inbox`、`kv`、`blob`、`instruction_*` 等）。v1 的旧表 `session` / `message` / `part` **不会被删除**，迁移后共存于同一个 db 文件中。
- **消息模型完全变了**：v1 的 `message.data.role` (user/assistant) + `part.data.type` (text/reasoning/tool/step-start/step-finish) 被替换为 `session_message.type` 判别联合（user/assistant/system/synthetic/skill/shell/compaction/idle/agent-switched/...），assistant 的文本在 `data.content[]` 数组里。
- **多 project 不再是 db 内 project 表按行隔离**——v2 有 `project` 表，`session_v2.project_id` 外键引用；所有 project 的会话仍在同一个 db 文件。
- **server API 可用**：`GET /api/session`、`GET /api/session/:sessionID`、`GET /api/session/:sessionID/message`（HTTP，effect HttpApi 定义在 `packages/protocol`）。但 server 需要运行；mem 的离线检索场景更适合直接只读 SQLite。
- **版本探测**：查 `sqlite_master`——有 `session_v2` 表即 v2 库；只有 `session/message/part` 无 `session_v2` 即 v1 库；`session_v2` 与 `kv` 中迁移状态 key `migration.v1-v2` 可判断是否已完成迁移。

---

## 1. 存储位置（v2）

源码: `packages/util/src/global-roots.ts`、`packages/util/src/global.ts`、`packages/cli/src/database-path.ts`

- 数据根目录: `$XDG_DATA_HOME/opencode`，无 `XDG_DATA_HOME` 时为 `~/.local/share/opencode`（所有平台一致，无 macOS 分支）。
- 数据库文件名由 `packages/cli/src/database-path.ts` 的 `databasePath(data)` 决定:
  - `OPENCODE_DB` 环境变量优先（可为 `:memory:`）；
  - release channel ∈ `{latest, dev, beta, next, prod}` 或 `OPENCODE_DISABLE_CHANNEL_DB=1` 时固定为 **`opencode.db`**；
  - 其他 channel（如 nightly）为 `opencode-<channel>.db`（channel 名经 `[^a-zA-Z0-9._-]` → `-` 清洗）。
- 文件权限 0600（`restrictToOwner`，`packages/core/src/database/database.ts`），WAL 模式（`PRAGMA journal_mode = WAL`，`busy_timeout = 5000`）。**读取方要处理 `-wal` / `-shm` sidecar**：只读打开建议使用 SQLite 只读 URI + `immutable=0`，不要忽略 WAL（最近会话可能只在 WAL 里）。
- SDK 内嵌场景（`packages/sdk/src/internal/host.ts`）默认 `database.path = ":memory:"`——即 SDK embedder 默认不写盘；CLI/TUI/desktop 走 `server-process.ts` 传入真实路径。

## 2. v1 对照（Trellis 现状）

Trellis 现有适配器（`packages/core/src/mem/adapters/opencode.ts`）读的是 **v1 格式**：

- 路径: `~/.local/share/opencode/opencode.db`（同一路径！v1/v2 不通过文件名区分）。
- 表: `session`（列含 `id`, `directory`（早期拼写 `cwd`）, `title`, `time_created`, `time_updated`...）、`message`（`id`, `session_id`, `time_created`, `data` JSON，`data.role` = `"user"|"assistant"`）、`part`（`id`, `message_id`, `session_id`, `time_created`, `data` JSON，`data.type` = `"text"|"reasoning"|"tool"|"step-start"|"step-finish"|"compaction"...`，文本在 `data.text`）。
- v1 的 message/part ID 前缀为 `msg_` / `prt_`，session ID 前缀 `ses_`（v2 沿用，见 §4）。

更老的 pre-1.0（v0.x）曾用 JSON 文件目录 `~/.local/share/opencode/storage/session/<projectID>/<sessionID>.json` + `storage/session/message/*/*.json`（来源: 旧版 `packages/opencode/src/storage/storage.ts` 迁移代码，如 damianh 镜像 fork 中可见 Glob `storage/session/message/*/*.json`）。v1 已将其迁入 SQLite。**mem 适配器不需要支持 v0 JSON 目录**（v1 自己已迁移掉），但版本探测时应识别后跳过。

另有一个中间产物 **`opencode-next.db`**：v2 开发期的 "next" channel 数据库，含 `project` / `session` / `session_message` 表（注意 `session` 列布局与 v1 不同，且**没有** `message`/`part` 表）。v2 正式版的 `v1-migration.bun.ts` 会把它也导入新 schema（`isNextDatabase()`: 同时有 `project`+`session`+`session_message` 表）。用户机器上可能存在此文件。

## 3. v2 Schema（完整字段表）

来源: `packages/core/src/session/sql.ts`（drizzle 定义）、`packages/core/src/project/sql.ts`、`packages/core/src/database/schema.sql.ts`（`Timestamps` = `time_created` INTEGER NOT NULL + `time_updated` INTEGER NOT NULL，均为 **epoch 毫秒**）。

### 3.1 `session_v2`（主键 `id`）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | text PK | `ses_` + 26 字符 descending ID（见 §4） |
| `project_id` | text NOT NULL FK→`project.id` ON DELETE CASCADE | 所属 project；孤儿会话归 `"global"` |
| `workspace_id` | text NULL | `wrk_` 前缀 workspace ID |
| `parent_id` | text NULL | **父会话 ID —— subagent/子会话标识**（见 §5） |
| `fork_session_id`, `fork_boundary` | text NULL / JSON NULL | fork 来源 |
| `slug` | text NOT NULL | URL 友好短名 |
| `directory` | text NOT NULL | 会话工作目录（绝对路径） |
| `path` | text NULL | project 内相对路径 |
| `title` | text NULL | |
| `version` | text NOT NULL | opencode 版本字符串 |
| `share_url` | text NULL | |
| `summary_additions/deletions/files/diffs` | int/int/int/JSON NULL | diff 统计 |
| `metadata` | JSON text NULL | |
| `cost` | real NOT NULL default 0 | USD |
| `tokens_input/output/reasoning/cache_read/cache_write` | int NOT NULL default 0 | |
| `revert`, `permission`, `model` | JSON text NULL | model = `{id, providerID, variant?}` |
| `agent` | text NULL | 当前 agent ID |
| `time_created`, `time_updated` | int NOT NULL | epoch ms |
| `time_busy`, `time_idle`, `time_viewed`, `time_compacting`, `time_archived`, `time_suspended` | int NULL | 生命周期时间戳；`time_archived` 非空=已归档 |
| `idle_outcome` | text NULL | `"succeeded"|"failed"|"interrupted"` |
| `resume_attempts` | int NOT NULL default 0 | |

索引: `session_v2_project_idx(project_id)`, `session_v2_workspace_idx`, `session_v2_parent_idx(parent_id)`, `session_v2_time_suspended_idx`。

**注意：v1 的 `session` 表在迁移后保留原样**（迁移注释 "leave the original V1 row intact"），新数据只写 `session_v2`。

### 3.2 `session_message`（主键 `id`）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | text PK | `msg_` 前缀 ascending ID |
| `session_id` | text NOT NULL FK→`session_v2.id` CASCADE | |
| `type` | text NOT NULL | 判别联合 tag，见下 |
| `seq` | int NOT NULL | 会话内单调序号；`(session_id, seq)` 有 **unique index** —— 排序用 `seq`，比 v1 的 time_created 更可靠 |
| `time_created`, `time_updated` | int NOT NULL | epoch ms |
| `data` | JSON text NOT NULL | 去掉 `type`/`id` 后的消息体 |

`type` 取值与 `data` 内容（`packages/schema/src/session-message.ts`）：

| type | data 关键字段 | 对话文本位置 |
|---|---|---|
| `user` | `text`, `files`, `agents`, `skills` | **`data.text` 直接是用户输入** |
| `assistant` | `agent`, `model`, `content[]`, `finish`, `cost`, `tokens`, `error`, `time{created,firstToken,streamed,completed}` | **`data.content[]` 数组**，元素为 `{type:"text",text}` / `{type:"reasoning",text}` / `{type:"tool",id,name,state{status,input,content,error}}` |
| `system` | `text`, `description?` | `data.text`（指令更新等模型可见系统消息） |
| `synthetic` | `text`, `description?` | `data.text`（注入的合成输入） |
| `compaction` | `status`("running"/"completed"/"failed"), `reason`("auto"/"manual"), `summary`, `error?` | `data.summary` 是压缩摘要 |
| `shell` | `shellID`, `command`, `status`, `exit?`, `output?` | 命令在 `data.command` |
| `skill` | `skill`, `name`, `text` | `data.text` |
| `idle` | `outcome`("succeeded"/"failed"/"interrupted"), `error?` | 无文本；turn 边界标记 |
| `agent-switched` / `model-switched` / `location-switched` | agent/model/location 变更事件 | 无对话文本 |

### 3.3 `session_part`（复合主键 `(message_id, ordinal)`）

| 列 | 类型 | 说明 |
|---|---|---|
| `message_id`, `session_id` | text NOT NULL FK CASCADE | |
| `ordinal` | int NOT NULL | part 在消息内的序号 |
| `type` | text NOT NULL | assistant content 的 type（`text`/`reasoning`/`tool`） |
| `call_id` | text NULL | tool call ID |
| `data` | JSON text NOT NULL | 单个 AssistantContent 元素 |

`session_part` 是 assistant `content[]` 的**按行展开**（供索引/查询）；读对话文本时直接用 `session_message.data.content` 更省事，`session_part` 可作交叉校验。user 消息没有 part 行。

### 3.4 其他相关表

- `project`（`id` text PK, `worktree` 绝对路径 NOT NULL, `vcs`, `name`, `time_active`, ...）——多 project 就靠它 join。
- `session_inbox`（待投递输入，含未消费的 steer/queue 项；mem 一般可忽略）。
- `kv`（`key` PK, `value` JSON）——迁移状态等元数据。
- `migration`（`id` PK, `time_completed`）——schema migration 记录（drizzle 风格，替代旧 `__drizzle_migrations`）。
- `blob` / `blob_ref`（图片等二进制）、`instruction_entry` / `instruction_blob` / `instruction_state`。

## 4. ID 规则

来源: `packages/schema/src/identifier.ts`、`session-id.ts`、`workspace-id.ts`、`session-message.ts`

- 26 字符：12 个 hex 字符时间戳（毫秒×0x1000+计数器，descending 取反）+ 14 个 base62 随机字符。**ID 本身编码时间，可按字典序排时间**（ascending 型）。
- 前缀: session `ses_`（**descending**，新会话字典序更小）、message `msg_`（ascending）、workspace `wrk_`。part 在 v2 无独立全局 ID（`(message_id, ordinal)` 复合键）。v1 的 part ID 前缀 `prt_` 在 v2 消失。
- Project ID 无固定前缀；保留值 `"global"` 表示无 project 归属。

## 5. Subagent 识别

- **session 级**: `session_v2.parent_id` 非空即子会话（subagent / sidechain）。官方 list API 支持 `parentID` 过滤，`null` 表示只要 root 会话（`packages/schema/src/session.ts` ListFilter）。索引 `session_v2_parent_idx` 存在。
- v1 同理：`session` 表也有 parent 信息（v1 迁移代码读 `parent_id` 列）。
- 建议: mem 列表默认 `WHERE parent_id IS NULL`，子会话可作为父会话的附属内容按需展开。
- 消息级: assistant 消息的 `data.agent` 字段记录产生该消息的 agent ID（如 build/plan/subagent 名），可辅助标注。

## 6. 多 Project 隔离

- v2: 单库多 project。`project` 表一行一个 project（`worktree` 为 canonical 绝对路径），`session_v2.project_id` 外键 + `directory`/`path` 冗余。按目录过滤 = `session_v2.directory = ?` 或 join `project.worktree`。
- v1: 同样有库内 `project` 表 + `session.directory` 列（Trellis 现适配器用的就是 `directory`/`cwd`）。
- 都不是"按 project hash 分目录"的文件存储；v0 的 JSON 目录时代才是。

## 7. 版本探测（给定数据目录判断 v1/v2/迁移态）

按优先级（全部可通过只读 SQLite + 文件系统完成，无需启动 server）：

1. **文件级**: `<data>/opencode.db` 存在 → SQLite 时代；只有 `storage/session/**/*.json` 目录 → v0 文件时代（跳过或走旧逻辑）。`opencode-next.db` 存在 → v2 beta "next" 残留，可作补充数据源（表: `project`/`session`/`session_message`/`session_part`）。
2. **表级**（`SELECT name FROM sqlite_master WHERE type='table'`）：
   - 有 `session_v2` → **v2**。新数据在 `session_v2`/`session_message`/`session_part`；v1 旧表可能仍在但不再写入新会话。
   - 无 `session_v2` 但有 `session`+`message`+`part` → **v1**（Trellis 现适配器适用）。
   - 官方判据参考 `isNextDatabase()`（v1-migration.bun.ts:936）：`project`+`session`+`session_message` 三者并存 = next 库。
3. **迁移状态**: v2 库中 `SELECT value FROM kv WHERE key='migration.v1-v2'`（`MIGRATION_STATE_KEY`）→ `{"phase":"completed"}` 表示 v1→v2 导入完成；`{"phase":"sessions","cursor":...}` 表示进行中（v1 表可能还有未迁入数据，**此时两套现表都要读**或等迁移完成）。
4. **schema 版本**: `migration` 表（v2 新建）记录已应用的 TS migration ID（如 `20260323234822_events`）；无版本标记文件。

## 8. Server API 作为替代读取途径

来源: `packages/protocol/src/groups/session.ts`、`groups/message.ts`、`packages/server/src/routes.ts`

- `GET /api/session` — 列表，query: `order`, `search`, `parentID`(含 `"null"`), `archived`, `directory`, `project`, cursor 分页。
- `GET /api/session/:sessionID` — 单个会话详情。
- `GET /api/session/:sessionID/message` — 消息时间线，返回 `{data: PublicSessionMessage[], cursor}`，支持 type 过滤、双向分页。
- `GET /api/session/active`、`/api/experimental/session/stats`、`/api/experimental/session/:id/export` 等。
- **限制**: server 必须正在运行；默认只服务**本机当前进程持有的数据库**；没有"离线挂一个 db 文件起 server"的官方轻量路径。`@opencode-ai/sdk`（`packages/sdk`）默认 `:memory:` 数据库，是 embedder 工具，不是读取既有用户历史的通道。

## 9. 对 mem 适配器重建的建议

**推荐: 直接只读 SQLite，server API 作为可选增强（不依赖）。** 理由：mem 的核心场景是离线检索历史会话，用户机器上 opencode server 通常没在跑；SQLite 只读打开（`mode=ro`，注意 WAL）与 v1 适配器路径一致，风险最低。

重建要点：

1. **双 schema 读取**: 打开 db 后先探测（§7）。v2 库读 `session_v2`/`session_message`（按 `seq` 排序）；若 kv 显示迁移未完成，同时回退读 v1 `session`/`message`/`part` 补差集（按 id 去重）。v1 库保持现有逻辑。
2. **turn 抽取规则（v2）**:
   - `type='user'` → user turn，文本 `data.text`；
   - `type='assistant'` → assistant turn，文本 = `data.content[]` 中 `type='text'` 元素的 `text` 拼接；跳过 `reasoning`/`tool`；
   - `type='compaction'` 且 `status='completed'` → 摘要（`data.summary`），按现有 compactSummary 逻辑等价处理；
   - `system`/`synthetic`/`skill`/`shell`/`idle`/`*-switched` 不进对话流（或仅作元数据）。
3. **project 过滤**: 用 `session_v2.directory`（保持与现适配器 `MemFilter` 的目录语义一致），必要时 join `project`。
4. **subagent**: 默认 `parent_id IS NULL`；后续可把子会话挂在父会话下。
5. **排序/分页**: 用 `(session_id, seq)`（有唯一索引），不再依赖 time_created + 扫描序号 tie-break。
6. **锁定/权限**: 文件 0600 属于属主，读没问题；WAL 模式下只读连接需要 `-shm`/`-wal` 可读（同目录权限，通常 OK）。不要以写模式打开，避免触发 opencode 的 bootstrap/migration 互斥锁。
7. 不要走 `OPENCODE_DB` 之外的 channel 文件名猜测：默认 `opencode.db` 即可覆盖 latest/beta/prod；可顺带检查 `opencode-next.db` 与 `opencode-<channel>.db` 是否存在作补充。

## 附：来源清单

| 事实 | 来源（均在 commit a0fdbf9b，dev 分支） |
|---|---|
| 数据目录 XDG | `packages/util/src/global-roots.ts`, `global.ts` |
| db 文件名/channel | `packages/cli/src/database-path.ts`, `packages/cli/src/server-process.ts` |
| v2 表结构 | `packages/core/src/session/sql.ts`, `packages/core/src/project/sql.ts`, `packages/core/src/database/schema.sql.ts` |
| 消息模型 | `packages/schema/src/session-message.ts`, `packages/schema/src/session.ts` |
| ID 规则 | `packages/schema/src/identifier.ts`, `session-id.ts`, `session-message.ts` |
| v1→v2 迁移、isNextDatabase、kv key、opencode-next.db | `packages/core/src/database/v1-migration.bun.ts` |
| schema migration 表 | `packages/core/src/database/migration.ts` |
| HTTP API | `packages/protocol/src/groups/session.ts`, `groups/message.ts` |
| SDK 内存默认 | `packages/sdk/src/internal/host.ts` |
| v1 现状（Trellis 侧） | 本仓库 `packages/core/src/mem/adapters/opencode.ts` |
