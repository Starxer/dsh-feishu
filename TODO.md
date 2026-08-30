# dsh-feishu TODO

> 定位见 [AGENTS.md](./AGENTS.md)：**把 DSH 的原生特性接入飞书，而非再造一个 agent 平台/助手**。
> 状态：`已有` ✅ / `部分` ⚠️ / `待实现` 🔲 / `规划中` 📋 / `待调研` 🔍

---

## 0.1.2-alpha.1 适配（已完成，2026-08-28）

- 删除 `apiproxy` 依赖（DSH 0.1.2-alpha.1 整包移除 `packages/host/apiproxy`）
- events 订阅改 `ctx.on('session/event', (session, event) => ...)` —— 5 文件统一改
- user-questions / approval 答案改 `ctx.on('user-questions/request' / 'approval/request', listener return answer/outcome)` —— 走 Cordis waterfall，listener return 即 claim
- selectModel 改 `ctx.sessionController.selectModel(...)` 一站式同步 agent ref + WebUI + 持久化（之前 plugin 自己的 `selections: Map` + `installModelSelection` 删除）
- inject 数组 `'apiProxy'` → `'sessionController', 'userQuestions', 'approval'`
- `/stop` 改 `sessionController.cancel({ sessionId })`
- 132 tests pass / typecheck 0 errors / build OK
- 已知降级：`tool/call` 事件无 view 字段（callView 永远 undefined）；`tool/result` 用 `event.data.meta` 作 resultView

---

## 已完成

