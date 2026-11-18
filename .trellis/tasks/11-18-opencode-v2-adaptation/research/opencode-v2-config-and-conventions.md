# OpenCode v2 配置与文件约定（Trellis 适配盲点补齐）

研究日期：2026-11-18。来源：官方文档 + v2 源码（sst/opencode monorepo，dev 分支 `a0fdbf9`，2026-11 克隆至 /tmp 分析）。

## 1. v2 agent 文件 frontmatter 完整字段集

### 1.1 字段清单（Markdown frontmatter 与 JSON `agents.<id>` 相同）

| 字段 | 说明 | v1 对应 |
|---|---|---|
| `description` | 用途描述（subagent 必填，模型据此选择） | 同名 |
| `mode` | **`primary` / `subagent` / `all`，v2 原生保留！** 新自定义 agent 缺省为 `primary` | 同名（v1 仅 primary/subagent） |
| `model` | `provider/model` 或 `provider/model#variant`（variant 并入 model 字符串） | `model` + 独立 `variant` |
| `system` | 系统提示（JSON 配置用；Markdown 文件正文即 system，不要用此字段） | `prompt` |
| `permissions` | **有序规则数组**（见 1.2） | `permission` map |
| `steps` | 最大模型步数 | `maxSteps` |
| `hidden` | 从列表/交互发现/subagent 目录中隐藏 | 同名 |
| `color` | UI 颜色，6 位 hex | 同名（v2 自动给非 # 开头值补 `#aaaaaa`） |
| `disabled` | 移除内置或自定义 agent | `disable` |
| `request` | per-agent headers/body 覆盖（**warning：v2 session runner 保留但尚未发送**，不要依赖 temperature 等） | v1 顶层 `temperature`/`top_p`/`options` |

明确禁止在新 v2 agent 配置中使用的 v1 遗留顶层字段：`temperature`、`top_p`、`prompt`、`permission`、`tools`、`disable`、`maxSteps`。

**结论：`mode: subagent` 在 v2 中完全保留，无需改成 `hidden` 或其他字段。** Trellis 三个 agent 的 `mode: subagent` 不用动。

### 1.2 v1 `permission` map → v2 `permissions` 数组的自动转换（源码实证）

源码：`packages/core/src/v1/config/migrate.ts` 的 `permissions()` + `normalizeAction()`，以及 `packages/core/src/v1/config/permission.ts`。

转换规则：

1. v1 map 的**每个 key 变成 v2 rule 的 `action`**，经过 `normalizeAction` 重命名：
   - `write` → `edit`
   - `patch` / `apply_patch` → `edit`
   - `task` → `subagent`
   - `bash` → `shell`
   - **其他 key 原样保留**（`read`/`glob`/`grep`/`edit` 等不变）
2. value 为标量（`allow`/`ask`/`deny`）→ `{ action, resource: "*", effect: <value> }`
3. value 为对象（`{ "git push *": "ask" }`）→ 逐条展开为 `{ action, resource: <pattern>, effect: <value> }`
4. 规则数组有序，**后匹配者胜**；全局 `permissions` 在前，agent 规则追加在后。

### 1.3 ⚠️ 关键盲点：`mcp__exa__*` 这类 key 自动转换后是死规则

- v2 内置工具的 action 集合：`read / edit / glob / grep / shell / subagent / skill / question / webfetch / websearch / experimental_image_generate / external_directory`。
- **v2 MCP 工具的 action 命名是 `<server>_<tool>`（无 `mcp__` 前缀）**。源码：`packages/core/src/tool/mcp.ts` + `packages/core/src/tool/runtime.ts` 的 `effectiveName` = `${sanitizedServer}_${sanitizedTool}`（`.` 替换为 `_`，不支持字符变 `_`）。例如 exa 服务器的 `web_search` 工具 → action `exa_web_search`，resource 为 `*`。
- `normalizeAction` **不处理 `mcp__` 前缀**。Trellis 模板里的 `mcp__exa__*: allow` 会被原样转成 `{action: "mcp__exa__*", resource: "*", effect: allow}`，而 v2 匹配是整值通配，`mcp__exa__*` 永远匹配不到 `exa_web_search` → **该规则静默失效**。
- 缓解因素：v2 基础策略是 `* : * : allow`（外加 `.env` 文件 ask），所以失效的 allow 规则**不会造成功能故障**，但规则本身失去意义，且未来若收紧默认策略会出问题。
- 正确 v2 写法：`{ action: "exa_*", resource: "*", effect: "allow" }`（action 支持通配符）。

### 1.4 v1/v2 混用判定（文件级）

