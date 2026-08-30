# Changelog

## Unreleased

### 中英双语 i18n：`locale` 设置 + `/lang` + 命令/卡片层双语（`src/i18n.ts` 等）

- **语言源**：新增插件 `locale` 字段（`auto`/`zh`/`en`，默认 `auto`）。`auto` 时读 DSH host 侧 `settings.get('locale').preference` 的浏览器语言偏好（由 `@deepseek-ai/dsh-client-locale` 注册的 `'locale'` namespace），无值回退 `zh`。`/lang [zh|en|auto]` 切换并持久化（`auto` unset 字段回到跟随 DSH），`/lang` 无参显示当前与来源。
- **命令层**：把原单一英文实现 `larkCommandTranslations` 拆成 `zh`/`en` 两份（`src/commands-i18n.ts`，`CommandTranslations` 接口不变），模块级 `activeCommandTranslations` 随 locale 同步；`/model` `/reasoning` `/help` `/approve` `/deny` `/approvals` `/new` `/session` `/detach` `/status` 等命令文案即时按语言切换。
- **卡片层**：`feishu-busy` / `feishu-permission` / `feishu-model-select` / `feishu-session` / `feishu-onboarding` / `feishu-questions` / `feishu-streaming`（per-step 卡）/ `channel.ts`（Turn Complete footer）/ `renderStatusCard` 的硬编码文案抽成 `Translations` 字典（`src/i18n.ts` 的 `Translations` 接口 + `zh`/`en` 两份，`satisfies` 类型校验两侧键集一致）。
- **卡片层动态 getter（关键）**：卡片层不是把 `t` 作为启动时**值快照**传给 `start*` 工厂（那样 `/lang` 切换后 `/new`/`/busy`/`/session` 等卡不跟随，实测维持值快照时的语言），而是 `getTranslations: () => Translations` **getter**，每次渲染卡时动态读当前语言。命令层用模块级 `activeCommandTranslations` 同步，`/status`/`/model` 每次调用动态取——三者一致，`/lang` 后新发卡片立即切换语言。
- **术语对齐 DSH**：`Agent 预设` / `会话` / `工作区` / `推理强度` / `工具调用` / 权限 `仅可查看`/`可写入工作区`/`完全权限`；模式短标签（`Queue`/`Steer`，权限枚举值、`Enter while busy`/`Permission` 标题）两种语言均保持英文（对齐 WebUI 固定命名）。
- 测试：`npm run test` 191 通过；`npm run typecheck` 干净；`npm run build` 产出 lib/client。

### 兼容 DSH `0.1.2-alpha.2`（`src/index.ts` / `src/feishu-onboarding.ts`）

- **`settingsNamespace` 从 `@deepseek-ai/dsh-settings` 移除**：alpha.2 删掉了 `settingsNamespace`（连同 `installSettingsSection`/`deepEqualJson`），改成内部 `parseSettingsNamespace`，且 `settings.register()` 新签名**直接接受字面量字符串**（内部校验 kebab-case）。原代码 `settingsNamespace(LARK_SETTINGS_NAMESPACE)` 在 alpha.2 会 `TypeError: settingsNamespace is not a function` 导致起不来。
  - **改法**：`settingsNamespace(LARK_SETTINGS_NAMESPACE)` → `LARK_SETTINGS_NAMESPACE as SettingsNamespace`（`register` 直接收字面量；`as SettingsNamespace` 仅补 alpha.1/alpha.2 都需要的 brand），`import { settingsNamespace }` 改为 `import type { SettingsNamespace }`。
  - **双向兼容**：alpha.1 运行时 `register` 把 namespace 当纯字符串 key（brand 仅编译期），传字面量运行时等价；`as` cast 在构建时被编译掉，所以 `lib/index.js` 对 alpha.1/alpha.2 是同一份。alpha.1 启动验证通过，alpha.2 就绪（待升级后实测）。