| # | 功能 | 说明 |
|---|---|---|
| 1 | 卡片化 + footer | 最终回复卡片底部标注 workspace + preset + **模型名** + **思考强度** + **上下文使用量** |
| 4 | `/status` 命令 | 展示 session id / title / workspace / preset / model / **reasoning** / tokens / context / **缓存命中率** / **TTFT** / **吞吐量** / **LLM 时间** / **工具时间** |
| 5 | 工具调用展示 | 订阅 `ctx.on('session/event')` → `tool/call` + `tool/result`，wathet/green/red 卡片。**原地更新**：`tool/call` 发卡片后保存 `messageId`，`tool/result` 用 `updateCard` 更新同一张卡片 |
| 6 | todo 展示 | 订阅 `ctx.on('session/event')` → `todo/write`，turquoise 卡片含进度条 |
| 11 | 中间消息不可见 | ✅ 改为 `ctx.on('session/event')` + `tool/call` 时 flush 累积文字，紫色卡片 |
| 12 | tool call 卡片 markdown 渲染 | ✅ `lark_md` → `markdown`，4 文件 11 处 |
| 13 | 卡片 Markdown 渲染不稳定 | ✅ 全面迁移到 Card JSON 2.0，表格/标题/内联代码原生渲染，移除降级逻辑 |
| 14 | 纯查询命令即时返回 | ✅ fire-and-forget + agent 运行状态检测 |
| 15 | Agent 消息队列调研 | 两层队列机制已确认（见下方调研记录） |
| 17 | `/reasoning` 思考强度命令 | ✅ `/reasoning [off|low|high|max]`，通过 `agentDefaultModel.saveSelection` 持久化 |
| 19 | tool_call / tool_done 顺序问题 | ✅ `tool/call` 直接发送保存 `messageIdPromise`，`tool/result` 等待后 `updateCard`，消除竞态 |
| 20 | 工具调用摘要 | ✅ 通过 mux `frame.view` 获取 `presentCall`/`presentResult` 的 `description`、`title`，显示在工具名称上方 |
| 21 | 卡片颜色区分 | ✅ 工具调用中 wathet → 成功 green → 失败 red；Reply 蓝色；Turn Complete 绿色 |
| 22 | Reply 标题命名 | ✅ 已统一为 "Reply" |
| — | `/stop` 命令 | 通过 `ctx.sessionController.cancel({ sessionId })` 中断运行中的 agent，等同 WebUI 停止按钮 |
| — | `/stream` 命令 | 切换 `showIntermediateMessages` 设置（已与中间消息模块解耦，保留备用） |
| — | 统一 per-step 卡片 | ✅ 每个 step 一张卡片，包含 reasoning + text + 工具调用 + 结果预览 + step 时长/token footer |
| — | 工具结果预览 | ✅ 按 `resultView.card` 类型分发渲染（terminal/web/search/read/diff/generic） |
| — | 工具名称内联代码 | ✅ 工具名用 `` ` `` 内联代码展示（如 `` `read` ``、`` `edit` ``） |
| — | Turn Complete 卡片 | ✅ 显示轮次时长、TTFT、吞吐量、输入输出 token、缓存命中率 |
| — | Step token footer | ✅ 每个 step 卡片底部显示时长 + 输入输出 token |
| — | Debounce + flush 同步 | ✅ 150ms debounce 合并快速更新，turn/end 时 flush 确保 footer 在 card update 之后发送 |
| — | 防止卡片消失 | ✅ 内层 try/catch 保护 mux 事件处理，timer 回调 error-safe |
| — | 不同步骤工具调用分离 | ✅ `resetStep` 不清除 `state.chat`（session 级坐标），每个 step 独立卡片 |
| — | 审批按钮反馈 | ✅ 点击后卡片更新为 ✅ Approved / ❌ Rejected，移除按钮 |
| — | 飞书事件订阅修复 | ✅ provision 新增 `im:message.reaction` 权限 |
| — | 卡片按钮回调修复 | ✅ ~~Node.js SDK `MessageType.CARD` 被过滤~~**经对照实验证实补丁不必要**：`card.action.trigger` 以 `type='event'` 到达，帧过滤不拦它；已移除 `patch-sdk-card-action.sh` + `postinstall`（还原 pristine SDK） |
| — | 选项卡片反馈 | ✅ 选择后 recall 旧卡 + 发新卡（青绿色头部，显示所有选项，已选高亮） |
| — | 双重编码 JSON | ✅ Feishu `action.value` 双重编码 → 二次 `JSON.parse`（questions + approvals） |
| — | Turn Complete 时间修复 | ✅ LLM 时间（assistant/message 累加）与工具时间（tool/result 累加）分开统计 |
| — | `/thread` 改名 `/session` | ✅ 命令实际操作 DSH session（`listSessions`/`switchToSession`），与飞书原生"话题"混淆、与 WebUI「会话」心智不一致；已重命名（`commands.ts`/`index.ts`/`tests`/文案/`FEISHU_OWNED_COMMANDS`），**不保留 `/thread` 别名** |
| — | `/session` 管理面板 | ✅ `feishu-session.ts`：下拉选会话 + 切换（占用先确认）/detach/归档/fork/改名（独立卡片，`sessionController.rename`）/列表/刷新；`/session list` 表格卡；`/session N` 快速切换 |
| — | `/help` 卡片化 + 分组 | ✅ 飞书文本不渲染 markdown → 卡片；分「🔹 dsh-feishu 插件 / 💠 DSH 内置」两组，被拦截命令（busy/steer/queue/permission/stop）补进 Feishu 组 |
| — | 工具调用摘要找回 | ✅ `deriveToolSummary`（`feishu-streaming.ts`）按 Web UI `classifyTool`+`deriveSummary` 从 tool/call 的 arguments 本地推导（bash/search/read/write/code/未知）；因 DSH 0.1.2-alpha.1 不再发射 `presentCall`，`callView` 路径已死 |
| — | 工具 args fenced 代码块 | ✅ args 用独立 `` ``` `` 代码块渲染（`sanitizeCodeblock` 折反引号/剔控制字符），避免破坏卡 markdown/横向溢出 |
| — | 工具结果兜底展示 | ✅ `renderResultPreview` 各分支无输出时 `finish()` 兜底渲染原始结果内容，保证结果始终可见 |
| — | 免会话命令重启可用 | ✅ `resolveAgentOrResume`（harness）冷会话懒恢复 + 真正免会话命令（`/model`/`/reasoning`/`/approvals`/`/approve`/`/deny`/`/help`）在 `resolveAgent` 兜底前直接拦截 |
| — | 问题结算卡保留描述 | ✅ `renderSettledQuestionCard` 补上 `detail` |
| — | Turn Complete 展示 busy 模式 | ✅ footer 只读显示 `**Enter while busy:**`（Queue/Steer），与 `/status` 一致 |
| — | `/busy` 交互选择卡 + `/queue` | ✅ `feishu-busy.ts`、`/queue`（`forceQueue`），模式匹配短接 |
| — | `action.value` 双解码 | ✅ `decodeCardValue`（多深度 JSON.parse，cap 4），busy/permission/model-select/session 共用 |
| — | `/model` 一站式 | ✅ `ctx.sessionController.selectModel`（agent scoped ref + WebUI + 持久化），不再用插件 `selections: Map`/`installModelSelection` |