源码/文档一致：一个 agent 文件只要出现 `permissions` / `request` / `system` / `disabled` 任一字段即按 v2 读取，文件里的 v1 字段（`name`、`tools`、`permission`、`temperature` 等）被忽略并记 warning。**必须整文件一次性转换，禁止混用。**

### 1.5 v1→v2 agent frontmatter 对照表

| v1 | v2 | 备注 |
|---|---|---|
| `mode: subagent` | `mode: subagent` | **不变**（v2 新增 `all`） |
| `permission: {read: allow}` | `permissions: [{action: read, resource: "*", effect: allow}]` | 标量 → resource `*` |
| `permission: {bash: ...}` | action `shell` | |
| `permission: {write/patch: ...}` | action `edit` | |
| `permission: {task: ...}` | action `subagent` | |
| `permission: {mcp__exa__*: allow}` | ❌ 死规则 | 改为 `{action: "exa_*", resource: "*", effect: allow}` |
| `prompt` | 正文（Markdown）/ `system`（JSON） | |
| `disable` | `disabled` | |
| `maxSteps` | `steps` | |
| `model` + `variant: high` | `model: provider/model#high` | |
| `temperature`/`top_p`/`options` | 废弃（request.body 保留但不发送） | 配置到 model variant |

## 2. v2 命令文件 frontmatter

官方 commands 文档字段表（Markdown frontmatter 与 JSON `commands` 相同，Markdown 的 template 取自正文）：

| 字段 | v2 状态 |
|---|---|
| `template` | 仅 JSON 必填；Markdown 禁止放 frontmatter |
| `description` | 保留 |
| `agent` | 保留 |
| `model` | 保留，格式 `provider/model` 或 `provider/model#variant` |
| `subagent` | **v2 原生名**，`true`=后台子会话 |
| `subtask` | **deprecated alias**，仍被接受；两者同时出现时 `subagent` 胜出 |
| `variant`（独立字段） | v1 遗留，应并入 `model#variant` |

Trellis 现状：`packages/cli/src/templates/common/commands/*.md`（start/continue/finish-work）**没有任何 frontmatter**，纯 Markdown 正文。→ 完全兼容，不用改。

## 3. v2 本地插件的依赖解析（`.opencode/package.json` 还有效吗？）

**结论：v2 不再为 `.opencode/` 自动安装依赖。**

源码实证（`packages/core/src/plugin/module.ts`）：
- 自动安装（`Npm.add`/`Npm.resolve`，后台安装+缓存）只针对 **opencode.json `plugins` 数组里配置的 npm/git 包**。
- 本地插件（`.opencode/plugins/` 发现的目录或独立 `.js`/`.ts` 文件）直接通过 `Host.resolve` + `Bun.resolveSync(specifier, pluginDir)`（Bun 运行时；Node 构建用 `import.meta.resolve` + registerHooks）解析并 import，**没有任何 install 步骤**。
- 本地插件若有 `package.json` 且含 `name` + `exports`，按 exports 解析各 part；否则按根目录约定文件名：`server`（缺省 `index`）、`tui`、`rpc` 的 `.ts/.tsx/.js` + `gui-experimental.cjs/.js`。
- bare import（如 `import x from "some-npm-pkg"`）能否工作取决于插件目录向上能否找到 `node_modules`——即需要用户**手动**在 `.opencode/` 跑 `bun install`/`npm install`。v1 的自动安装行为（会在 `.opencode/` 生成 `package-lock.json`，见 anomalyco/opencode#21625）在 v2 中不存在。

Trellis 影响：
- Trellis 三个插件（`session-start.js`、`inject-subagent-context.js`、`inject-workflow-state.js`）和 `lib/*.js` **只 import Node 内置模块（fs/path/os/child_process/crypto/buffer/process）和相对路径 `../lib/*`**，不 import `@opencode-ai/plugin`。→ 即使没有 node_modules 也能被 v2 加载。
- **但它们是 v1 插件实现（`export default async (input) => ({hooks})` 工厂函数），v2 插件 API 是 intentional breaking change，v1 插件实现根本不会运行。** 这才是真正的大改：需按 `Plugin.define({id, setup(ctx)})` 重写（迁移映射见下）。
- `.opencode/package.json`（仅声明 `@opencode-ai/plugin@^1.14.39`）在 v2 下变成纯死重：v2 不读它、不装它，运行时也不需要。SDK 包也改名为 `@opencode/plugin`。

