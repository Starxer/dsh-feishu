# dsh-feishu TODO

> 定位见 [AGENTS.md](./AGENTS.md)：**把 DSH 的原生特性接入飞书，而非再造一个 agent 平台/助手**。本清单聚焦"与 DSH Web UI 功能对齐"的缺口。状态定义：`已有` / `部分` / `规划中` / `待实现`。

## 本轮需求决策（2026-08-23 已确认）

- **workspace 和 agent preset 只在「创建新 session」时设定**，不运行时热切、不做复杂操作——**全部按 WebUI 原生行为**实现。
- **每轮最终结果用飞书卡片**，卡片底部注明当前 session 的 **workspace + preset（agent 模式）**。这段 footer **不调用 LLM**，由插件从 session meta 自动注入。
- **工作区选择用"cd 式候选补全"**：不即时补全，而是**列出匹配的子目录候选让用户选**；**只列目录，不列文件**。
- 新增 **`/status`** 命令，展示 WebUI 的 session 全部状态信息。

## 可复用的接缝（动手前先读）

工具调用与 todo 展示都能**零改造 DSH** 实现，因为 DSH apiproxy 的 `events.mux()` 流已经把它们透传出来（`packages/host/apiproxy/src/api/events.ts`）：

- `tool/call` / `tool/result`：经 `{ type: 'session/event', event, view }` 帧透传，`view` 是 Host 算好的渲染意图（`ToolCallView` / `ToolResultView`），飞书侧无需自己解析 args/result。
- `todo/write`：同为 `session/event` 帧透传，`event.data.todos` 喂 WebUI 的 TodoPanel（见 `packages/client/connection/src/client/fixture.ts`）。

**现成模式（照抄 `src/feishu-questions.ts` / `src/feishu-approvals.ts` 即可）**：
1. `apiProxy.events.mux({...}, signal)` 订阅流；
2. `bridgeHolder.current.resolveChat(frame.sessionId)` 反向定位 chat（`/new` `/thread` 覆盖也识别）；
3. 经 `cardChannel`（`send` + `onCardAction`）投递到飞书，`chat.threadId` 存在则 `replyInThread`；
4. 所有 listener 在 `runtime.onChannelChange` 时重挂（连接重建后失效）；
5. 用 `ctx.effect` 注册 dispose（对应 `src/index.ts:226`）。

**session 元数据来源**：`cwd` 与 `agentPreset` 持久化在 session header 里（`packages/session/session-persistence-jsonl/src/format.ts:57,62`），可通过 `sessionPersistence.readFrom()` 读，也记在 `agents.create({ meta: { cwd, agentPreset } })`（`src/harness.ts:408`）。卡片 footer 与 `/status` 都从这里取，**不经过 LLM**。

---

## 1. 每轮最终结果卡片化 + 底部标注 workspace/preset —— `已有` ✅

- **目标**：每轮对话的最终 assistant 文本渲染成**飞书 interactive card**，卡片底部（footer）固定标注当前 session 的 **workspace 路径 + agent 模式（preset）**。
- **实现**：`src/channel.ts` 的 `renderReplyCard()` 使用 `{ tag: 'markdown', content }` 组件渲染，底部 note 注入 workspace + preset。空回复显示 `(empty response)` 占位。

## 2. 工作区 + 预设只在 `/new` 时指定 —— `待实现`（含命令扩展）

- **目标**：`/new` 支持带参数指定 workspace 和 agent preset，创建新 session 时生效；**不**改变已有 session。
- **现状**：`handleNewCommand`（`src/commands.ts:307`）无参，只加 salt 生成新 sessionId；bridge 的 `config.workspace` / `config.agentPreset` 是全局配置。
- **待补**：
  - `/new [--workspace <path>] [--preset <id>]` 解析参数；
  - bridge 按 chat 记录"下一次 createAgent 用的 workspace/preset"（per-chat pending override，类似已有 `chatToSession` 的模式，`src/harness.ts:88`）；
  - 未指定时沿用全局 config / WebUI 原生默认。
- **参考语义**：persisted——只影响新 session，运行中不动（同 `/model` 的 `modelPersisted`）。
- **验收**：`/new --workspace ... --preset ...` 后，新消息落到该 workspace / preset；旧 session 不受影响。

## 3. 工作区选择：cd 式候选补全（列目录供选） —— `待实现` ⭐

- **目标**：输入 workspace 前缀时，**列出匹配的子目录候选**让用户选择；**只列目录，不列文件**；**不是 shell 即时补全**（补全文本），而是"列选项供选"。
- **现状**：无。workspace 目前是配置项。
- **接缝**：插件在 host 端可读文件系统——`/new --workspace` 输入前缀后，`readdir` 列该前缀下匹配的子目录（`fstat` 判断 `isDirectory()`），过滤文件，返回候选列表给用户选。
- **形态**：返回候选列表（如 `/workspace /path/to/<TAB>` 或 `/new --workspace /path/to/` 绑定候选时），用户从列表选一个，填入完整路径。
- **验收**：输入前缀能列出仅目录候选；文件不在列表中；用户选择后得到可用的 workspace 路径。