## 下一轮待办（2026-08-30 定，未动工）

> 用户最后明确：**先更新 TODO 文件，暂不动手改代码**。以下 5 项为下一轮实现计划。

| # | 功能 | 优先级 | 说明 |
|---|---|---|---|
| 1 | subagent 只读列表面板 | **中** | 订阅 `ctx.subagents.listChildren` / `listDescendants`，列名称/状态/depth，并在会话面板/命令加入口。**只读列表**（用户澄清） |
| 2 | `/steer` 与 `/queue` idle 兼容 | **中** | agent 空闲时自动**回退为发新消息**（不再报错），回执注明「空闲→已作为新消息」；running 时行为不变（`/queue` 同）。读 `bridge.isAgentRunning` + `resolveAgentOrResume` 判断。**2026-08-30 核查**：`/steer` 仍未解决 —— 空闲时 `bridge.steer` 抛「当前没有运行中的 turn 可注入」，无明显空闲回退；`/queue` 空闲时实际已走新轮路径（`forceQueue` 正常），仅 `busyMode==='queue'` 的冗余短接会返回提示。**待办焦点 = `/steer` 空闲回退** |
| 3 | `locale` 设置 + `/lang` | **中** | ✅ 已完成（2026-08-31）：插件 `locale` 字段（`auto`/`zh`/`en`，默认 `auto`）+ `/lang [zh\|en\|auto]` 切换持久化。**语言源 = 插件字段，默认跟随 DSH**（`settings.get('locale').preference`，无值回退 `zh`）。见 CHANGELOG「中英双语 i18n」 |
| 4 | 插件文案 i18n（zh/en) | **中** | ✅ 已完成（2026-08-31）：命令响应层（`CommandTranslations` 拆 zh/en，`src/commands-i18n.ts`）+ 卡片层（`Translations` 字典 `src/i18n.ts`）：streaming/session/busy/permission/questions/onboarding/model-select/status/footer 全部双语，术语对齐 DSH。191 测试通过 |
| 5 | 测试 + typecheck + build + restart + 文档 | **中** | 上述改动收尾：补 spec、`npm run typecheck`/`test`/`build`、`systemctl --user restart dsh`、AGENTS/CHANGELOG 更新 |

---

## 待实现

> ⚠️ 状态已刷新（2026-08-30）：`#16 权限系统接入`、`/thread→/session` 改名均已**完成**，从本表移除。

| # | 功能 | 优先级 | 说明 |
|---|---|---|---|
| 18 | 思考内容**可折叠** | **中** | reasoning 代码块支持折叠（飞书 Card JSON 2.0 `collapsible` 组件）。**2026-08-30 核实**：3000 字符截断**已做**（`feishu-streaming.ts` reasoning/text 均 `slice(0,3000)`），仅 `collapsible` 未实现 |
| — | **step 卡片可见性开关**（过程透明可配置） | **中** | **后续计划**（2026-08-30 定）。step 级透明是双刃剑：对需观察/干预者有价值，对偶发使用者是打扰噪音。新增配置开关，控制三段式 per-step 卡片（💬 Reasoning / 📝 Message / 🛠 Tool call）各段展示内容，可自定义——如：①只展示其中一段；②只展示工具 description + 工具名、不展示具体 args。与 `showIntermediateMessages` 不同，是精细到"段/字段"的颗粒度 |
| 3 | 工作区候选补全 | **中** | 输入前缀列出匹配目录供选。**2026-08-30 核实**：插件源码无补全/建议逻辑，未实现 |
| 9 | 流式输出 → CardKit | **低** | 解决 5 QPS 瓶颈。**2026-08-30 核实**：卡片**已用** `cardkit.v1.card.create/update`（V2）建/改卡，但**未用** `streaming_mode` 单卡持续流式；per-step 仍各发一卡。待办收窄为「单卡流式更新」 |
| 8 | 文档与版本一致性 | **低** | 2026-08-30 核实：package.json `0.1.0`，README 明显过期未同步，仍待办 |
| — | 飞书 SDK 卡片回调补丁追踪 | **低** | 2026-08-30 核实：**可关闭** —— 无 postinstall/patch，SDK `1.73.0` 原版；card 帧被过滤已**证伪**（「已知问题」同段已标注）。仅为未来 SDK 变更留档 |

