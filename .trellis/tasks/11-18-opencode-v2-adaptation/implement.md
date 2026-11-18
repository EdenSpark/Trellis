# OpenCode v2 适配 — 执行计划

依据 prd.md + design.md + research/ 三份研究。四个阶段，每阶段独立可验证。

## Phase A：插件重写（核心，风险最高）

1. [x] `lib/trellis-context.js`：保留（TrellisContext/debugLog/isTrellisSubagent 等），删除依赖 v1 hook 形状的部分
2. [x] `lib/context-visibility.js`：删除 `MESSAGES_TRANSFORM_HOOK` 常量与 `platformInputFromMessages`（v2 event 自带 `agent`/`sessionID`）；`prependEphemeralText` 改为操作 v2 `event.messages`/`event.system` 的 part 结构（先按 `@opencode/ai` 源码确认 part 形状——research §10-3）
3. [x] `plugins/session-start.js`：`export default { id: "trellis.session-start", async setup(ctx) {...} }`；注册 `ctx.session.hook("context", ...)`；首轮判断（transcriptHasAssistantMessage）迁移到 `event.messages`；subagent 判断改 `event.agent` + `ctx.session.get({sessionID}).parentID`
4. [x] `plugins/inject-workflow-state.js`：同上迁移到 `context` hook；breadcrumb 解析逻辑不变
5. [x] `plugins/inject-subagent-context.js`：`ctx.tool.hook("execute.before", ...)` 拦截 task 工具（mutate `event.input`）；`ctx.shell.hook("create.before", ...)` 替代 `shell.env` 注入 bash 环境
6. [x] 删除模板 `package.json`；确认 `configurators/opencode.ts` 的 EXCLUDE_PATTERNS / 注释同步（package.json 不再是 shipped 文件）
7. [x] 验证：`node --check` 各文件；单测覆盖 hook 注册逻辑（mock ctx）
8. [x] **实机验证**（rollback point）：本机装 OpenCode v2，`trellis init --opencode` 到临时项目，启动 opencode，确认：插件加载无错误日志、SessionStart 上下文注入、workflow-state 每轮注入、task 工具拦截生效、bash 环境注入生效

## Phase B：Agent 模板 + 版本检测

9. [x] 三个 `agents/trellis-*.md` frontmatter 按 design §2 目标形状转换（`permission`→`permissions` 数组，`mcp__exa__*`→`exa_*`，`mcp__chrome-devtools__*`→`chrome-devtools_*`，`mode: subagent` 保留）
10. [x] 版本检测：init/update 的 opencode 路径加 `opencode --version` 探测（容忍缺失/超时/非零退出静默跳过；major<2 打 stderr 提示不阻断）
11. [x] 验证：`packages/cli/test/templates/opencode.test.ts` 更新并全绿

## Phase C：mem 适配器 v2

12. [x] `packages/core/src/mem/adapters/opencode.ts`：打开 db 后探测 `sqlite_master`——有 `session_v2` 走 v2 路径，否则走现有 v1 路径（保留，v1 数据向后兼容）
13. [x] v2 路径：list 用 `session_v2`（`parent_id IS NULL` 默认过滤子会话，`directory` 过滤 project）；turn 抽取按 research §9-2 规则（user→`data.text`；assistant→`data.content[]` 的 text 元素拼接；compaction completed→`data.summary`；其余 type 不进对话流）；排序用 `(session_id, seq)`
14. [x] 迁移未完成（`kv` key `migration.v1-v2` phase != completed）时双表并读、按 session id 去重
15. [x] 解除 0.6.0-beta stub（reader unavailable 分支），恢复 `--platform opencode`
16. [x] 测试：v2 schema 夹具 db（构造 `session_v2`/`session_message` 行）覆盖 list/extract/search；v1 回归不破

## Phase D：收尾

17. [x] `trellis update` 对存量用户的文件集 diff：旧 v1 插件文件被正确替换（hash 追踪机制验证）；**重点验证 `.opencode/package.json` 从模板集消失后 update 的行为**（orphan manifest entry 是被 prune 还是提示删除——`packages/cli/src/commands/update.ts` 有 "Pruned orphan manifest entries" 逻辑，需确认文件本体是否残留及是否可接受）
18. [x] **保留** `uninstall-scrubbers.ts` 的 `scrubOpencodePackageJson` 与 `managed-removal.ts` 的 `.opencode/package.json` 条目——存量用户的 hash manifest 仍记录该文件，uninstall 需要它；仅确认新安装不再产生该条目
19. [x] 新增 migration manifest（`packages/cli/src/migrations/manifests/`）说明 OpenCode v1→v2 断点：v1 插件被替换为 v2 实现、package.json 移除、agent frontmatter 换格式；参考 `create-manifest` skill 与 0.5.0-beta.8.json 先例
20. [x] 全量：lint / typecheck / 全测试绿
21. [ ] spec 更新（`.trellis/spec/`：opencode 平台约定改为 v2 基线；trellis-meta / trellis-session-insight 中 "OpenCode adapter degraded/stub" 表述更新；trellis-meta `hooks-and-settings.md` 的 `.opencode/package.json` 行更新）
22. [ ] changelog / docs 提及 OpenCode v2 要求与 v1 断点

## 验证命令

- 单测：`pnpm --filter @trellis/cli test`（opencode.test.ts）、`pnpm --filter @trellis/core test`（mem）
- lint/typecheck：按 repo 根 package.json scripts
- 实机：Phase A-8 步骤即验收标准

## 回滚点

- Phase A-8 实机验证失败 → 插件 API 理解有偏差，回 research §10 验证项逐项实测，不进入 B/C
- 各 Phase 独立 commit；任一 Phase 失败不影响已合入的前置 Phase

## 不做

- server API 客户端、cli.json、双版本插件并存、v0 JSON 目录存储支持
