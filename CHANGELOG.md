# Changelog

## Unreleased

本仓库基于 [sugarforever/dsh-lark](https://github.com/sugarforever/dsh-lark) HEAD（`ee639df`）独立维护，**不再跟踪 upstream 同步**。所有改动仅修改本仓库文件，**未对 DSH 源码（`DSH 源码/packages/*`、`vendor/*`）做任何改动**。上游 LICENSE（MIT, Copyright (c) 2026 sugarforever）保留以满足 MIT modified-work 声明。

### `/busy` 交互式选择卡片 + `/queue` 命令（`src/feishu-busy.ts` / `src/index.ts` / `src/harness.ts`）

- **`/busy` 卡片**：`/busy` 无参原本只回文本列出 Queue/Steer 选项。新增 `feishu-busy.ts`（仿 `feishu-permission.ts`），复用共享 `cardChannel.onCardAction` 多订阅者 + 跨重连自动重绑。无参改为发送 **交互式卡片**（header "Enter while busy"，turquoise）：body 展示当前模式（`✓` + `disabled`），下方两个按钮 `Queue · 当前轮结束后作为新轮运行（默认）` / `Steer · 注入当前运行轮立即响应`。点击按钮 → `bridge.setBusyMode(chat, mode)` 持久化 → `updateCard` 原地刷新重新标记。`/busy queue|steer` 文本快捷路径保留。`renderBusyCard` 导出以便单测。
- **`/queue <内容>` 命令**：`/steer` 的共轭——即使聊天处于 steer 模式，也**强制走 queue 路径**（等当前 turn 结束、作为新一轮运行），而不是注入当前轮。`bridge.reply` 新增 `opts.forceQueue`（默认为按 chat busy 模式），`/queue` 传 `{ forceQueue: true }`。命令**立即回执**（`📥 已把消息排队为该聊天下一轮运行：\`<内容>\`...`），实际排队在后台进行（`bridge.reply` 内部本就等 idle 后 followup）；排队结果的输出仍经 per-step 流式卡片渲染。排队期间 `/stop` 会递增代际 → `TurnDroppedError`（静默丢弃，不视为失败）。`/queue` 内容为空返回用法报错。**模式已匹配时短接**：若聊天已在 queue 模式，`/queue` 是冗余（普通消息本就排队）——不再实际提交，返回提示「已在 queue 模式，直接发消息即可」「想注入用 `/steer` 或 `/busy steer`」。
- **`/steer` 模式已匹配短接**：若聊天已在 steer 模式，`/steer` 是冗余（普通消息本就注入）——不再实际提交，返回提示「已在 steer 模式，直接发消息即会注入」「想排队用 `/queue` 或 `/busy queue`」。其他情况（queue 模式下用 `/steer` 强制注入）仍在成功时立即回执 `🎯 已注入运行中的 turn：...`。

### `/steer` 立即回执反馈（`src/index.ts`）

- **症状**：`/steer <内容>` 注入运行中 turn 成功后原来返回 `{ kind: 'consumed' }`，飞书端**没有任何反馈**——只有被注入内容经 per-step 卡片流式渲染才算有反应，用户难以确认 `/steer` 是否被接收、注入的是什么。
- **修复**：`/steer` 成功改返回 `{ kind: 'success', text }`，立即回执一条确认消息：`🎯 已注入运行中的 turn：\`<内容>\`\n\nAgent 会把它作为下一步指令继续执行。若想中止，发送 \`/stop\`。`；失败仍返回带原因的报错文本。`bridge.steer` 仍不 `whenIdle`（注入即返回），回执与后续 per-step 流式卡片互不冲突，不会重复回执卡片。

### 权限模式选择（`/permission`，对齐 WebUI）+ `/status` 显示权限模式（`src/index.ts`）

- **背景**：DSH Web UI 用 `ui-permission-presets` 插件把这个能力命名为 **Permission（权限）**，命令是 **`/permission <预设>`**，预设显示名 `Read Only` / `Workspace Write` / `Full access`（`danger-full-access` 的产物文案）。最初我用 `/sandbox` 命名，与 Web UI 不一致。
- **实现**：
  - 命令改为 **`/permission [模式]`**（保留 `/sandbox` 作为隐藏别名）：无参时展示当前**有效模式**（`sandboxPolicy.resolve({ session }).mode`，优先级 = 显式授权 grant > 会话 `sandbox/mode` 事件 > 部署默认）与可选模式列表（显示名对齐 WebUI：`Read Only` / `Workspace Write` / `Full access`）；带参时切换（复用 DSH `setSandboxMode` 的写路径——向会话日志追加一条 **log-only** `sandbox/mode` 事件，下一次受限调用 bash/fs 即生效）。
  - 模式词表 `SANDBOX_MODES` 与 `PERMISSION_LABELS`（kebab→title，`danger-full-access`→`Full access`）在插件内定义；`dsh-sandbox-policy` 未作为插件依赖（node_modules 无此包），故不 import，改用 `ctx.get('sandboxPolicy')` 服务 + 直接 `session.append('sandbox/mode', { mode })` 复刻写路径。
  - `/status` 卡片新增 `**Permission:** \`<mode>\` <Label>（如 \`workspace-write\` Workspace Write ✍️）` 行。

### `/permission` 交互式选择卡片（`src/feishu-permission.ts` / `src/index.ts`）

- **背景**：`/permission` 无参时原来是纯文本列出当前模式与选项，无法像 WebUI 的 picker 那样点选切换。
- **实现**：新增 `feishu-permission.ts`，复用 shared `cardChannel.onCardAction`（多订阅者、跨重连自动重绑，见 `index.ts` 的 `cardActionHandlers` Set）。`/permission` 无参改为发送 **交互式卡片**：header "Permission"（turquoise），body 展示当前模式（`✓` 标记、active 按钮 `disabled`），下方三个按钮 `Read Only`（default）/ `Workspace Write`（primary）/ `Full access`（danger）。点击按钮 → 解析 `{ p: 'permission', mode }` → `session.append('sandbox/mode', { mode })` 切换 → `updateCard` 原地刷新、重新标记当前项。`/permission <模式>` 文本路径保留（对齐 WebUI 直接打 `/permission <预设>` 的直接切换）。`renderPermissionCard` 导出以便单测（4 用例：当前模式/标记/类型、点击切换、忽略无关action/未知卡片）。

### 审批卡片：按钮顺序 + 显示原因（`src/feishu-approvals.ts`）

- **症状**：审批卡片上「Reject」按钮排在「Approve once」上方（违反确认在前、危险在后的惯例）；卡面只有 Tool 名和 id，没有展示审批原因，用户不知道工具要做什么。
- **修复**：`renderApprovalCard` 按钮改为「Approve once（primary）」在上、「Reject（danger）」在下；卡面新增 `**Reason:** <request.reason>` 一行（`ApprovalRequest.reason` 为空时省略该行）。`PendingApproval` 增加 `reason` 字段，仅在存在时注入（`exactOptionalPropertyTypes`）。`renderApprovalCard` 导出以便单测。

### `/steer <内容>` 运行中注入（`src/harness.ts` / `src/index.ts`）

- **背景**：DSH 消息队列有 `queue`（排入 `next-turn`，当前 turn 结束后开新轮）与 `steer`（注入 `next-step`，**当前进行中的 turn** 在下一步边界立即消费）两种模式。飞书 bridge 恒走 `agent.followup`（queue），所以运行中发消息永远排队成新轮，无法像 WebUI 那样在中途注入。
- **实现**：
  - `HarnessConversationService.steer(message)`（`harness.ts`）：解析已有 agent（不创建），校验 `agent.status === 'running'`，构造带 `[Feishu] ` 标记的用户消息并调 `agent.steer(...)`，立即返回（不 `whenIdle`，注入由运行中的 turn 消费，step 卡片经 feishu-streaming 渲染）。
  - 新增 `/steer <内容>` 斜杠命令（`index.ts`）：取 `parsed.rawInput` 作为注入内容；成功返回 `{ kind: 'consumed' }`（避免多余回执卡片），失败（无会话 / 未运行 / 内容为空）返回带原因的错误文本。
- **注意**：`/steer` 是显式 opt-in。运行中直接发**普通消息仍走 queue**（对齐 WebUI 默认行为）；只有 `/steer` 才注入当前 turn。

### `/stop` 丢弃排队消息，对齐 WebUI 停止语义（`src/index.ts`）

- **症状**：agent 运行中从飞书又发了一条新消息（进入 agent inbox 排队），此时 `/stop` 只终止了当前循环，排队的新消息又立即开启新一轮循环；而 WebUI 的停止按钮会终止所有运行（包括队列里的）。两者体验不一致。
- **根因**：`sessionController.cancel({ sessionId })` 内部硬编码 `agent.cancel({ kind: 'user' }, { keepInbox: true })`——只中止当前 turn、**保留 inbox**。于是被中止后，排队消息被兑现，重启一轮。
- **修复**：`/stop` 改为直接取 live agent（`agents.get(sessionId)`）并调用 `agent.cancel({ kind: 'user' }, { keepInbox: false })`——同时**清空 pending inbox**（丢弃排队消息）并中止当前 turn，对齐 WebUI 停止按钮。无 live agent 时返回「该 session 当前没有运行中的 agent，无需停止。」。插件新增注入 `agents`（host `AgentRegistry`）并透传给 `executeSlashCommand`。
- **⚠️ 已知限制（未完全生效）**：agent 运行中你从飞书发新消息时，该消息**不在 agent inbox 里**——`bridge.reply`（`harness.ts`）先 `await agent.whenIdle()` 等当前 turn 结束，**之后**才 `agent.followup(...)` 入队。所以 `/stop` 的 `keepInbox:false` 清空的是（当时为空的）inbox；当前 turn 被中止后 `whenIdle()` 立即 resolve，等待中的 `bridge.reply` 继续 followup 该消息 → **仍会开启新 turn**。这与 WebUI（prompt RPC 立即 `agent.followup` 入队，故 `keepInbox:false` 能丢弃）的路径不同。**根因在 Feishu 的"先等 idle 再入队"延迟提交，而非 `keepInbox`。** 彻底修法是在 `/stop` 时给会话标记一次停止代际（generation），`bridge.reply` 在 `whenIdle` 后若检测到代际变化则丢弃该消息不 followup。**→ 已由下方「busy 消息行为持久化 + /stop 真正丢弃排队消息」实现解决。**

### 术语对齐 WebUI + 修复 latest-harness CI typecheck（`src/index.ts`）

- **术语对齐**：把 `/status` 的 `Queue mode:` 改为 **`Enter while busy:`**（WebUI `ui-conversation` 设置名「Enter behavior while busy」），值显示为 `Queue` / `Steer`（WebUI 选项文案）；`/busy` 无参/切换文案也改用「运行中（busy）的 Enter 行为」「排队发送 / 插话发送」的说法。命令 `/busy` 与机器值 `queue`/`steer` 保持（与 DSH 内部 `busyEnter`/`BusyEnterBehavior` 概念一致）。
- **CI 修复**：`ci.yml` 的 **latest-harness** 矩阵在 typecheck 报 `'credentials/updated'` 不属于 `keyof Events`——新 Harness 把凭据变更事件从 `credentials/updated` 改名为 **`credentials/reference-updated`**。插件改为用宽松 cast 同时注册两个事件名（`ctx.on` 对不存在的事件只是永不触发，无副作用），typecheck 在 locked(rc.7)/latest 两个矩阵都通过，且 latest 下凭据变更触发 reconcile 的功能恢复（之前静默失效）。

### `/status` 显示队列模式（`src/index.ts`）

- **背景**：`/status` 已显示权限模式，但看不到当前 busy（队列）行为。用户在飞书切了 `/busy queue|steer` 后想在 `/status` 一眼确认。
- **实现**：`/status` 解析 `bridge.busyMode(chatMessage)`，卡片新增 `**Queue mode:** \`queue\` 📥 / \`steer\` 🎯 行。

### busy 消息行为（`queue`/`steer`）持久化 + `/stop` 真正丢弃排队消息（`src/harness.ts` / `src/channel.ts` / `src/index.ts`）

- **背景**：上一节把 `/stop` 记为了"丢弃排队消息未完全生效"的已知限制，根因是飞书 `bridge.reply` 先 `await whenIdle()` 再 `followup`，消息在等待期间不在 inbox，`keepInbox:false` 清不掉。同时用户希望能在飞书把"运行中发消息"的行为切为 **steer（注入当前 turn）** 并持久化，而非总是排队。
- **实现**：
  - **持久化 per-chat busy 模式**：`HarnessConversationService` 新增 `chatToBusyMode: Map<chatKey, 'queue'|'steer'>`（默认 `queue`），随 `chatToSession` 一起存进 `lark-session-map.json`（`saveSessionMap`/`loadSessionMap` 读写 `busyMode` 字段），重启后保留。方法：`busyMode(message)` 查询、`setBusyMode(message, mode)` 设置并持久化。
  - **`bridge.reply` 按模式分支**：`busyMode==='steer'` 且 agent 运行中 → 立即 `agent.steer(msg)` 注入当前 turn，`whenIdle` 等运行轮（含 steered step）结束再汇总；否则走 queue 路径（先等 idle 再 followup）。
  - **`/stop` 真正丢弃排队消息**：`stopSession(message)` 先把该 chat 的**停止代际+1**，再 `agent.cancel({kind:'user'},{keepInbox:false})`。`bridge.reply` 的 queue 路径在 `await whenIdle()` 后检查代际——若 `/stop` 在等待期间发生则丢消息、抛 `TurnDroppedError`（不再 followup 开新 turn）。channel 对 `TurnDroppedError` 静默丢弃（不报错卡片）。**`/stop` 已知限制已解决。**
  - **新增 `/busy [queue|steer]` 命令**（`index.ts`）：无参显示当前 busy 行为，带参切换并持久化；一次性注入仍用 `/steer <内容>`。

### `/stop` 命令报 "no code" 修复（`src/index.ts`）

- **症状**：执行 `/stop` 恒失败，飞书回 `⚠️ 停止失败: unknown error (no code)`。
- **根因**：`sessionController.cancel` 成功时返回 `{ accepted: true }`，失败路径**直接 throw**（`TypertRemoteFailure`，如 `session-not-found`），而非旧 apiproxy `sessions.cancel` 那种 `{ ok: boolean; error: { code, message } }` 包。插件却按 `{ ok, error }` 解析——`response.ok` 恒为 `undefined`（真值判断为 false），于是永远落进错误分支，`response.error?.code` 也是 `undefined`，拼出 `(no code)`。
- **修复**：改为检查 `response.accepted === true` 判成功；失败改由 `catch` 捕获，`session-not-found` 单独映射为"该 session 当前没有运行中的 agent，无需停止"，其余用 `errorText(error, ...)` 带出具体原因与错误码（复用上一条改动）。

### 报错消息带具体原因/错误码（`src/error-text.ts` / `src/channel.ts` / `src/feishu-send-file.ts`）

- **症状**：插件任何环节出错（agent turn 失败、图片拉取失败、斜杠命令执行失败、发文件失败）都在飞书回一条**统一道歉文案** `errorMessage`（"抱歉，处理这条消息时遇到了问题，请稍后重试。"），用户不知道到底哪里出了问题。
- **修复**：
  - 新增 `src/error-text.ts` 的 `errorText(error, fallback)`：提取 `error.message`（非 Error 则 `String(error)`），错误带数字 `code` 时追加 `(code: N)`（并去重——消息里已含 code 就不再重复），无可用信息时回退 `fallback`，超 600 字符截断。
  - `src/channel.ts` 的 4 处统一道歉改为带前缀的具体原因：`命令执行出错：<原因>`、`图片处理出错：<原因>`、`处理这条消息时出错：<原因>`（×2，覆盖 agent turn 失败与 dispatch 同步失败）。`errorMessage` 仅作为确实无原因时的兜底。
  - `src/feishu-send-file.ts` 的 caption 与文件 `ch.send` 包上 `.catch` 重抛：`Failed to send "<file>" via Feishu: <原因> (code: N)`，让飞书 API 错误码（如 230021 超过大小上限）直接透传给 agent 汇报。

### 问题/审批卡片不显示修复（`src/feishu-questions.ts` / `src/feishu-approvals.ts`）

- **症状**：模型调 `ask_user_question` 时飞书侧收不到问题卡片，agent 一直等到信号中断返回「ASK_ABORTED」（approval 卡片同理）。
- **根因**：0.1.2-alpha.1 的 `user-questions/request` / `approval/request` 是 **agent-scoped waterfall**。`api-remotes`（WebUI BFF）在 boot 时对这两个事件也注册了 waterfall listener，且是**先注册**（最外层）。它在 `forwardWaterfall` 里把请求推给 WebUI 客户端并**阻塞等待 WebUI 回答**；飞书 listener 是**后注册**（内层），只有当外层调用 `next()` 时才会执行——而 WebUI 一直没回答，`next()` 从未被调用，飞书 listener 永远到不了，卡片自然不渲染。旧 apiproxy mux 是**并行广播**（WebUI 与飞书同时收到、先答先赢），迁移成 waterfall 后变成顺序链路，飞书被卡在 WebUI 之后。
- **修复**：飞书 listener 改用 `ctx.on(event, handler, { prepend: true })` 注册，成为 waterfall **最外层**，先于 `api-remotes` 认领。`handleRequest` 只在 session 绑定到当前飞书 chat 时才认领（`resolveChat` 命中）；未绑定的 session 照常 `next()` 回退给 WebUI answerer，两个 UI 按实际使用入口各司其职。

### `ask_user_question` 多问题顺序迭代（`src/feishu-questions.ts`）

- **症状**：一次 `ask_user_question` 传多个问题时，飞书只渲染并回答了**第一个**问题，其余被静默丢弃（返回答案只含第 1 问）。
- **根因**：`presentQuestions` 写死了 `const question = questions[0]!`，答完第一问就返回整个批次，注释声称"iterates sequentially"但实现从未迭代。
- **修复**：`presentQuestions` 改为**逐个问题顺序渲染**——答完一题自动出下一题卡片，跳过也产出空选择项，最终返回 `{ answers: [q1, q2, ...] }` 整批答案（与 WebUI 的整批编码对齐）。请求中止或卡片发送失败时中断并返回已累积部分。
- **调试**：`[q]` 系列日志从 `logger.info`（被 DSH 日志级别过滤、journal 看不到）改为 `console.log`（直出 stdout/journal），便于验证渲染路径。

### 文件接收（`src/channel.ts`）

- **收文件**：飞书聊天发送文件（`msg_type: 'file'`，标准化后资源 `type === 'file'`）时，插件通过 `im.v1.messageResource.get({ params: { type: 'file' }, path: { message_id, file_key } })` 下载文件字节，并写入 `~/.dsh/feishu-inbox/`（`DSH_HOME`）下的持久目录。
- **注入消息内容**：下载成功后，把 `[文件: <fileName> → <absPath>]` 追加进 `inboundMessage.content`，让 agent 能通过文件工具读取该路径。下载失败仅记日志、不阻断消息（agent 仍收到原始 `<file .../>` 标签）。
- **为什么不用 `/tmp`**：channel service 与 agent 工具沙箱的 `/tmp` 是隔离的 mount，插件写入 `/tmp` 的文件 agent 读不到；`~/.dsh/feishu-inbox`（`DSH_HOME`）是真实磁盘目录，两侧都能访问。下载目录懒创建。
- **依赖**：新增 `node:fs/promises`（`mkdir`/`writeFile`）、`node:os`（`homedir`）。

### agent 主动发文件工具 `feishu_send_file`（`src/feishu-send-file.ts`）

- **背景**：DSH 本身没有"agent 往客户端 push 二进制文件"的原语——agent 只是把文件写进工作区，WebUI 靠 `ui-deliverables` 自动检测 `write`/`edit`/`str_replace_editor` 产出并渲染成可点击链接；飞书此前没有等价物，agent 写的产物文件在飞书侧只能靠回复文本里的路径让用户自己去翻。
- **实现**：注册 host 全局 model tool `feishu_send_file`（`ctx.tools.register(defineTool(...))`，参数 `path` 必填 + `caption` 可选）。执行时：`exec.agent.id` → `bridge.resolveChat(sessionId)` 反查所属 chat（复用 `feishu-questions.ts` 的同一反向映射）→ 本地校验（存在/常规文件/非空/≤30MB）→ `channel.send(chatId, { file: { source, fileName } }, opts)` 由 SDK 内部走 `im.v1.file.create`（`file_type: 'stream'` 通用桶）+ file 消息，话题回复复用 `replyTo`/`replyInThread`。
- **未绑定会话降级**：WebUI 直接创建的 session 调 `resolveChat` 返回 `undefined`，工具返回明确错误，提示 agent 改用文本告诉用户路径。
- **约束**：Feishu 文件消息上限 30MB、不允许空文件；`file_type` 固定 `stream`（SDK `send({file})` 路径行为），任意扩展名可发，但超大文件/目录需先压缩拆分。
- **依赖**：新增 `@deepseek-ai/dsh-tools`（peerDep + devDep）；`inject` 数组加 `'tools'`。

### 适配 DSH 0.1.2-alpha.1（`@deepseek-ai/dsh-api-session-controller` 等新 capability seam）

- **删除 apiproxy 依赖**：`@deepseek-ai/dsh-host-apiproxy` 整包在 0.1.2-alpha.1 删除（`refactor(api): remove ApiProxy package`），所有 `ctx.apiProxy.events.mux()` / `apiProxy.respond()` / `apiProxy.sessions.selectModel()` 调用全部替换：
  - **events 订阅**（5 个文件：`feishu-todos.ts` / `feishu-streaming.ts` / `feishu-toolcalls.ts` / `feishu-questions.ts` / `feishu-approvals.ts`）：从 `for await (const envelope of apiProxy.events.mux(...))` 改为 `ctx.on('session/event', (session, event) => { ... })`。`(session, event)` 直接给 session 和 event 对象，无需拆 envelope / frame。
  - **user-questions 答案**：从 `apiProxy.respond({ type: 'client-response', rpcId, result })` 改为 `ctx.on('user-questions/request', async (req, next) => { ... return answer })` listener，listener 内部 await cardAction 回调后 return 答案；plugin 在 `apply()` 时注册 listener，return 答案即 claim 请求（默认 tool-ask-user provider 不会看到）。
  - **approval 答案**：从 `apiProxy.respond({ ... outcome })` 改为 `ctx.on('approval/request', async (req, next) => { ... return 'allowed-once' | 'rejected' })` listener，return outcome 即 claim。`scopeTarget(req.agent, req.agent)` 由 user-approval service 内部限定，plugin 不需要 scope 逻辑。
  - **selectModel**（`feishu-model-select.ts` + `commands.ts`）：从 `apiProxy.sessions.selectModel({ payload })` + `agentDefaultModel.saveSelection` + `bridge.setCurrentSelection` 三步法改为 `ctx.sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })` 一站式——`sessionController` 内部 `resolveAgent`（恢复 session）+ `resolveCallConfig`（校验）+ `agents.selectForNextRequest(agent, ref)`（写 agent scoped ref，WebUI 立即看到）+ `agentDefaultModel.saveSelection`（持久化）一次性完成。
- **删除 plugin 自己的 selection 缓存**（`harness.ts`）：`selections: Map<string, LiveSelection>`、`setCurrentSelection()`、`currentSelectionFor()`、`installModelSelection()` 调用、`LiveSelection` interface 全部删除——`ApiSessionAgentController` 内部 `WeakMap<Agent, InstalledSelection>` 已经替它做，plugin 不再需要 mutable ref。`getSessionMeta` 改用 `request/header` 事件（更权威的源）+ `agentDefaultModel.currentSelection()` fallback。
- **inject 数组**（`index.ts`）：`'apiProxy'` 替换为 `'sessionController'`, `'userQuestions'`, `'approval'`；`/stop` 命令改用 `sessionController.cancel({ sessionId })`。
- **依赖变化**（`package.json`）：删 `@deepseek-ai/dsh-host-apiproxy` peerDep / devDep；加 `@deepseek-ai/dsh-api-session-controller` + `@deepseek-ai/dsh-user-approval` peerDep / devDep。
- **测试**：mock `apiProxy.events.mux()` 异步迭代器改为 mock `ctx.on('user-questions/request', listener)` 同步注册 + `ctx.on('session/event', ...)` 同步 trigger；新增 `fakeSessionController()` 测试 helper。132 tests pass。
- **已知降级**（可接受）：
  - `tool/result` 事件的 `event.data.meta` 是 tool-private 呈现数据（对应之前的 `frame.view?.for === 'result'`），plugin 用它作 resultView。`tool/call` 事件没有 view 字段，callView 永远 undefined（`renderStepCard` fallback 到工具名 + args）。
  - `ctx.sessionController.selectModel` 内部走 `commands.selectModel` → `resolveAgent`（force resume）。对**未聊过**的 session 调 `/model` 会**强制创建 agent**（`resolveAgent` 在 `sessionPersistence.list()` 找到该 sessionId 时会 resume；找不到时 reject）。这是接口语义变化——之前 plugin 调 `setCurrentSelection` 不会创建 agent；现在会。如果想保持旧行为，未来可拆分为"createSessionController vs selectModel"两套 API。

### 工具调用展示（`src/feishu-toolcalls.ts`）

### 工具调用展示（`src/feishu-toolcalls.ts`）

- 订阅 apiproxy mux 的 `tool/call` + `tool/result` 事件，在飞书侧展示模型的工具调用过程。
- **原地更新**：`tool/call` 发送卡片后保存 `messageIdPromise`，`tool/result` 等待 `messageId` 后用 `updateCard` 更新同一张卡片（蓝色→绿色/红色），不再发两张独立卡片。
- 消除竞态：`tool/call` 直接发送（不走批量队列），确保 `messageId` 在 `tool/result` 到达前可用。
- 使用 Card JSON 2.0 格式，内联代码（反引号）正常渲染。

### Todo 展示（`src/feishu-todos.ts`）

- 订阅 apiproxy mux 的 `todo/write` 事件，展示 agent 的任务进度。
- 绿色卡片，含进度条（完成数/总数）和状态图标（⬜ 待办 / 🔄 进行中 / ✅ 完成）。
- 500ms debounce。

### 回复卡片消息（`src/channel.ts`）

- 每轮最终结果渲染为飞书 interactive card（蓝色 header "Assistant"），替代原来的纯文本消息。
- **全面迁移到 Card JSON 2.0**（`schema: '2.0'` + `body.elements`），原生支持表格、标题、内联代码（反引号）、代码块等完整 markdown 语法。
- 不再需要 `needsPlainTextFallback()` 降级逻辑——所有回复统一走卡片。
- `note` 标签（2.0 不支持）替换为 `markdown` + `text_size: 'notation'`，footer 视觉效果保持一致。
- 底部 footer 自动注入当前 session 的 workspace + preset + model + reasoning + context 信息。
- 空回复显示 `(empty response)` 占位。

### Session 映射持久化（`src/harness.ts`）

- `/new` 和 `/thread` 的 chat→session 映射现在持久化到 `~/.dsh/lark-session-map.json`，dsh 重启后自动恢复。
- 之前映射仅存内存，重启后 `/new` 创建的新 session 会丢失，回退到确定性 hash（旧 session）。
- 使用 `os.homedir()` + `/.dsh` 作为 `DSH_HOME` 的 fallback，解决 systemd 用户服务不继承 shell 环境变量的问题。

### `/status` 命令

- 新增 `/status` 命令，直接在 `executeSlashCommand` 中处理（不需要 live agent），返回飞书 interactive card。
- 显示字段：session id、title、workspace、preset、model、activity（turns/steps/tool calls）、tokens（input/output）、context 使用率。
- 数据从 `sessionPersistence.readFrom()` 读取 session header + events，不经过 LLM。

### `/new` 和 `/thread` 不再依赖已有对话

- `/new` 和 `/thread` 现在可以在没有 live agent 的情况下使用（直接在 `executeSlashCommand` 中处理）。
- 之前需要先发一条普通消息创建 session 才能用 `/new`，现在可以直接用。

### 卡片结构修复

- **所有飞书卡片**全面迁移到 **Card JSON 2.0** 格式（`schema: '2.0'` + `body.elements`），原生支持表格、标题、内联代码等完整 markdown 语法。
- `note` 标签（2.0 不支持）替换为 `markdown` + `text_size: 'notation'`。
- `feishu-approvals.ts` 审批卡片同步修复。

### `harness.ts` — persisted session 跳过 `attachSession`

- 已持久化的 session（在 `sessionPersistence.list()` 中）resume 时跳过 `workspace.attachSession()`。
- 之前 `attachSession` 会因 session 的 `cwd` 与当前 workspace 不匹配而失败（例如旧 session 在父 workspace 下创建），导致整个 `bridge.reply()` 崩溃。

### `conversation.ts` — `summarizeTurn` 健壮性

- turn 成功完成但只有 tool calls 没有文本时，返回 `{ text: '(no text response)', ok: true }` 而非失败。
- `event.data?.message` 和 `event.data?.reason` 增加 null safety。

### 定位与范围（2026-08-23）

- **定位变更**：从"飞书 channel 插件"改为 **"把 DSH 的原生特性接入飞书，而非再造一个 agent 平台/助手"**（详见 AGENTS.md「定位」）。不做 openclaw / hermes 式 24h 常驻助手；DSH 才是 agent 本体，本插件只做"DSH 原生特性 → 飞书聊天"这层接入。
- **本轮需求决策**（对应 TODO.md「本轮需求决策」）：
  - workspace / agent preset **只在创建新 session 时设定**（`/new --workspace / --preset`，persisted），不运行时热切，全部按 WebUI 原生行为。
  - **每轮最终结果渲染为飞书卡片**，底部注明当前 session 的 workspace + preset；该 footer **不调用 LLM**，插件从 session meta 自动注入。
  - 工作区选择用 **cd 式候选补全**（列子目录候选供选，只目录不文件）。
  - 新增 **`/status`** 命令，展示 WebUI 的 session 全部状态。

### `ask_user_question` 飞书卡片支持

之前模型调 `ask_user_question` 时，问题只在 WebUI 弹出，飞书聊天完全看不到，体验像是“卡住了”。本次让飞书侧也能看见选项并选择：

- 新增 `src/feishu-questions.ts`：订阅 `ctx.apiProxy.events.mux()` 的 `question/requested` 帧，给持有该 session 的飞书 chat 发一张 interactive card（header + 问题正文 + 每条 option 一个 button），收到 `cardAction` 回调后通过 `apiProxy.respond()` 把答案打回 apiproxy 的 `pendingQuestions`。WebUI 与飞书同时看到同一个问题，谁先答谁赢（共享同一份 `pendingQuestions`）。
- 走 mux 订阅而不是 `ctx.userQuestions.registerProvider()`：DSH 的 user-questions seam 是单例 provider slot，apiproxy 已经注册了；走 mux 订阅是 apiproxy 文档化的 fan-out 路径，与 WebUI 客户端用的是同一条，无需修改 DSH。
- `bridge.resolveChat(sessionId)` 反向查表：把 session id 映射回 chat 坐标（含 `/new` / `/thread` 覆盖）。`startChannel` 现在返回 `{stop, channel}`，`LarkRuntime` 暴露 `onChannelChange` 回调，让 questions listener 在 channel reconcile 后自动重新挂 `cardAction`。
- `inject` 数组新增 `'apiProxy'`；`peerDependencies` / `peerDependenciesMeta` / `devDependencies` 增加 `@deepseek-ai/dsh-host-apiproxy` 和 `@deepseek-ai/dsh-user-questions`（`rc.5`/`rc.7`）。CI workflow 的 `latest-harness` 步骤同步加入两个新包。

### `ask_user_question` 自定义回答 + 跳过（Card JSON 2.0 form 容器）

- **Card JSON 2.0 迁移**：所有问题卡片和审批卡片迁移到 v2 格式。v2 不支持 `action` 容器标签，按钮直接放在 `body.elements` 中，使用 `behaviors` 代替顶层 `value`。
- **Form 容器自定义回答**：用 `form` 容器 + `input` + `submit` 按钮实现卡片内自定义输入，替代之前的消息拦截方案。form 按钮使用 `form_action_type: "submit"` + `name`，通过 `includeRawEvent: true` 从 `evt.raw.action.form_value` 读取输入值。
- **跳过按钮**：卡片底部新增「⏭️ 跳过本题」按钮，提交空答案。
- **Settled 卡片**：选中选项用 ✅ 标记（无删除线），自定义回答显示「✅ 自定义回答：xxx」，跳过显示「⏭️ 已跳过」。
- **提示文字**：输入框上方显示「以上选项都不满意？在下方输入你的自定义回答：」引导用户。
- **`includeRawEvent: true`**：channel.ts 启用原始事件传递，使 `form_value` 可用。
- 删除 `messageInterceptors`、`onMessageInterceptor`、`pendingCustomInputs` 等消息拦截相关代码。

### `/model` 同步到 WebUI

- **问题**：飞书 `/model` 切换后，飞书侧 `/status` 和 Turn Complete 卡片显示新模型，但 WebUI 显示旧模型，实际生效的也是旧模型。
- **根因**：WebUI 通过 `apiProxy.selections`（`WeakMap<Agent, WebModelSelectionRef>`，由 `apiProxy` 的 `selectionFor()` 维护）读取当前模型；飞书插件用自己的 `bridge.selections`（`Map<sessionId, LiveSelection>`）读取模型。飞书 `/model` 只更新了 `bridge.selections` 和全局 settings，没有调用 `apiProxy.sessions.selectModel(...)` 同步更新 WebUI 的 selections Map。
- **修复**：`handleModelCommand` 在调用 `agentDefaultModel.saveSelection()` 和 `bridge.setCurrentSelection()` 之后，额外调用 `apiProxy.sessions.selectModel({ payload: { sessionId, provider, model, reasoningEffort? } })`，让 `selectionFor(agent).current = selected` 同步生效。
- `bridge.resolveSessionIdFor` 和 `bridge.resolveAgent` 暴露给 commands；`registerLarkCommands` 新增可选 `apiProxy` 参数，未配置 apiProxy 的部署自动降级到原有行为（settings + bridge selections 仍生效）。
- 调用 `apiProxy.sessions.selectModel` 失败时不影响主流程（model 已落 settings + bridge selections，下次 assemble 会生效）。
- **同 bug 复现于 `/reasoning`**：`/think`、`/reasoning high` 等切换 reasoning effort 也有同样的问题（飞书侧切换成功，WebUI 不变，实际也不生效）。`handleReasoningCommand` 同样在 `saveSelection` + `setCurrentSelection` 后调用 `apiProxy.sessions.selectModel({ payload: { sessionId, provider, model, reasoningEffort: level } })`，保持 `selectionFor(agent).current.reasoningEffort` 同步。

### 测试

- `tests/feishu-questions.spec.ts` 新增 6 个用例：点选项后 answer 经 `apiProxy.respond` 上报、自定义回答从 `form_value` 读取、空输入忽略、忽略不匹配的 rpcId、跨 chat session（不是本插件持有的 chat）跳过渲染、`stop()` 清掉 `cardAction` handler。
- `tests/runtime.spec.ts` 适配 `LarkRuntimeStart` 返回值（`{stop, channel}`），所有 reconcile / dispose / credential-change 用例继续过。
- `tests/plugin.spec.ts` 适配 `startChannel` 新返回值（`const { stop } = await startChannel(...)`）。
- `tests/plugin.spec.ts` 的 `IMAGE_LIMITS` 增加 `maxImageDimension`（DSH attachment rc.8 必填）。

### 兼容性

- 适配 DeepSeek Harness `0.1.0-rc.7`（2026-08-18 升级）：移除对 host-plane `compaction` 服务的依赖（rc.7 的 preset 架构把 `compaction-basic` 移进了 per-session preset realm，host 平面不再有全局 `compaction`）。

### 命令注册

- 移除 `/compact` 命令（飞书聊天内）：与 DSH 自带 `command-compact` 插件同名（`name: "compact"`），DSH 启动时两个注册会抛 `command "compact" is already registered` 导致插件崩溃、boot 失败。DSH web UI 仍可通过 DSH 自带 `command-compact` 使用 `/compact`。
- `/model`、`/stop` 保留。
- `inject` 数组去掉 `'compaction'`；`apply()` 中不再 `ctx.get('compaction')`；`executeSlashCommand` 不再传 `_compaction` 参数。

### dsh 启动必需配置

- `~/.dsh/profiles/web/cordis.patch.yml` 必须启用 `compaction-basic` + `command-compact`（拉回 host plane），否则 DSH 自带 `/compact` 命令在 web UI 上也不可用。
- 启用 `lark-channel`（无特殊要求，前提是上方 `command-compact` 已启用）。

### 命名与仓库迁移

- GitHub 仓库：`Starxer/dsh-feishu`（fork）→ `Starxer/dsh-feishu`（独立仓库）
- npm 包名：`@starxer/ds-feishu` → `@starxer/dsh-feishu`
- 本地目录保留 `workspace/dsh-feishu`（不改名，避免影响 `~/.dsh/profiles/web/package.json` 的 pnpm link 路径）
- 与上游分叉：移除 `/compact` 命令与上游设计哲学冲突，无法反向合并回 upstream

### Bug 修复

- 备份与临时文件清理：删除了 `src/commands.ts.bak.*` 和 `src/index.ts.bak.*`（编译时调试产物，已 gitignore 防止再次产生）。

## Unreleased

- Add an emoji reaction (`reactEmoji`, default `THUMBSUP`) to each inbound message as an immediate acknowledgement; set it to an empty string to disable. A failed reaction logs a warning without blocking the reply.
- Register three chat-side slash commands that bridge into the Harness command plane: `/model` (show, list, fuzzy-search by keyword, or switch the active default model through Harness Settings), `/compact` (call `ctx.compaction.compactNow()` against the chat's existing Agent), and `/stop` (call `agent.cancel({ kind: 'user' })` to abort the running turn). `/model` and `/compact` require that the chat has sent at least one ordinary message first so a session already exists.

## Unreleased — 飞书 slash 命令与 session 切换

### 新增命令

- `/new`：在当前 chat 内创建一个全新的 session，下次普通消息落到新会话；旧 session 保留在 agents registry。
- `/thread`：列出本 workspace 所有 persisted sessions（按 `session/title` 显示最新标题、`updatedAt` 粗粒度相对时间 + session id），并支持 `/thread N` 切到第 N 个。session id 来源：`sessionPersistence.list()` + live agents events。
- `/thread` 列表与 WebUI 行为对齐：
  - 隐藏 `workspaceRegistry.archivedSessionIds` 里的归档 session；
  - 隐藏 live blank session（DSH 自动创建、从未发过 user message）；
  - cold session 通过 `readFrom(id, 0)` 读 `session/title` 与 `turn/start` 事件，避免重复标题误读；
  - `/thread N` 命中归档 session 时返回 `threadArchived` 错误，提示用户在 web UI 取消归档。
- `/help`：通过 `ctx.commands.list(agent)` 列出该 agent 当前可用的所有 slash 命令（包括 DSH 自带的 `compact` / `goal` / `feedback` / `export` 与本插件注册的 `model` / `new` / `thread`），每条命令附 description 与可选 input hint（`[<hint>]`）。DSH 自带的命令无需在本插件二次注册即可被飞书用户发现与触发。

### `/model` 命令行为变更

- 切换成功后区分 `modelLiveApplied`（chat 已有 live agent，立即生效）和 `modelPersisted`（仅落 settings，下次创建 session 时生效）。
- `harness.ts` 的 reuse 路径 bug 修复：dsh 重启后 `selections` 缓存丢失，原本无法再次挂 `installModelSelection` 到 live agent 的 ctx；现在 reuse 时若 `selections.get(sessionId) === undefined` 会重新挂一次 ref，`/model` 切换真正生效。
- `commands.execute` 修复：`commands.execute(agent, line, images, signal)` 四参数签名，之前少传了 `images: []` 导致 4 参错位（controller.signal 被当成 images 数组）。

### 测试

- `tests/commands.spec.ts` 从 8 个用例扩到 18 个，覆盖 `/model` live/persisted 切换、`/new`、`/thread` 列表（含 archived + blank 过滤）、`/thread N` 切换（合法/越界/非数字/archived）、相对时间桶（just now / Nm / Nh / Nd / unknown）。
- `tests/harness.spec.ts` 从 7 个用例扩到 11 个，覆盖 reuse-path 挂 selection ref、`/thread` archived 过滤、`switchToSession` 拒绝归档、`/model` 切换写入 ref.current。
- `tests/commands.spec.ts` 新增 4 个 `/help` 用例：列表所有 descriptor、带 input hint 的渲染、空列表、忽略多余 rawInput。
- `tests/plugin.spec.ts` 新增 3 个图片消息用例：下载 image 资源 + 注入 ImageBlock、缺 attachment service 时拒绝、保存失败走 safe fallback。
- `tests/harness.spec.ts` 新增 5 个用例：文本+图片 mixed turn、纯图片 turn、空消息拒绝、`[Feishu]` 前缀对纯文本 / mixed / image-only 三种 turn 的覆盖。

### 飞书图片消息支持

- `inject` 数组新增 `'attachments'`；启动时 `ctx.get('attachments')` 必填，部署未带 `dsh-attachment-local` 时启动失败。
- `channel.ts` 在消息处理前先把 `resources` 里的 image 资源经 `channel.rawClient.im.v1.messageResource.get({message_id, file_key})` 下载成字节（注意：`LarkChannel.downloadResource` 走的是 `im.v1.image`，那是机器人自己上传的 key，用户消息里的资源走 `im.v1.messageResource`，两者 API 不同），再调 `attachments.saveImage()` 拿到 `ImageAttachmentRef[]`，交给 bridge。
- `harness.ts` 的 `reply` 接受可选 `imageBlocks` 字段，构建 user-turn content 时按顺序追加 `{type:'text', text}` + `{type:'image', attachment}`，符合 `ContentBlockMap` 合并扩展约定。
- 缺图片附件服务或图片 admission 失败时，回复一条用户可见错误文本（不动 bridge，不把空消息当成普通 turn）。
- 每条 user turn 的文本前面自动加 `[Feishu] ` 前缀，让模型（和 session log）能区分消息来自 Lark channel 还是 webui 客户端；纯图片消息把 `[Feishu] ` 单独作为一个 text 块放在 image 块之前（而不是塞到 caption 里），保证 LLM 一定能看到来源 tag。

## 0.2.2

- Restore npm 12 lockfile entries required for clean Linux CI installs.

## 0.2.1

- Mark Harness-provided peer dependencies as optional for package-manager resolution, avoiding misleading missing-peer warnings in DSH Profiles.
- Keep the supported Harness range starting at `0.1.0-rc.6` while validating development and release builds against `0.1.0-rc.7`.
- Add continuous compatibility checks against the latest published Harness packages.

## 0.2.0

- Contribute an embedded **Feishu & Lark** section to Harness Settings through the plugin web client.
- Require same-origin browser requests for settings and credential mutations.
- Store App Secret through Harness Credentials using `DSH_LARK_APP_SECRET` by default.
- Apply Settings and credential changes by replacing the Lark channel without restarting Harness.
- Keep the plugin active but idle until required application credentials are configured.
- Show explicit configured and missing App Secret states without returning the secret to the browser.
- Populate linked Provider and Model selectors from the current Harness model catalog.
- Resume persisted Lark sessions after restart and reuse an already-live Agent when available.
- Print initial connection, channel, and message-handling failures to the terminal as well as the Harness logger, with App Secret redaction.
- Remove the generic configuration-file action from the Lark-focused Settings experience.

## 0.1.1

- Mount the Harness default or configured Agent Preset for Lark sessions.
- Associate Lark sessions with an explicit Workspace or the first registered Workspace.
- Start corrected sessions with a v2 identity so legacy uncomposed sessions are not reused.

## 0.1.0

- Initial Feishu/Lark WebSocket Channel integration for DeepSeek Harness.
- Stable chat/thread to Harness Session mapping.
- Official SDK policy, deduplication, stale-event filtering, and per-chat queue reuse.