> ✅ 已从本表移除（2026-08-30 确认完成）：
> - `/new` 带参数（`--workspace`/`--preset`）—— 已实现
> - 多 session 话题导航 —— 已做（会话映射持久化 + 话题映射）；**不再做并行可见性**（用户明确）
> - `#16` 权限系统接入、`/thread→/session` 改名、SDK 补丁追踪（证伪关闭）

---

## `/thread` → `/session` 改名清单 —— ✅ 已完成（2026-08-30）

> 命令实际操作的是 DSH session（`bridge.listSessions()` / `bridge.switchToSession()`），`thread` 命名与飞书原生"话题"混淆，且与 WebUI「会话」心智不一致。**不保留 `/thread` 别名**，`/help` 列表中只出现 `/session`。下方清单为提出时的改动范围，历史存档。
>
> ⚠️ 只改**命令相关**的 thread 引用；`threadId` / `replyInThread` / `thread_id`（飞书话题消息坐标）与命令无关，**不要动**。

| 文件 | 改动内容 |
|---|---|
| `src/commands.ts` | 翻译键 `threadDescription`/`threadUsage`/`threadListHeader`/`threadListEmpty`/`threadListEntry`/`threadSwitched`/`threadInvalidIndex`/`threadArchived`/`threadIdle`/`threadLastActive*` → `session*`；`name: 'thread'` → `'session'`；`handleThreadCommand` 函数名；`formatRelativeTime` 内 `t.threadLastActive*` 引用 |
| `src/index.ts` | `executeSlashCommand` 中 `parsed.name === 'thread'` → `'session'`；translations 定义（约 489-502 行）的 `threadXxx` 键 → `sessionXxx`；`handleThreadDirect` 函数名及内部 `t.thread*` 引用 |
| `tests/commands.spec.ts` | stub translations 的 `threadXxx` 键 → `sessionXxx`；`registered.map(item => item.name)` 期望数组 `'thread'` → `'session'`；`describe('/thread command')`；`item.name === 'thread'` 查找；`Usage: /thread [N]` 断言文本 |
| `README.md` | 斜杠命令表 `/thread` → `/session`；`\| /thread [N] \| 列出/切换会话 \|` 行 |
| `AGENTS.md` | 3 处 `/thread` 提及（功能对齐表"多 thread 并行工作"行、session 映射持久化行）→ `/session` |
| `CHANGELOG.md` | 在 Unreleased 段**新增**一条改名记录（历史条目保留原文不动） |
| `TODO.md` | 本文档自身："多 thread 话题导航"行中 `/new` `/thread` 已通 → `/new` `/session` |

不需要改：`tests/harness.spec.ts`（无 thread 字样，经确认）；`src/harness.ts` / `src/conversation.ts` / `src/channel.ts` / `src/feishu-*.ts` / `docs/architecture.md`（仅含飞书话题 `threadId`/`replyInThread`，与命令无关）。

---

## 已知问题

### `im.v1.message.patch` 不更新卡片头部

**现象**：`updateCard`（底层调 `im.v1.message.patch`）只更新 body，不更新 header（标题、颜色）。

