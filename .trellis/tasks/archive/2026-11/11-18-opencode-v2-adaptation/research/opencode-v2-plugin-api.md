# OpenCode v2 Plugin API 研究（Trellis 迁移技术事实）

研究日期：2026-11-18。来源：OpenCode 官方文档（opencode.ai/docs）与官方源码（github.com/anomalyco/opencode，v2 分支 / v2.3.2 tag）。

## 主要来源 URL

- V1→V2 插件迁移指南：https://opencode.ai/docs/build/plugins/migrate-v1（.md 全文可读）
- V2 插件总览（Parts/Load/Publish）：https://opencode.ai/docs/build/plugins
- V2 插件配置（plugins 字段、发现、CLI 管理）：https://opencode.ai/docs/plugins
- V2 Server 插件完整 API（含全部 hook 签名）：https://opencode.ai/docs/build/plugins/server
- V1→V2 全局迁移：https://opencode.ai/docs/migrate-v1
- 源码（v2.3.2）：
  - `packages/plugin/src/promise/tool.ts`（ToolHooks 类型）
  - `packages/plugin/src/promise/session.ts`（Session hook 类型）
  - `packages/schema/src/session.ts`（Session.Info 含 parentID）

---

## 1. v2 插件入口形态

**结论：default-export 一个由 `Plugin.define({ id, setup(ctx) })` 创建的定义对象。不再是"返回 hooks 对象的 async 工厂函数"。**

官方原文（migrate-v1）：

> "V1 plugin functions return one object containing tools and hooks. A V2 plugin default-exports a definition with an `id` and `setup(ctx)`; `setup` registers hooks, transforms, tools, and subscriptions through the context."
> "V1 plugin implementations do not run in V2. Moving a file or renaming its config entry is not enough."

官方示例：

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example",
  async setup(ctx) {
    await ctx.storage.set("last-project", ctx.location.project.id)
    console.log(`Loaded for ${ctx.location.directory}`)
  },
})
```

上下文参数对照（官方原文表格，migrate-v1）：

| V1 | V2 |
| --- | --- |
| `directory` | `ctx.location.directory` |
| `project` | `ctx.location.project` |
| `client` | 按域分组的方法：`ctx.session`、`ctx.permission`、`ctx.agent` 等 |
| 插件 options 参数 | `ctx.options` |
| 返回的 `dispose()` hook | `setup` 返回的 cleanup 函数 |
| 返回的 `event` hook | `ctx.event.subscribe()` |
| 返回的 config/model/tool 修改 | 对应域的 `transform(...)` |
| `$` Bun shell helper | **移除**："import and manage the process API your plugin uses" |

注意：`ctx.location` 是"本插件实例加载的位置"，不是每个 session/event 的位置；区分 session 位置要读 session/event 数据。每个插件必须有稳定 `id`（plugin storage 和诊断都按 id 作用域）。

`setup` 可返回 cleanup 函数，插件 unload 时执行；hook/transform 注册随插件卸载自动 dispose，也可手动 `registration.dispose()`。

## 2. v2 hook 全列表及与 v1 对照

### v1 → v2 官方对照表（migrate-v1 原文）

| V1 hook | V2 API |
| --- | --- |
| `event` | `ctx.event.subscribe()` |
| `dispose` | `setup` 返回的 cleanup 函数 |
| `config` | 受影响域的 transforms |
| `tool` map | `ctx.tool.transform(...)` |
| `auth` | `ctx.integration.transform(...)` 及 integration API |
| `provider` | `ctx.provider.transform(...)` 与 `ctx.model.transform(...)` |
| `chat.message` | `ctx.session.hook("prompt", ...)` |
| `chat.params` | `ctx.session.hook("context", ...)` |
| `chat.headers` | `ctx.session.hook("model.request", ...)` 或 `"http.request"` |
| `permission.ask` | `ctx.permission.hook("evaluate", ...)` |
| `command.execute.before` | command transforms 或 prompt hook（无一一对应） |
| `tool.execute.before` | `ctx.tool.hook("execute.before", ...)` |
| `tool.execute.after` | `ctx.tool.hook("execute.after", ...)` |
| `shell.env` | `ctx.shell.hook("create.before", ...)` |
| `tool.definition` | `ctx.tool.transform(...)` |
| `experimental.chat.system.transform` | `ctx.session.hook("context", ...)` 编辑 `event.system` |
| **`experimental.chat.messages.transform`** | **`ctx.session.hook("context", ...)` 编辑 `event.messages`** |
| `experimental.session.compacting` | `ctx.session.hook("compaction", ...)` |

官方警告（原文）：

> "These are migration destinations, not always exact renames. In particular, the V2 `prompt` hook runs before durable prompt admission, while `context` runs immediately before an agent model request. Register `context`, `compaction`, `generate`, and `title` separately if a transformation must apply to every model request kind."

### v2 Session hook 完整清单（server.md 签名原文）

```ts
interface SessionHooks {
  prompt: SessionPrompt
  context: SessionContextHook
  compaction: SessionContextHook & { result?: SessionCompactionResult }
  generate: SessionContextHook
  title: SessionRequestHook & { result?: string }
  "experimental.model.resolve": SessionModelResolveHook
  "model.request": SessionModelRequestHook
  "http.request": SessionHttpRequestHook
  "http.response": SessionHttpResponseHook
  "experimental.ws.handshake": SessionWebSocketHandshakeHook
  "experimental.ws.send": SessionWebSocketSendHook
  "experimental.ws.receive": SessionWebSocketReceiveHook
  retry: SessionRetryHook
}
```

关键 hook 的 event 结构（源码 v2.3.2 `packages/plugin/src/promise/session.ts`）：

```ts
export interface SessionPrompt {
  readonly sessionID: Session.ID
  readonly messageID: SessionMessage.ID
  prompt: Types.DeepMutable<PromptInput.Prompt>   // text / files / agents / skills 可变
  metadata?: Record<string, unknown>
  delivery: SessionInbox.Delivery                 // "steer" 默认，可改 "queue"
}