- **preset 选择卡显示名 `title` → `name`**（`renderPresetPicker`）：`AgentPreset` 类型从未有 `title`（只有 `name?/id`），原代码 `preset.title ?? preset.id` 一直回退到裸 id。改为 `preset.name ?? preset.id`，吃 alpha.2 的 localized shipped preset names。

### 插件更名：`dsh-feishu` → `chatterbox4dsh`（2026-08-30）

- **背景**：生态里已有 13 个同名 `dsh-feishu` 仓库 + 大量 `dsh-lark*` 变体，命名严重饱和、难区分。为跳出同名簇并突出差异化，改用「唠叨话痨」意象的独立品牌名。
- **改名**：`@starxer/dsh-feishu` → `@starxer/chatterbox4dsh`（npm 包名）；GitHub `Starxer/dsh-feishu` → `Starxer/chatterbox4dsh`（旧链接自动重定向）。
- **命名理由**：`chatterbox`（唠叨话痨）= 把 agent 每一步唠叨给你看（对应 step 级过程透明卖点）；`4dsh`（for dsh）保住 DSH 生态搜索词；`dsh-feishu` 簇彻底隔离。
- **范围**：改 npm 包名 + GitHub repo 名/描述/topics + 文档（README/AGENTS/CHANGELOG）+ 用户可见的 `/help` 分组标题。**插件运行 id `lark-channel` 保持不变**（DSH loader 实际读它，改动风险高）；`/dsh-feishu/settings` 内部路由/日志前缀/CSS 类等内部标识不动（与 web.ts/client 需保持一致）。
- **可发现性兜底**：GitHub topics（`dsh`/`feishu`/`lark`/`deepseek-harness`）+ npm `description` 明确「Feishu/Lark plugin for DSH」。

### 工具调用卡片：args 用代码块防溢出 + 结果兜底展示（`src/feishu-streaming.ts`）