**影响**：
- Tool Call → Tool Done 颜色变化不生效（保持初始颜色）
- 选项卡片选择后颜色变化不生效

**解决**：需要改 header 时，recall 旧卡 + 发新卡。已用于：
- 选项卡片（feishu-questions.ts）— 选择后 recall + resend
- 审批卡片（feishu-approvals.ts）— 使用 updateCard（仅 body 变化，header 橙→绿 需要 recall）

**待优化**：审批卡片的 header 颜色变化目前依赖 updateCard，实际上不会生效。需要改为 recall + resend。**2026-08-30 核实**：`feishu-approvals.ts` 结算卡仍走 `channel.updateCard`（=patch），未按 `已知问题` 说明改 recall+resend，故橙→绿 header 变化至今仍未生效 —— 仍待优化。

### ~~Node.js SDK `MessageType.CARD` 被过滤~~（已证伪，补丁已移除）

**现象（原判断）**：飞书卡片回调事件（`card.action.trigger`）通过 WebSocket 推送时 `type='card'`，Node.js SDK 的 `handleEventData` 过滤了 `type !== 'event'` 的消息。

**纠错**：该判断经**对照实验证伪**——还原 pristine SDK（`type !== MessageType.event`）后重启，`card.action.trigger` 仍以 `type='event'`（带 `event_type`）到达插件，卡片点按正常。即帧过滤并不拦它，**此前加的 `scripts/patch-sdk-card-action.sh` + `postinstall` 补丁是过度诊断，已移除**，SDK 还原为官方原版。真正导致卡片「点按无反应」的是 `action.value` 双编码解析问题（用 `decodeCardValue` 修复，见 CHANGELOG）。

**长期方案**：若未来 SDK 变更导致 card 帧被拦，再评估提 issue/PR。

### `action.value` 双重编码

**现象**：飞书返回的 `action.value` 是 JSON 字符串内嵌 JSON 字符串（双重编码）。

**解决**：`JSON.parse` 两次（feishu-questions.ts、feishu-approvals.ts）。

---

## 问题追踪（2025-08-27）

### ✅ WebUI 改模型后 status 命令显示不更新 —— 已解决（2026-08-30）

**现象**：
- WebUI 里切换模型后，`/status` 命令显示的模型名仍是旧模型
- 即使在 WebUI 切换后进行一轮对话，`/status` 仍显示旧模型
- 在飞书继续对话后，`/status` 仍不更新，但实际对话的模型已经是 WebUI 切换后的模型

**复现**：WebUI 修改模型 → `/status`（显示旧模型）

**根因分析**：`/status` 命令读取的是 `bridge.selections`（飞书侧的 per-chat selection ref），而 WebUI 切换模型只更新了 `apiProxy.selections`（WeakMap，WebUI 侧）。两者是独立的缓存，没有同步。

**修复方向**：`/status` 命令需要优先从 `sessionController.selectModel` 的结果或 `selectionFor(agent).current` 读取当前实际模型，而不是只读 bridge 的 selection ref。

**解决**：`/model` 已改为 `ctx.sessionController.selectModel(...)` 一站式（写 agent scoped ref + WebUI + 持久化），插件不再维护独立的 `selections: Map`/`installModelSelection`；`/status` 改为读 `selectionFor(agent).current`（scoped ref）。飞书与 WebUI 收敛到同一处缓存，不再各读各的。**已确认解决**。

---

### 🔍 MiniMax M3 关闭思考后重新打开不思考 —— 待检查（2026-08-30 确认未解决）

**现象**：新建 session，把 M3 模型的思考强度关掉后进行一轮对话，再重新打开思考强度，模型不再进行思考（不输出 reasoning 内容）。

**复现步骤**：
1. 新建 session，模型选 MiniMax-M3
2. `/reasoning off`（关闭思考）
3. 进行一轮对话
4. `/reasoning high`（重新打开思考）
5. 模型不输出 reasoning 内容（不思考）