v1→v2 插件 API 关键映射（Trellis 插件会用到）：
| v1 | v2 |
|---|---|
| `export default async ({directory, client}) => ({hooks})` | `export default Plugin.define({id, async setup(ctx) {...}})`，从 `@opencode/plugin` import |
| `directory` | `ctx.location.directory` |
| `tool.execute.before` / `tool.execute.after` | `ctx.tool.hook("execute.before"/"execute.after", cb)`，单个可变 event 对象 |
| `experimental.chat.messages.transform` | `ctx.session.hook("context", cb)`（`event.system` / `event.messages`；对每个 model request 生效需同时注册 `context`/`compaction`/`generate`/`title`） |
| `shell.env` | `ctx.shell.hook("create.before", cb)` |
| `permission.ask` | `ctx.permission.hook("evaluate", cb)` |
| 返回 `dispose()` | `setup` 返回 cleanup 函数 |
| `event` | `ctx.event.subscribe({signal})` async 迭代 |

注意 v2 本地插件按**目录**或**独立文件**加载；`.opencode/plugins/*.js` 独立文件仍可发现。

## 4. v2 `.opencode/` 目录自动发现清单（迁移文档确认 + 细节）

| 目录 | v2 状态 | 首选 |
|---|---|---|
| `agents/` | 发现 | ✅ 首选 |
| `agent/`（v1 单数） | 仍发现 | 迁入 `agents/` 不改 ID |
| `mode/` / `modes/`（v1） | 仍发现，其中文件视为 **primary** agents | 迁入 `agents/` 时须加 `mode: primary` |
| `commands/` | 发现；嵌套路径变成 `team/review` 形式命令名 | ✅ 首选 |
| `command/`（v1 单数） | 仍发现 | 迁入 `commands/` 保持相对路径 |
| `plugins/` | 发现：直接子级 `.ts/.js` 文件 + 立即子级插件包目录 | ✅ 首选 |
| `plugin/`（v1 单数） | 仍发现 | 用 `plugins/` |
| `skills/` | 发现 | ✅ 首选 |
| `skill/`（v1 单数） | 仍发现 | 整体移动 skill 目录保持 ID |
| `opencode.json(c)` | 项目级配置文件，仍读取 | — |

其他：项目 `.opencode` 目录从 cwd 向上发现到项目根；`AGENTS.md` 逐目录发现（v1 找到第一个就停），`CLAUDE.md` fallback 保留；全局目录 `~/.config/opencode/`（含 `agents/`、`commands/`、`plugins/`、`skills/`、`AGENTS.md`）。

## 5. Trellis 是否写 opencode 配置文件？

**不写。** 全仓 grep：`packages/cli/src` 中没有任何代码生成 `opencode.json`/`~/.config/opencode/opencode.json`；`configurators/opencode.ts` 只把模板目录 walk 成 `.opencode/**` 文件集（agents、plugins、lib、package.json + common 生成的 commands/skills）。仓库里 opencode.json 的提及只有 `.gitignore`（`*160|opencode.json`）和归档任务文档。

v2 配置位置（与 v1 相同，v2 原样读取并内存归一化）：系统级、`~/.config/opencode/opencode.json(c)`、`<project>/opencode.json(c)`、`<project>/.opencode/opencode.json(c)`。Trellis 未来若需要注入配置（如恢复 v1 的外部目录询问行为：`{action: "external_directory", resource: "*", effect: "ask"}`），写 `<project>/.opencode/opencode.json` 是最不侵入的位置。

## 6. v2 版本号与发布形态

- npm 包：**`@opencode/cli`**（bin：`opencode` 与 `opencode2`）。v1 的包是 `opencode-ai`（npm latest 停在 1.19.6）。仓库 README 的 npm badge 也指向 `@opencode/cli`。
- v2 插件 SDK 包：**`@opencode/plugin`**（v1 为 `@opencode-ai/plugin`）。
- 当前版本：本机 `opencode --version` 输出 **`opencode v2.3.2`**（2026-11-18 实测）；monorepo `packages/cli/package.json` 为 2.3.0（dev 分支）。
- v1/v2 检测：`opencode --version` 取首个 semver，**major ≥ 2 即 v2**（v2 输出带 `opencode v` 前缀；v1 输出格式未实测，建议只依赖解析出的 major 号 [v1 精确输出格式 INFERENCE 未验证]）。v2 与 v1 不再并存安装，v2 curl 安装器会替换 v1 二进制。
- 另一佐证信号：v2 有 `~/.config/opencode/cli.json`（终端客户端配置，v1 的 `tui.json` 首次启动时自动迁移）。

## 7. Trellis 模板逐文件迁移判定

