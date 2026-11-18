# OpenCode v2 适配

## Goal

OpenCode v2 包含三个 intentional breaking changes：插件 API、server API、终端客户端配置；另有配置格式演进（v1 格式仍兼容但 deprecated）。Trellis 通过 `trellis init --opencode` / `trellis update` 生成并维护用户项目的 `.opencode/` 目录，必须保证生成物在 OpenCode v2 下完全可用，同时重建 mem 的 OpenCode 会话读取能力。用户不手工迁移——升级 Trellis 后重新 init/update 即完成迁移。

## What I already know

- 插件（硬断裂）：`packages/cli/src/templates/opencode/plugins/*.js` + `lib/*.js` 全部基于 v1 插件 API（factory export、`experimental.chat.messages.transform` hook、bash 工具拦截），v1 插件在 v2 中**完全不运行**，必须重写。模板 `package.json` 依赖 `@opencode-ai/plugin@^1.14.39`。
- 插件功能清单（迁移时必须保持行为等价）：
  1. `session-start.js` — 会话首条消息注入 SessionStart 上下文（messages.transform，不污染历史）
  2. `inject-workflow-state.js` — 每轮注入 `[workflow-state:*]` breadcrumb（解析 workflow.md）
  3. `inject-subagent-context.js` — subagent 派发时注入任务上下文 + bash 工具调用拦截注入 Trellis 上下文环境变量
- Agent 文件（兼容但 deprecated）：`agents/trellis-*.md` 用 v1 frontmatter（`mode: subagent`、`permission` map），v2 自动转换仍可读；但同一文件混入任何 v2 字段（`permissions`/`system`/`disabled`/`request`）即整文件按 v2 解析、v1 字段被忽略——迁移必须整文件一次转完。
- 命令/技能文件：`.opencode/commands/`、`.opencode/skills/` 发现机制不变，Markdown 体不变；`subtask`→`subagent` 改名可选。
- mem 适配器：`packages/core/src/mem/adapters/opencode.ts`（490 行）读 `~/.local/share/opencode/opencode.db`（SQLite），在 0.6.0-beta 线已是 stub（打印 reader unavailable）。v2 存储架构变化需重建。
- 测试：`packages/cli/test/templates/opencode.test.ts`（1622 行）覆盖模板生成。
- 迁移文档：https://opencode.ai/docs/migrate-v1/ （本地副本要点已读完整 640 行）

## Assumptions (temporary)

- v2 提供与 `experimental.chat.messages.transform` 等价的 hook，三个插件的行为都能在新 API 下复现（待研究确认；若某 hook 无对应物，需评估降级方案）
- v2 的会话存储仍有本地可读的持久化形式（文件或 SQLite），mem 适配器可以不依赖运行中的 server（待研究确认）

## Open Questions

- 无（Q2 已由研究结论关闭：mem 适配器继续直接只读 SQLite；v2 同路径同文件，新表 `session_v2`/`session_message`/`session_part`，v1 旧表共存，按 `sqlite_master` 探测版本；不走 server API——需 server 运行，不适合离线检索）

## Decision (ADR-lite)

**Context**：v1 插件在 v2 完全不运行，v2 插件亦不能假定在 v1 运行，两者无法共用同一份插件文件；是否保留 v1 支持决定模板结构。
**Decision（用户拍板）**：方案 A——模板只发 v2 版本；`trellis init/update --opencode` 时检测本机 `opencode` 版本，发现 v1 则打印升级提示，不阻断生成。
**Consequences**：单一插件实现，维护成本最低；v1 用户升级 Trellis 后插件不工作，但有明确提示指引升级 OpenCode；检测逻辑需容忍 opencode 未安装（不报错）。

## Requirements (evolving)

- R1：`.opencode/plugins/` + `lib/` 重写为 v2 插件 API，三个插件行为与 v1 等价（SessionStart 注入、workflow-state 注入、subagent 上下文注入 + bash 环境注入）
- R2：模板 `package.json` 依赖更新到 v2 插件包版本线
- R3：agent 文件 frontmatter 迁移到 v2 原生格式（整文件一次转换，不混用）
- R4：mem OpenCode 适配器支持 v2 存储架构（解除 stub 或新增 v2 读取路径）
- R5：`trellis init --opencode` 与 `trellis update` 生成的完整文件集在 v2 下无警告/无功能缺失
- R6：测试更新（`packages/cli/test/templates/opencode.test.ts` 及 mem 适配器测试）
- R7：init/update 检测本机 opencode 主版本，v1 时打印升级提示（不阻断、opencode 未安装时静默跳过）

## Acceptance Criteria (evolving)

- [ ] 用 OpenCode v2 实际启动一个由 `trellis init --opencode` 生成的项目：插件加载无错误，SessionStart 上下文与 workflow-state breadcrumb 出现在模型输入中
- [ ] subagent 派发时任务上下文注入生效；bash 工具调用携带 Trellis 上下文
- [ ] `trellis mem --platform opencode` 能列出并搜索 v2 会话
- [ ] `packages/cli/test/templates/opencode.test.ts` 全绿；mem 适配器有 v2 格式测试覆盖
- [ ] lint / typecheck / 全量测试绿

## Out of Scope (explicit)

- OpenCode server API 客户端集成（Trellis 当前不调用 server API）
- v2 `cli.json` 终端客户端配置（Trellis 不生成 TUI 配置）
- 非 OpenCode 平台的任何改动

## Technical Notes

- 插件模板：`packages/cli/src/templates/opencode/{plugins,lib,agents,package.json}`
- 生成器：`packages/cli/src/configurators/opencode.ts`（walk 模板目录 + common 模板生成 commands/skills）
- 平台定义：`packages/cli/src/types/ai-tools.ts`（opencode 条目）
- mem 适配器：`packages/core/src/mem/adapters/opencode.ts`
- 测试：`packages/cli/test/templates/opencode.test.ts`
- 迁移文档：https://opencode.ai/docs/migrate-v1/
- 关键 v2 行为：v1/v2 字段可在顶层共存，但单个 agent/provider/command 条目内不递归混合格式；`external_directory` v2 默认 allow（v1 默认 ask）

## Research References

- [`research/opencode-v2-plugin-api.md`](research/opencode-v2-plugin-api.md) — v2 插件 API（进行中）
- [`research/opencode-v2-session-storage.md`](research/opencode-v2-session-storage.md) — v2 会话存储架构（进行中）
- [`research/opencode-v2-config-and-conventions.md`](research/opencode-v2-config-and-conventions.md) — v2 配置与文件约定（进行中）