**根因分析**：关闭思考时 `selection` 被设为无 `reasoningEffort`，且这个状态被 sessionController 的 `selectionFor(agent).current`（读 requestHeader）持久化了。重新打开思考时，新的 `reasoningEffort` 虽然被设置，但 sessionController 的外层 `agent/request` listener 用 requestHeader 的旧 config（无 effort）覆盖，导致请求仍不带 thinking 参数。

**修复方向**：检查 `installModelSelection` 的 `agent/request` listener 在 `selection.assembled.reasoningEffort === undefined` 时删除继承的 effort 是否合理；考虑保留继承的 effort 而不是删除。

**状态**：⚠️ **尚未检查**（2026-08-30 用户确认仍未排查）。**2026-08-30 静态核实补充**：插件侧 `installModelSelection` / `agent/request` listener 在新架构（`sessionController.selectModel` 一站式）中**已删除**，旧 TODO 的「检查插件 installModelSelection 的 agent/request listener」路径已不通。若问题仍在，则归属 **DSH 侧 `ApiSessionAgentController`**（外层 `agent/request` 用 requestHeader 旧 config 覆盖新 effort），需在真实运行中复现确认，非插件可修。

---

## 卡片颜色参考

| 颜色 | 用途 | 文件 |
|---|---|---|
| blue | Reply 回复卡片、问题卡片 | `channel.ts`、`feishu-questions.ts` |
| turquoise (青绿) | Todo 列表卡片、已选问题卡片 | `feishu-todos.ts`、`feishu-questions.ts` |
| wathet (浅蓝) | Tool Call 调用中 | `feishu-streaming.ts` |
| green | Tool Result 成功 / Turn Complete | `feishu-streaming.ts`、`channel.ts` |
| red | Tool Error 失败 | `feishu-streaming.ts` |
| orange | 审批请求 | `feishu-approvals.ts` |
| grey | 无选项问题 | `feishu-questions.ts` |

---

## #11 中间消息不可见 —— ✅ 已修复

- **根因 1**：旧代码用 `ctx.on('session/event')` 订阅 Cordis 事件，在插件 scope 中不生效
- **根因 2**：旧代码依赖 `showIntermediateMessages` 设置，默认为 `false`
- **修复**（2025-08-25）：
  - 改用 `ctx.on('session/event')` 监听（与 toolcalls/todos 一致）
  - 逻辑：`assistant/chunk` → 累积 text-delta → `tool/call` 到达时 flush 为紫色卡片
  - 不再依赖 `/stream` 开关或 `showIntermediateMessages` 设置
  - 不再调用 `markIntermediateSent`（中间消息 ≠ 最终回复，不应跳过最终卡片）

## #17 `/reasoning` 思考强度命令 —— ✅ 已实现

- **命令**：`/reasoning` 查看 / `/reasoning off|low|high|max` 设置
- **持久化**：通过 `agentDefaultModel.saveSelection()` 写入 DSH settings，重启后自动恢复
- **联动**：status 卡片 + footer 均显示当前 reasoning effort

## #12 tool call 卡片 markdown 不渲染 —— ✅ 已修复

- **问题**：`feishu-toolcalls.ts` / `feishu-todos.ts` / `feishu-questions.ts` / `feishu-approvals.ts` 使用 `{ tag: 'div', text: { tag: 'lark_md' } }`，只支持粗体/斜体/链接，不支持代码块。
- **修复**：改为 `{ tag: 'markdown', content }`（同 reply card）。`channel.ts` 的 note 区保持 `lark_md`（note 只支持 lark_md）。

## #13 卡片 Markdown 渲染不稳定 —— ✅ 已修复（Card JSON 2.0）

- **根因**：Card JSON 1.0 的 markdown 组件不支持表格、标题、内联代码等完整语法
- **修复**（2025-08-25）：
  - 全面迁移到 **Card JSON 2.0**（`schema: '2.0'` + `body.elements`）
  - 表格、标题、内联代码（反引号）原生渲染，不再降级
  - `note` 标签（2.0 不支持）替换为 `markdown` + `text_size: 'notation'`
  - 删除 `needsPlainTextFallback()`、`logReplyDiagnostic()`、`buildFooterText()` 三个废弃函数
  - 回复流程简化：始终发卡片，不再有 markdown 消息降级路径

