# OpenCode v2 适配 — 技术设计

日期：2026-11-18。依据：`research/opencode-v2-plugin-api.md`、`research/opencode-v2-session-storage.md`、`research/opencode-v2-config-and-conventions.md`、官方迁移文档。

## 边界与原则

- 只动 OpenCode 平台面：模板（`packages/cli/src/templates/opencode/`）、生成器（`configurators/opencode.ts` 及周边）、mem 适配器（`packages/core/src/mem/adapters/opencode.ts`）、对应测试。
- 用户已拍板：**v2-only 模板 + 版本检测警告**（PRD ADR-lite）。不维护双实现。
- 三个插件的行为契约不变：SessionStart 注入、workflow-state breadcrumb 注入、subagent 上下文注入 + bash 环境注入。用户不可感知行为回归（仅 API 层重写）。

## 1. 插件重写（v1 factory → v2 `Plugin.define`）

### 1.1 入口形态

每个插件改为：

```js
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "trellis.session-start", // 稳定 id，plugin storage/诊断按 id 作用域
  async setup(ctx) {
    // ctx.location.directory 替代 v1 的 { directory }
    // 返回 cleanup 函数替代 v1 dispose hook
  },
})
```

- 模板 `package.json`：**删除**（v2 不读 `.opencode/package.json`，见 §2）。插件改为 default-export 字面量 `{ id, async setup(ctx) {...} }`，不 import `@opencode/plugin`（避免无依赖解析环境下裸 import 失败）；若实机验证 `Plugin.define` 可解析则优先用之（类型/helper 价值）。
- `$` Bun helper 已被 v2 移除——现有插件代码只用 `fs`/`path`/`process`，无需替代。

### 1.2 hook 映射（官方对照，来源 research §2）

| v1 用法 | v2 目标 | 涉及插件 |
|---|---|---|
| `experimental.chat.messages.transform` mutate `output.messages` | `ctx.session.hook("context", e => ...)` mutate `e.messages` / `e.system` | session-start、inject-workflow-state |
| `tool.execute.before`（拦截 task 工具） | `ctx.tool.hook("execute.before", e => ...)`，`e.input` 可变 | inject-subagent-context |
| `shell.env`（bash 环境注入） | `ctx.shell.hook("create.before", e => ...)`，`e.env` 可变 | inject-subagent-context |

语义保证：v2 官方明确 `context` hook "Changes affect only the outgoing model call, not persisted history"——#553 依赖的语义保留。

注意点：
- `context` 只在 agent loop 跑；compaction/title/generate 是独立 hook。session-start / workflow-state 只需 `context`。
- `context` 每次 agent-loop 请求都触发（含 tool 驱动的续轮）——workflow-state 每轮注入天然满足；session-start 的"仅首轮"判断（transcriptHasAssistantMessage）在 `event.messages` 上重新实现。
- system 注入改用 `event.system.push(...)`，不再塞进 messages。

### 1.3 subagent 识别简化

v2 event 直接携带 `readonly agent` + `sessionID`；`Session.Info.parentID` 判断子会话（`ctx.session.get({ sessionID })`）。删除 v1 的 `platformInputFromMessages` hack（`lib/context-visibility.js` 相应部分）。

### 1.4 目录布局

v2 自动发现 `.opencode/plugins/` 下**直接文件**与**直接子目录**。三个插件共享 `lib/`，方案：

```
.opencode/
  plugins/
    trellis-session-start/index.js      (或 trellis-session-start.js 散文件)
    trellis-workflow-state/index.js
    trellis-subagent-context/index.js
  lib/                                  (plugins/ 之外，不会被当作插件加载)
    trellis-context.js
    session-utils.js
```

散文件（`plugins/trellis-session-start.js`）也被自动发现，布局可保持扁平；但共享 lib 必须留在 `plugins/` 之外（当前已是 `.opencode/lib/`，安全）。**倾向保持散文件布局**——改动最小，与 v1 文件集同构，`trellis update` 的 hash 追踪逻辑不变。

验证项（research §10）：v2 对无 package.json 的 `.js` 散文件插件的 ESM 要求——需实测（acceptance 的实机验证覆盖）。

### 1.5 context-visibility.js 的拆分

v1 `MESSAGES_TRANSFORM_HOOK = "experimental.chat.messages.transform"` 常量与 `platformInputFromMessages` 随 v2 删除；`prependEphemeralText` 改为构造 v2 `SessionRequestMessage` part 形状（需按 `@opencode/ai` 源码确认 part 结构——research §10 验证项 3）。

## 2. Agent / Command 模板迁移

来源：research/opencode-v2-config-and-conventions.md（含 v2 源码 `packages/core/src/v1/config/migrate.ts` 核对）。

- `mode: subagent` v2 原样保留（v2 仅新增 `all`，默认 `primary`）——三个 agent 文件的 `mode` 行不动。
- `permission:` map → `permissions:` 数组，整文件一次转完（文件含 `permissions` 即按 v2 解析、v1 字段忽略）：
  - action 映射：`bash→shell`、`write|patch→edit`、`task→subagent`，其余原样（`read`/`glob`/`grep` 保留）。
  - 标量值（`allow`）→ `resource: "*"`。
  - **关键修正**：`mcp__exa__*: allow` 自动转换后是死规则（v2 MCP action 命名为 `<server>_<tool>`，如 `exa_web_search`，无 `mcp__` 前缀）。正确 v2 写法：`{action: "exa_*", resource: "*", effect: allow}`；research agent 的 `mcp__chrome-devtools__*` 同理 → `chrome-devtools_*`。