export interface SessionRequest {
  readonly sessionID: Session.ID
  readonly model: Model.Ref
  system: Array<SystemPart>                       // 可变，官方示例 event.system.push(...)
  messages: Array<SessionRequestMessage>          // 可变（v1 messages.transform 对应物）
  options: SessionRequestOptions                  // temperature/maxTokens 等 + provider 选项
}

export interface SessionContext extends SessionRequest {
  readonly agent: Agent.ID                        // ← context hook 直接给出 agent
  tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>  // 可变，可 delete
}
```

`context` hook 行为（server.md 原文）：

> "`context` runs for the agent loop, including tool-driven continuations." … "Changes affect only the outgoing model call, not persisted history or configuration." —— **与 v1 `experimental.chat.messages.transform` "只改发给模型的副本、不动 TUI/SQLite 历史" 语义一致**（Trellis session-start 依赖的正是这个语义，见 #553）。

消息还携带只读 `metadata`（不发给模型）。`system` 指令 part 在 `metadata.experimental.instructions` 里以 `{ key, text }` 列出各来源（如 `core/date`），便于识别；该列表是副本，编辑 text 不会同步它（experimental）。

### Tool hook（v2.3.2 `packages/plugin/src/promise/tool.ts` 原文）

```ts
interface ToolHooks {
  readonly "execute.before": {
    tool: string                                 // 可变（可改输入）
    readonly sessionID: Session.ID
    readonly agent: Agent.ID                     // ← v1 没有，v2 直接给出
    readonly messageID: SessionMessage.ID
    readonly id: Tool.CallID
    input: unknown                               // 可变（event.input 即 v1 output.args）
  }
  readonly "execute.after": { readonly tool; readonly sessionID; readonly agent;
    readonly messageID; readonly id; readonly input } & (
    | { readonly status: "completed"; result: Tool.Result }   // result 可变
    | { readonly status: "error"; error: Tool.Error })
}
```

官方示例（migrate-v1）：`event.tool === "read"`、`const input = event.input as { filePath?: string }`、throw Error 可阻断执行。

### Shell hook（v1 `shell.env` 对应物，server.md 原文）

```ts
interface ShellHookContext {
  hook(name: "create.before", callback: (event: ShellCreateBefore) => Promise<void> | void): Promise<Registration>
}
interface ShellCreateBefore {
  command: string
  cwd: string
  timeout: number
  shell: string
  env: Record<string, string | undefined>   // 可变：event.env.COMPANY_ENV = "development"
}
```

### 其他 hook 域

- `ctx.permission.hook("evaluate", event)` — event 含 `sessionID`、`agent?`、`action`、`resources`、`effect`（可改 allow/ask/deny）。
- `ctx.event.subscribe({ signal })` — async iterator 订阅事件流（替代 v1 `event` hook），事件如 `session.idle`。

## 3. input/output 结构变化

**v2 改为单参可变 event 对象，mutation 仍是官方指定用法。** 官方原文（migrate-v1）：

> "The callback receives one mutable event instead of separate `input` and `output` objects."

- v1 `tool.execute.before(input, output)` → v2 `(event)`：`event.tool` / `event.input`（= v1 `output.args`）。
- v1 `experimental.chat.messages.transform(input, output)` mutate `output.messages` → v2 `context` hook mutate `event.messages` / `event.system` / `event.options` / `event.tools`。
- v1 `shell.env(input, output)` mutate `output.env` → v2 `shell create.before` mutate `event.env`。
- 多插件同 hook 按插件顺序执行，后者可见前者改动（"Hooks run in registration order and see overrides made by earlier hooks"）。

## 4. 插件加载机制

- **`.opencode/plugins/` 自动发现保留**（docs/plugins "Discover"）：加载每个 `.opencode/plugins/` 下的**直接 `.ts`/`.js` 文件**和**直接子目录（插件包目录）**。注意：单个散文件（如 `concise.ts`）直接作为插件加载；带子目录/多文件的插件应放成"插件目录"。全局目录为 `~/.config/opencode/plugins/`。
- **config 字段 `plugin` → `plugins`**（数组，merge 而非覆盖；支持 `-id` 禁用、通配）。本地路径必须是**目录**："Configured local paths must be directories. A path to a single file is skipped."（migrate-v1）options 元组改为 `{ "package": "./plugin/local", "options": {...} }`。
- **本地插件目录内的模块组织**（docs/build/plugins "Load"）：有 `package.json`（含 `name`/`exports`）时按 exports 加载各 part（`.`/`./server`、`./tui`、`./rpc`、`./gui-experimental.cjs`）；没有时按根目录文件名 `server`（否则 `index`）、`tui`、`rpc`（`.ts`/`.tsx`/`.js`）。**`lib/` 这类支撑模块可放在插件旁边**（"Keep supporting modules beside the plugin when moving it"）。Trellis 当前的 `.opencode/plugins/*.js + .opencode/lib/*` 布局需重组：每个插件变成一个目录（如 `.opencode/plugins/trellis-session-start/index.js`）引用相邻 lib，或合并成单文件插件。
- **`.opencode/package.json` + node_modules 本地依赖**：v2 文档不再提及 `.opencode/package.json` 模式；新契约是插件 package 依赖 `@opencode/plugin`。本地目录带 package.json 是被支持的加载形式，但 v1 的"@opencode-ai/plugin 装在 .opencode/package.json"模式没有官方继承说明，迁移时应验证（[INFERENCE]：本地 .js 插件不用 import 类型也能跑，v2 示例均 import `@opencode/plugin` 仅为类型/define helper；运行时注入的是 ctx）。
- **运行时**：v2 移除了注入的 Bun `$` helper（"import and manage the process API your plugin uses"），文档未承诺插件在 Bun 下运行；插件代码应只用 Node 兼容 API（Trellis 现有代码用 `fs`/`path`，安全）。`.ts` 文件可被直接加载，说明有内置 TS 转译。
- **热重载**：受监视 config 目录下的改动自动 reload；`opencode plugin add/list/check/update/remove` CLI 管理全局包插件。

## 5. npm 包名与版本

- v2 包名：**`@opencode/plugin`**（v1 为 `@opencode-ai/plugin`）。官方原文："Change the package import… Published plugins should depend on a version of `@opencode/plugin` compatible with the OpenCode release they target."
- 版本线：npm 上 `@opencode/plugin` 最新 **2.3.2**（2.x 系列：2.0.x → 2.3.2，截至 2026-11-18）。
- 类型导出：`import { Plugin } from "@opencode/plugin"`；`Plugin.define({ id, setup })`；细粒度类型在 `@opencode/plugin/promise/session` 等子路径（如 `import type { SessionPrompt } from "@opencode/plugin/promise/session"`）。另有 Effect API 入口（`effect()`）与 `@opencode/plugin/tui`、`@opencode/plugin/gui` 分 part SDK。

## 6. 子 agent（subagent）识别

v2 比 v1 更直接：

- **Session hook event 自带 `agent` 字段**：`context`/`compaction`/`generate` hook event 有 `readonly agent: Agent.ID`；`model.request`、http/ws、retry hook event 也都有 `sessionID` + `agent` + `kind`。
- **Tool hook event 自带 `agent` + `sessionID`**（见 §2 ToolHooks）。v1 需要从 `platformInput.agent` 猜的，v2 直接给。
- **Session 父子关系**：`Session.Info` 有可选 `parentID`（源码 `packages/schema/src/session.ts`：`parentID: ID.pipe(optional)`）。插件内可用 `ctx.session.get({ sessionID })` 读取，判断当前 session 是否为 subagent session（parentID 存在即为子 session）——与 v1 的 parentID 方案等价。
- 辅助请求（compaction/title/generate）通过 `kind` 字段区分，官方明确说 "Use it instead of the agent ID to tell auxiliary requests apart."

## 7. Server API client 访问

**v2 的 ctx 本身就是 server client**（server.md 原文）：

> "The plugin context is essentially an OpenCode server client. Its read and action methods use the same inputs and responses as the client."

即不再需要单独 `@opencode-ai/sdk`；域方法包括 `ctx.session`（create/get/list/context/prompt/generate/command/synthetic/compact/interrupt/wait/instructions.entry）、`ctx.agent`、`ctx.model`、`ctx.provider`、`ctx.skill`、`ctx.storage`（插件作用域持久 JSON）、`ctx.vcs`、`ctx.mcp`、`ctx.command`、`ctx.event.subscribe` 等。对 Trellis 的 mem/session 读取：`ctx.session.context({ sessionID })` 可直接拉消息列表，`ctx.session.list` 支持按 directory 过滤分页，`ctx.storage` 可替代自造的插件状态文件。

## 8. 兼容双版本（可选策略）

官方支持单包同时服务 v1/v2：default export 一个对象，spread `Plugin.define({...})`（v2 读 `id`/`setup`）再加一个 `server()` 函数（v1 调用，v1 ≥ 1.18.29 支持对象入口）。官方建议 support window 结束后删除 v1 实现。

---

## 9. Trellis 三个插件迁移可行性判断

### 9.1 session-start.js（消息注入，`experimental.chat.messages.transform`）→ **可行，直接对应**

- 对应物：`ctx.session.hook("context", (event) => ...)`，mutate `event.messages`。
- 语义保持：v2 官方明确 "Changes affect only the outgoing model call, not persisted history or configuration"——Trellis 依赖的"不改 TUI/SQLite 历史"（#553）成立。
- 注意点：
  1. `context` 只在 agent loop（primary）跑；compaction/title/generate 是独立 hook。session-start 注入只需 `context`，但需确认 workflow-state 注入是否也要覆盖 compaction 后的首请求（通常不需要）。
  2. v1 用 `platformInputFromMessages(messages)` 提取 agent 判断 subagent；v2 直接用 `event.agent` + `ctx.session.get({sessionID}).parentID`，`platformInputFromMessages` hack 可删。
  3. "只在首个用户消息注入"的逻辑（transcriptHasAssistantMessage 判断）可直接在 `event.messages` 上实现。
  4. system 注入应改用 `event.system.push({type:"text",text})`，而非塞进 messages。

### 9.2 inject-workflow-state.js（消息注入）→ **可行，同 9.1**

- 同样迁移到 `ctx.session.hook("context", ...)`，mutate `event.messages`/`event.system`。
- 若需要每次模型请求都注入（而非仅首轮），`context` hook 每次 agent-loop 请求都触发，天然满足；注意去重逻辑（v1 靠 prepend 到最新 user message 的副本，v2 同样可操作）。

### 9.3 inject-subagent-context.js（`tool.execute.before` 拦截 Task 工具）→ **可行，且更干净**

- 对应物：`ctx.tool.hook("execute.before", (event) => { if (event.tool === "task" ...) })`，`event.input` 可变（v1 的 `output.args`），`event.agent`/`event.sessionID` 直接可用。
- 阻断可用 throw（官方示例）。向 subagent dispatch prompt 注入上下文：mutate `event.input` 中 Task 工具的 prompt 字段即可。
- 若 Trellis 还依赖 v1 `shell.env` 向 bash 命令注入环境变量（见 08-05-opencode-shell-env 相关任务）：对应物是 `ctx.shell.hook("create.before", (event) => { event.env.X = ... })`，event 含 command/cwd/timeout/shell/env 全可变。

### 9.4 结构性工作

- 三个插件各自改为 `export default Plugin.define({ id: "trellis.xxx", async setup(ctx) {...} })`；共享 lib（trellis-context.js / context-visibility.js / session-utils.js）保留在插件目录旁。
- 目录布局：`.opencode/plugins/*.js` 散文件自动发现在 v2 保留，但带共享 lib 的多文件形态应改为每插件一目录（`.opencode/plugins/trellis-session-start/index.js` + 共享 `.opencode/lib/` 通过相对路径 import——需验证相对 lib 是否在自动发现时被视为插件文件；`lib/` 下的 .js 文件位于 plugins/ 之外则不会被当作插件，安全）。
- `.opencode/package.json` 的 `@opencode-ai/plugin@^1.14.39` 依赖需替换为 `@opencode/plugin@^2`（若保留 package.json 模式）或直接不 import（define 可用字面量对象模拟，但官方建议用 `Plugin.define` 做类型检查）。
- `trellis init --opencode` 模板与 `.trellis/.template-hashes.json` 需整体换版；可同时发 v1/v2 双实现（官方 support-V1 模式）做过渡。

## 10. 未决/需验证项

1. v2 对无 package.json 的本地 `.js` 插件目录的 ESM/CJS 要求（文档示例全为 `.ts`/ESM）。
2. `.opencode/package.json` node_modules 模式是否仍被 v2 加载器使用（文档未提；v2 推荐 `plugins` 配置或自动发现）。
3. `event.messages` 中各 part 的结构（SystemPart/Message 来自 `@opencode/ai/effect`），prepend 文本时应构造的 part 形状需按源码 `packages/ai` 确认。
4. v2 最低版本线：哪个 2.x 起 hook API 稳定（研究基于 2.3.2 源码与当前文档）。