## #16 权限系统接入 —— ✅ 已实现（2026-08-30）

- **DSH 权限**：3 种 sandbox 模式（read-only / workspace-write / danger-full-access）+ permission presets
- **Session 事件**：`sandbox/mode`、`permission/preset`，持久化在 session log
- **飞书接入**：`/permission [模式]`（`feishu-permission.ts`）交互式选择卡 + 带参直接切换；`/sandbox` 保留为隐藏别名；命名/显示名对齐 WebUI `ui-permission-presets`（Read Only / Workspace Write / Full access）；`/status` 显示 Permission。复用 `ctx.get('sandboxPolicy')` 服务 + 会话日志 log-only `sandbox/mode` 事件

## #18 思考内容展示

- **目标**：模型 reasoning/thinking 内容以卡片形式展示，内容放在代码块里防止占用过多行
- **数据源**：`assistant/chunk` 事件中 `chunk.type === 'reasoning-delta'` 的文本
- **UI 方案**：紫色卡片（同中间消息），reasoning 文字包裹在 ` ``` ` 代码块中，可折叠

## #18 思考内容展示 —— 部分完成

- **已完成**：
  - `feishu-streaming.ts` 累积 `reasoning-delta` chunks
  - 在 `assistant/message` 时发送 step 卡片，reasoning 放在代码块中
  - `/reasoning show on|off` 控制是否显示 reasoning 内容
- **待优化**：
  - reasoning 代码块可折叠（飞书 Card JSON 2.0 支持 `collapsible` 组件）
  - reasoning 长度截断策略（当前 3000 字符）

## #19 tool_call / tool_done 顺序问题 —— ✅ 已修复

- **现象**：有时飞书先收到 tool result（绿色/红色卡片），后收到 tool call（蓝色卡片），顺序反了
- **根因**：`tool/call` 和 `tool/result` 都走 `scheduleBatch`（200ms debounce），`tool/result` 到达时 `messageId` 可能还没保存（异步竞态）
- **修复**（2025-08-25）：
  - `tool/call` 卡片**直接发送**（不走批量队列），保存 `messageIdPromise`
  - `tool/result` 时 `await messageIdPromise` 确保拿到 `messageId` 后再 `updateCard`
  - 效果：一张卡片从蓝色（调用中）→ 绿色/红色（完成），不再出现两张卡片

## #9 流式输出技术方案

> 详见下方 [飞书流式输出技术方案](#飞书流式输出技术方案)。

- **现状**：每次发独立新卡片，5 QPS 限制
- **目标**：CardKit 流式更新（单卡持续更新，无 QPS 限制）
- **状态**：方案已设计，待实现

---

## 飞书流式输出技术方案

### 现状：普通卡片发送（5 QPS 限制）

```
POST /im/v1/messages → 每张独立消息，5 QPS
```

### 目标：CardKit 流式更新（无 QPS 限制）

```
POST /cardkit/v1/card {streaming_mode: true} → 创建流式卡片，拿到 card_id
POST /cardkit/v1/card/:card_id/contents      → 持续更新，无 QPS 限制
```

| 限制项 | 值 |
|---|---|
| 流式更新 QPS | **无限制** |
| 卡片大小 | 30KB |
| 组件数量 | 200 个 |
| 自动关闭 | 10 分钟 |
| 文本流式频率 | 70ms/次（可配） |

### 参考

- [流式更新卡片概述](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview.md)
- [飞书AI机器人流式输出实践](https://juejin.cn/post/7600990891206819867)
- [CardKit 流式更新 Python 示例](https://feishu.danling.org/streaming/cardkit/)

---

## Agent 消息队列调研记录

- **两层队列**：Lark SDK `chatQueue`（per-chat 串行）+ DSH Agent `Inbox`（per-agent 应用层）
- **`followup()`**：消息进 `next-turn` 队列，`wakeRequested` latch，当前 turn 完成后自动处理
- **`whenIdle()`**：spin-until-stable，等所有排队 turn 完成才返回
- **关键结论**：消息不会丢失，但飞书侧需等当前 turn 完成才能响应