- **args 内联代码块破坏格式/溢出**：原来 `> args: \`${args}\`` 用内联代码，args 含换行/反引号或超长单行时会把卡片 markdown 破坏、内容横向溢出。改为在工具名下方用**独立的 fenced 代码块**渲染 args（` ``` `）——自动换行/滚动，且 `sanitizeCodeblock` 折叠连续反引号、剔除控制字符，避免破坏 fence。
- **工具调用结果不展示**：`renderResultPreview` 里多个分支（terminal / web / search / read / diff / generic）匹配到 `resultView.card` 后**提前 `return`**；若该视图缺关键字段（如 terminal 视图无 `output`），会返回空元素且**不再回退到原始结果**。新增 `finish()` 兜底：任一匹配分支产出空、且有原始结果内容时，改为渲染原始结果的代码块，保证结果始终可见。
- 测试：新增 `renderStepCard` 两项（terminal 视图无 output 时回退原始结果；args 含反引号时落在代码块内）。

本仓库基于 [sugarforever/dsh-lark](https://github.com/sugarforever/dsh-lark) HEAD（`ee639df`）独立维护，**不再跟踪 upstream 同步**。所有改动仅修改本仓库文件，**未对 DSH 源码（`DSH 源码/packages/*`、`vendor/*`）做任何改动**。上游 LICENSE（MIT, Copyright (c) 2026 sugarforever）保留以满足 MIT modified-work 声明。

### `/session` 综合会话管理面板 + `/session list` 表格 + `/help` 卡片（`src/feishu-session.ts` / `src/index.ts`）

- **`/session`（无参）→ 交互式管理卡片**：下拉选择会话（按名称）+ 操作按钮【🔀 切换 / 🔓 detach / 🗄️ 归档 / 🍴 fork / ✏️ 改名】+ 「📋 列表」/「🔄 刷新」。复用 `select_static` + form 提交 + `form_value` 读选中会话 id（同 `feishu-model-select.ts` 模式），走共享 `cardChannel.onCardAction`（跨重连自动重绑）。
  - **切换**（飞书插件能力，`bridge.attachSession` 强制接管）：会话被别的对话占用 → 先弹「接管 / 取消」确认卡；空闲 → 直接 attach。
  - **detach**（飞书插件能力，`bridge.detachSession`）、**归档**（DSH `workspaceRegistry.archiveSession`）、**fork**（DSH `sessionController.fork`）——均先弹「确认 / 取消」卡。
  - **改名走独立卡片**：点「✏️ 改名」弹出专门的改名卡（文本输入新标题 + 确认按钮），提交后执行 `sessionController.rename` 并回结果卡——不再在面板底部放输入框。
  - 结果用绿色结果卡回报；`/detach` 命令撤销（并入面板）。
- **`/session list` → 表格卡片**（会话名 / 短 id / 占用锁 / 最近活跃），原「列 session + 按下标切换」的文本列表被此卡片取代；面板内「📋 列表」按钮复用该表格卡。
- **`/session N`**：保留，按下标快速切换，走同 detach+attach 语义（`bridge.attachSession`）。
- **`/help` → 卡片**：原为文本消息（飞书文本不渲染 markdown），改为把分组帮助内容包进卡片 markdown。
- 归属：切换与 detach 是飞书插件（chat→session 所有权），rename/fork/archive 委派 DSH 既有能力（`sessionController`/`workspaceRegistry`；缺失时给「本部署未启用」提示）。

### `/thread` 命令改名为 `/session`（`src/commands.ts` / `src/index.ts` / `tests/*`）

- **变更**：用户侧命令名 `thread` → `session`（列表会话 / 按 index 切换本 chat 到某个 session）。对应注册名、`executeSlashCommand` 直接分发、`FEISHU_OWNED_COMMANDS`、即帮助渲染的静态元数据一并改为 `session`；内部标识（`threadDescription`/`threadUsage`/`threadList*`/`handleThread*` 等）仍保留 `thread` 前缀以免大范围 churn。
- **用户文案**：`Usage: /thread [N]` → `Usage: /session [N]`；列表头 `reply with \`/thread N\`` → `\`/session N\``。`/help`、即列表、`/detach`（引用列表 index）随之更新。
- **无冲突**：DSH 原生命令只有 `goal`/`feedback`/`compact`，无 `session`/`thread`，改名安全。
- 测试：`commands.spec` 的注册名断言、`item.name === 'session'`、`/session` 文案更新。

### 问题选择卡片：结算后保留问题描述（`src/feishu-questions.ts`）

- **症状**：`ask_user_question` 卡片选择选项（或自定义/跳过）后原地更新，更新后的结算卡片**只显示选项、丢了问题描述**。
- **根因**：`renderSettledQuestionCard` 只重渲 header + `question` + 选项，遗漏了原问题卡片会展示的 `AskUserQuestionItem.detail`（随问题一并展示的支持性描述）。
- **修复**：结算卡片在 `question` 之后补上 `detail`（非空才渲染），与 `renderQuestionCard` 对齐。新增回归测试断言结算卡片 markdown 同时含 detail 与 `✅ **<选项>**`。

### Turn Complete 卡片展示 busy 模式（只读）+ 找回中间步骤卡片的工具调用摘要（`src/channel.ts` / `src/feishu-streaming.ts` / `src/index.ts`）

- **Turn Complete footer 只读 busy**：绿色 Turn Complete 卡片底部 footer 区新增一行 `**Enter while busy:** \`queue\` Queue 📥`（或 `steer` … `🎯`），与 `/status` 一致。`ReplyCardMeta` 新增 `busyMode`，由 `index.ts` 的 `replyCardMeta` 生产者注入 `bridge.busyMode(coords)`。**只读、不放按钮**（按用户澄清）。
- **找回工具调用摘要**：中间步骤卡片（per-step 卡）的工具名上方此前应有的一段「说明要做什么的简短文字」丢失了。经查旧 commit（`046e226`/`f89221b`），旧实现是订阅旧 apiproxy **mux 信封**读 `<frame>.view`（`for==='call'` → `presentCall` 的 `callView`；`for==='result'` → `resultView`）。迁移到 DSH `0.1.2-alpha.1` seam（`8e75f02`）后 mux 信封改为直接 `ctx.on('session/event')`——**`resultView` 半块幸存**（现走 `tool/result` 的 `event.data.meta`），**`callView` 半块丢失**：`presentCall` 在当下 DSH 只被定义、从未被发射（`agent-loop`/`session`/`api/*` 均无发射点），故无法直接复活 `frame.view` 钩子。
- **对齐当下 Web UI**：Web UI 已不再依赖 `presentCall`，改为**从调用 `arguments` 推导摘要**（`packages/client/ui-tool/.../tool-call-model.ts` 的 `classifyTool`+`deriveSummary`）。本插件在 `feishu-streaming.ts` 本地复刻这一纯逻辑为 `deriveToolSummary(toolName, argsRaw)`：按工具名分类（bash/pwsh→bash、read/web_fetch→read、web_search/grep/glob→search、write/edit、run_code→code、cordis_* 等），再按 variant 提取 `description`/`command`/`query`/`path` 等、`search` 多 `queries[]` 取各 query 首行 join、未知工具取第一个字符串字段并回退 args 首行、`others` 且非专属标题时前缀 `工具名 · `。`renderStepCard` 的摘要槽位优先级改为 `callView.description ?? callView.title ?? deriveToolSummary(...)`（保留 `callView`/`resultView` 路径，若上游将来恢复 view 则自动生效）。

### 免会话命令修复：重启后不再要求「先发一条消息」＋真正免会话命令直接可用（`src/index.ts` / `src/commands.ts` / `src/harness.ts`）

- **背景**：`executeSlashCommand` 末尾对未特殊处理的命令统一 `resolveAgent`，拿不到 live agent 就报「needs an existing conversation」。而 DSH 重启后，会话在磁盘（persistence）里、但 live agent 未水合，直到下一次消息才被拉起——于是 `/help`、`/model`、`/reasoning`、`/approvals`、`/approve`、`/deny` 等会话级命令在重启后全部误报「需要对话」。
- **修复**：
  - **恢复冷会话**：`bridge` 新增 `resolveAgentOrResume(message)`——有 live agent 直接返回；否则若该 chat 有持久化会话就**懒恢复**（复用 `createAgent` 的 `resume` 分支），此时才返回 agent；完全没有会话才返回 `undefined`。`executeSlashCommand` 的兜底改用该方法，于是所有「本就有会话」的命令重启后立即可用（`/help`、`/model`、`/reasoning`、`/compact` 等）。
  - **真正免会话命令直接拦截**：`/model list`、`/model <route>`、`/reasoning`、`/approvals`、`/approve`、`/deny`、`/help` 属于部署/持久化层，根本不需要 live agent——在 `resolveAgent` 兜底**之前**直接调用对应 handler（用派生 sessionId 构造极简 invocation）。于是它们**连会话都不需要**（全新 chat 也能用）：`/model list` 列目录、`/reasoning` 读写部署默认、`/approvals`/`/approve`/`/deny` 读/结 pending（无则提示）、`/help` 有 agent 列全量、无 agent 列本插件命令（`renderFeishuCommandsOnly`）。
  - **保持需会话**：`/steer`、`/permission`（落点在 DSH 会话日志）、DSH 原生（`compact`/`goal` 等）仍需会话，兜底未命中时清晰提示；但因为有 `resolveAgentOrResume`，已有持久化会话时它们重启后也能用。
- **实现**：`commands.ts` 导出 `handleHelpCommand`/`handleModelCommand`/`handleReasoningCommand`/`handleApprovalCommand`/`handleListApprovalsCommand`（+`LlmDirectoryLike`/`SessionControllerLike`/`FEISHU_OWNED_COMMANDS`/`FEISHU_INTERCEPTED_COMMANDS`/`renderFeishuCommandsOnly`）；`index.ts` 在 `apply()` 提升 `approvalControl`/`showReasoningControl` 供命令运行时与免会话拦截共用。新增 harness `resolveAgentOrResume` 单测（live/冷会话恢复/无会话三态）。

### `/help` 命令分类：dsh-feishu 插件 / DSH 内置（`src/commands.ts` / `src/index.ts`）

- **背景**：`/help` 原先把 `commands.list()` 的所有命令平铺列出，无法区分哪些来自本插件、哪些是 DSH（或其它插件）自带的。
- **实现**：`handleHelpCommand` 改为分两组渲染：
  - **🔹 dsh-feishu 插件：**按 `FEISHU_OWNED_COMMANDS` 名称集合从 `commands.list()` 中挑出本插件注册的命令。
  - **💠 DSH 内置：**其余（如 `compact`/`goal`/`export`/`feedback` 等 DSH 原生命令）。
  - **补充被拦截的命令**：`busy`/`steer`/`queue`/`permission`/`stop` 是在 `executeSlashCommand` 里直接拦截处理的（不注册、不在 `commands.list()` 里），此前从不出现在 `/help`；现在用 `FEISHU_INTERCEPTED_COMMANDS`（含描述/输入提示）把它们补进 Feishu 组，并对命令 runtime 列出的 Feishu 命令去重（registered 优先）。
  - 组内按名称排序；两组都无条目时才回 `helpEmpty`。翻译新增 `helpFeishuHeader` / `helpNativeHeader`（替换原 `helpHeader`）。

### 移除「Node SDK 过滤 `MessageType.CARD`」补丁（经对照实验证伪）（`package.json` / `scripts/patch-sdk-card-action.sh`）

- **背景**：早期为解决飞书卡片回调，往 `@larksuiteoapi/node-sdk` 打了一个 `postinstall` sed 补丁（`patch-sdk-card-action.sh`），把 WS `handleEventData` 的过滤从 `type !== MessageType.event` 改成也放行 `type === MessageType.card`。
- **纠错**：该补丁的判断（卡片回调以 `type='card'` 到达会被丢弃）**经对照实验证伪**。还原 pristine SDK（`type !== MessageType.event`）后重启，`card.action.trigger` 仍以 `type='event'`（带 `event_type`）到达插件，`/busy`、`/permission`、`/model` 卡片点选全部正常——**帧过滤并不拦它**。真正导致卡片点选无反应的是 `action.value` 双编码解析问题（见下方 `decodeCardValue` 修复）。
- **处置**：删除 `scripts/patch-sdk-card-action.sh`、移除 `package.json` 的 `postinstall`，SDK 还原为官方原版 `1.73.0`（不再改动 gitignored 的 node_modules）。对应 issue（`larksuite/node-sdk` #98/#156/#128/#64）均为「事件名类型缺失」用泛型注册可绕过，未涉及帧过滤。
- **版本**：`@larksuiteoapi/node-sdk` 保持 `^1.73.0`（最新版仍是 1.73.0）。

### `action.value` 双编码修复：`/permission`、`/busy` 卡片点选无反应（`src/card-action.ts` / `src/feishu-permission.ts` / `src/feishu-busy.ts`）

- **症状**：`/permission` 与 `/busy` 的交互式选择卡片，点击按钮**没有任何反应**（卡片不刷新、模式不切换）。
- **根因**：飞书按钮 `action.value` 是**双重编码**的——真实 payload 先 `JSON.stringify`，再作为 JSON 字符串包一层（实测 `value` 形如 `"{\"p\":\"busy\",\"mode\":\"steer\"}"`）。busy/permission 只 `JSON.parse` 一次得到的是字符串，`parsed.p !== 'busy'` 恒成立 → 处理器直接返回。web 端的 model-select 处理器用**多层 parse 循环**已处理此情况，故它正常工作。
- **修复**：新增 `src/card-action.ts` 的 `decodeCardValue(value)`——解包为对象（多层 `JSON.parse`，深度上限 4），在 `feishu-busy.ts` 与 `feishu-permission.ts` 的 `onCardAction` 中统一使用。`decodeCardValue` 导出以便单测（含双编码、更深嵌套、非 JSON 等用例）。

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