- 目标 frontmatter（三个文件同一形状）：

```yaml
---
description: |
  <不变>
mode: subagent
permissions:
  - { action: read, resource: "*", effect: allow }
  - { action: edit, resource: "*", effect: allow }   # 合并 v1 的 write+edit
  - { action: shell, resource: "*", effect: allow }
  - { action: glob, resource: "*", effect: allow }
  - { action: grep, resource: "*", effect: allow }
  - { action: "exa_*", resource: "*", effect: allow }
  # trellis-research 另加: { action: "chrome-devtools_*", resource: "*", effect: allow }
---
```

- Command 模板：Trellis common 命令模板无 frontmatter，完全兼容，不动。
- Skills：目录发现不变，不动。
- **删除模板 `package.json`**：v2 不读 `.opencode/package.json`、不自动安装本地插件依赖（auto-install 只覆盖 `plugins[]` 配置里的 npm/git 包）。Trellis 插件只 import Node 内建 + 相对 `lib/`，无外部依赖，`Plugin.define` 的 import 改为不依赖 npm 包（见 §1.1 备选）或保留 import 但实机验证解析。倾向：插件文件不 import `@opencode/plugin`，直接 default-export 字面量 `{id, setup}`——v2 运行时注入 ctx，`Plugin.define` 仅是类型/helper，删除 package.json 后无依赖可解析，必须避免裸 import 失败。实机验证两种形态取其一。
- 附带影响（记录在案，不改行为）：v2 subagent 一律后台运行；v2 `external_directory` 默认 allow（v1 默认 ask）——Trellis 工作流依赖 `~/.trellis` 等外部路径写入，v2 默认放行反而省去 v1 的授权弹窗。

## 3. mem 适配器重建（v1 表 → v2 表共存读取）

关键事实（research/opencode-v2-session-storage.md）：
- v2 仍是 SQLite，同路径 `~/.local/share/opencode/opencode.db`（WAL）。
- 新表 `session_v2` / `session_message` / `session_part`；v1 旧表 `session`/`message`/`part` 迁移后**保留共存**。
- 版本探测：查 `sqlite_master` 有无 `session_v2`；迁移进行中（`kv` 表 phase key）需双表并读。
- 新模型：`session_message.type` 判别联合；user 文本在 `data.text`，assistant 文本在 `data.content[]`；排序用 `(session_id, seq)` 唯一索引而非 time_created；part 无独立 ID（`(message_id, ordinal)`）。
- subagent：`session_v2.parent_id` 非空。
- 多 project：`project` 表 + `session_v2.project_id` + `directory` 列，单库。

设计：
1. `opencode.ts` 适配器增加 v2 读取路径：探测 `session_v2` 存在 → 走新 schema 抽取；否则回退现有 v1 路径（v1 数据仍在，向后兼容零成本）。
2. 迁移进行中（双表都有新写入）按 research §9 的规则并读去重。
3. 解除 0.6.0-beta 的 stub（reader unavailable 提示），恢复 `--platform opencode`。
4. 不走 server API（需 server 运行；SDK 默认 `:memory:`），保持直接只读 SQLite——与现有架构一致。

## 4. 版本检测（R7）

- 位置：`trellis init` / `trellis update` 的 opencode 平台路径。
- 方法：`opencode --version`（输出形如 `opencode v2.3.2`，来源：research §6 实测）；容忍不存在/超时/非零退出——静默跳过；解析 semver 主版本 < 2 → 打印升级提示（stderr warning，不阻断、不改退出码）。
- 注意 v2 npm 包更名为 `@opencode/cli`（bin 仍是 `opencode`），检测只依赖可执行文件，不依赖包名。
- 检测点只需一次（init/configure 入口），不做运行时校验。

## 5. 兼容性 / 回滚

- 模板整体换版后，`trellis update` 的 hash  diff 会把旧 v1 插件文件标记为 stale 并替换/删除——沿用现有 update 机制，无需专门迁移代码。
- v1 用户：插件不工作 + 升级提示（可接受的显式断裂，用户已拍板）。
- 回滚：模板与适配器均为前向兼容读取（v2 适配器仍读 v1 表），回滚 Trellis 版本即恢复。

## 6. 风险

| 风险 | 缓解 |
|---|---|
| v2 `event.messages` part 结构与 v1 不同，prepend 文本构造错误 | research §10-3 验证 + 实机验证（acceptance） |
| `.opencode/package.json` node_modules 模式在 v2 无官方继承说明 | 实机验证；失败则改 import 策略（不 import 包、字面量 define 对象） |
| v2 hook API 最低稳定版本未知 | package.json 依赖钉 `^2.3.2`（研究基准版本），文档注明 |
| 双表并读期数据重复 | 按 research §9 去重规则 + 测试夹具覆盖 |