## 4. `/status` 命令 —— `待实现` ⭐

- **目标**：展示当前 session / chat 的 WebUI 全部状态信息。
- **现状**：无。
- **应显示字段**（对齐 WebUI）：
  - session id、title、最近活动时间（`/thread` 列表已具备，`src/harness.ts:300` `listSessions`）；
  - workspace（= `meta.cwd`）、agent preset（`meta.agentPreset`）；
  - 当前 model（provider/model（+reasoning）），来自 `currentSelectionFor` / `agentDefaultModel.currentSelection()`（`src/harness.ts:244`）；
  - running 状态（`host/session-status running`）、是否 archived（`workspaceRegistry.archivedSessionIds`）。
- **边界**：纯命令路径，走 `commands.execute`，**不调 LLM**（同 `/help`）。
- **接缝**：`agent-presets.select({ sessionId, agentPreset })`（`packages/host/apiproxy/src/api/agent-presets.ts:71`）是 WebUI 运行时换 preset 的原生 RPC——**当前不做**，仅在此备注为后续可能接点。
- **验收**：飞书 `/status` 返回完整状态信息，内容与 WebUI 一致；用户可据此确认当前 session 的工作区、模式、模型。

## 5. 工具调用展示 —— `已有` ✅

- **目标**：模型调用工具时在飞书侧可视化（工具名、参数、结果），对齐 WebUI ToolCard。
- **实现**：`src/feishu-toolcalls.ts` 订阅 apiproxy mux `tool/call` + `tool/result` 事件，蓝色卡片（调用开始）+ 绿色/红色卡片（调用完成/失败），含参数摘要、结果、耗时。200ms 批量 debounce 防刷屏。

## 6. todo 展示 —— `已有` ✅

- **目标**：把 DSH 的 todo 状态映射到飞书，对齐 WebUI TodoPanel。
- **实现**：`src/feishu-todos.ts` 订阅 apiproxy mux `todo/write` 事件，绿色卡片含进度条（完成数/总数）和状态图标（⬜ 待办 / 🔄 进行中 / ✅ 完成）。500ms debounce。

## 7. 多 thread 并行 → 飞书话题导航 —— `规划中`

- **目标**：用飞书话题映射多个并行 thread，用户能并行推进多个会话。
- **现状**：底层已通——话题按 `chat_id + thread_id` 生成独立 session（`src/conversation.ts:12` `conversationKey`），回复留原话题（`replyInThread`）。缺并行可见性/导航。
- **待补**：如何在飞书侧看到当前活跃话题/会话（对齐 WebUI session 树）；话题间入口切换（现有 `/thread` 是聊天级非话题级）；可选订阅 `host/session-added` / mux `session/subscribed` 做活跃提示。
- **接缝**：DSH `agents` registry + `sessions`；`resolveChat` 已能反向查表（`src/harness.ts:181`）。
- **验收**：飞书能并行推进多个话题，各自独立不串，能看清各自状态。

## 8. 文档与版本一致性 —— `低` / quick win

- **README 过期**：`README.md:292-293` 仍写 `/compact` 可用，但 CHANGELOG 已确认 `/compact` 移除。需同步：勾掉 `/compact`，补 `/new` `/thread` `/help` `/approve` `/deny` `/approvals`（及本清单新增的 `/status`、`/new --workspace/--preset`）。
- **README 定位未对齐**：README 开头仍是"channel 插件"口径，应按 AGENTS.md 新定位更新。
- **版本号**：`package.json` 是 `0.1.0`，CHANGELOG 已发布到 `0.2.2`。改名前先厘清。

---

## 优先级建议

1. ~~**#1 卡片化 + footer**~~ ✅ + **#4 `/status`** —— 本轮核心，纯插件层收尾，无 DSH 改动，立即提升飞书体验。
2. **#2 `/new` 带参数** + **#3 目录候选补全** —— 配合 #1 的 footer，让用户能把会话正确落到目标 workspace/preset。
3. ~~**#5 工具调用展示**~~ ✅ + ~~**#6 todo 展示**~~ ✅ —— 已完成，零改造 DSH，复用 mux 订阅模式。
4. **#8 文档一致性** —— 顺手清理。
5. **#7 多 thread 话题导航** —— 工作量更大，底层已在。

> 每完成一项，更新本清单状态 + 同步更新 AGENTS.md 的「与 DSH Web UI 功能对齐」表。