| 文件 | 判定 | 理由 |
|---|---|---|
| `templates/opencode/plugins/session-start.js` | **必须改** | v1 插件工厂函数 + `experimental.chat.messages.transform` hook，v2 插件 API 为 intentional breaking change，根本不会执行 → SessionStart 注入全灭 |
| `templates/opencode/plugins/inject-subagent-context.js` | **必须改** | 同上，`tool.execute.before` hook 需迁到 `ctx.tool.hook("execute.before")` |
| `templates/opencode/plugins/inject-workflow-state.js` | **必须改** | 同上，`experimental.chat.messages.transform` → `ctx.session.hook("context")` |
| `templates/opencode/lib/*.js`（3 个） | 建议改（随插件重写） | 只用 Node 内置模块，加载不受影响；但调用方插件重写时接口可能调整 |
| `templates/opencode/package.json`（`@opencode-ai/plugin` dep） | **建议删除** | v2 不读不装 `.opencode/package.json`；插件 runtime 不 import 该包；纯死重（v1 若仍支持则需保留 → 双版本策略待定） |
| `templates/opencode/agents/trellis-{implement,check,research}.md` | **建议改** | v1 frontmatter 仍被自动转换，`mode: subagent` 和 read/write/edit/bash/glob/grep 的 allow 映射后语义不变（且 v2 默认全 allow，不影响运行）；但 `mcp__exa__*` / `mcp__chrome-devtools__*` 转换后是**死规则**（见 1.3）。建议整体转 v2 原生：`permission` → `permissions` 数组，`mcp__exa__*` → `exa_*`。注意整文件一次转完，禁止混用 |
| `commands/trellis/*.md`（common 生成） | **不用改** | 无 frontmatter，纯 Markdown template，v2 完全兼容 |
| `skills/`（common 生成） | **不用改** | `.opencode/skills/` 发现机制与 frontmatter 不变 |

## 8. 其他迁移相关要点（非直接问题但有适配价值）

- **v2 默认放开外部目录访问**：v1 对项目外路径会 ask，v2 `external_directory` 默认 allow。Trellis 插件会读 `~/.trellis` 等外部路径——v2 下不会再被拦，行为反而更顺，但若有"项目外写入"类操作需注意不再有提示。
- v2 subagent **一律后台运行**（父 agent 收到 idle 报告），与 v1 同步等待不同 → Trellis `trellis-implement`/`trellis-check` 的派发体验会变，workflow 文案若假设同步返回需复核。父 agent 能否拉起某 subagent 由父 agent 自己的 `subagent` action 权限控制（默认 allow）。
- v2 内置 agent 集合变化：`build`（默认）、`plan`、`general`、`explore`；**v1 的 `scout` 不存在**；隐藏维护 agent：`compaction`/`title`/`summary`。
- 命令后台化：带 subagent 语义的命令现在自动后台运行并向父会话汇报。
- Todos 在 v2 默认关闭（`experimental.todo: true` 开启）。
- v2 server API 是 breaking change：Trellis 若有任何代码调 v1 HTTP API（grep 未发现），需迁 `@opencode/client`。
- `opencode plugin list --builtin` / `plugin check` / `plugin update` 可用于验证插件加载状态。

## 来源

- https://opencode.ai/docs/agents （字段、mode、hidden、内置 agent、permissions 合并）
- https://opencode.ai/docs/permissions （action 全集、匹配规则、默认策略、MCP action 命名 `<server>_<tool>`）
- https://opencode.ai/docs/migrate-v1/ （agent/command/plugin/skill 文件迁移、混用判定、目录发现、accepted-but-unsupported）
- https://opencode.ai/docs/commands （命令字段表、subtask 为 deprecated alias）
- https://opencode.ai/docs/plugins 与 https://opencode.ai/docs/build/plugins （发现布局、本地目录 exports 解析、npm 包自动安装、CLI 管理命令）
- https://opencode.ai/docs/build/plugins/migrate-v1 （v1→v2 插件 API 映射、双版本共存形态）
- 源码（sst/opencode dev 分支）：`packages/core/src/v1/config/migrate.ts`、`packages/core/src/v1/config/permission.ts`、`packages/core/src/tool/mcp.ts`、`packages/core/src/tool/runtime.ts`、`packages/core/src/plugin/module.ts`、`packages/plugin/src/host.ts`、`packages/util/src/runtime/import.bun.ts`、`packages/cli/package.json`
- 本机实测：`opencode --version` → `opencode v2.3.2`；`npm view opencode-ai version` → `1.19.6`
- v1 自动装本地插件依赖的佐证：https://github.com/anomalyco/opencode/issues/21625
