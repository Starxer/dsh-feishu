/**
 * Language / localization seam for the Feishu channel.
 *
 * The plugin registers an optional `locale` setting under its own namespace
 * (`lark-channel`). When that field is absent, the plugin falls back to the
 * DSH browser-language preference (the host `locale` namespace registered by
 * `@deepseek-ai/dsh-client-locale`); when that is also absent it defaults to
 * `zh`. This module owns that resolution and the zh/en string dictionaries the
 * command layer and every card renderer consume.
 *
 * The dictionaries are typed against a single `Translations` shape and each
 * locale object is checked with `satisfies`, so a missing key in either
 * language fails the typecheck rather than silently rendering a blank string.
 *
 * Terminology aligns with the DSH native UI (see the AGENTS.md compatibility
 * table): `Agent 预设`, `会话`, `工作区`, `推理`, permission presets
 * `仅可查看`/`可写入工作区`/`完全权限`, etc.
 *
 * @module @starxer/chatterbox4dsh/i18n
 */

/** Locale identifiers the plugin ships. */
export const LOCALE_IDS = ['zh', 'en'] as const
export type LocaleId = (typeof LOCALE_IDS)[number]

/** Canonical plugin locale; `'auto'` means "follow the DSH preference". */
export type PluginLocale = LocaleId | 'auto'

export interface Translations {
  // ---- Session panel (feishu-session.ts) ----
  sessionPanelTitle: string
  sessionPanelIntro: string
  sessionListHeader: string
  sessionListEmpty: string
  sessionEntry: (index: number, title: string, id: string, lastActive: string, ownerLabel: string | undefined) => string
  sessionSwitch: string
  sessionDetach: string
  sessionArchive: string
  sessionFork: string
  sessionRename: string
  sessionConfirmTitle: (action: string) => string
  sessionConfirmBody: (action: string, name: string) => string
  sessionConfirmOk: string
  sessionConfirmCancel: string
  sessionRenameTitle: string
  sessionRenamePlaceholder: string
  sessionRenameConfirm: string
  sessionRenameCancel: string
  sessionResultSwitched: (target: string) => string
  sessionResultDetached: (label: string) => string
  sessionResultArchived: () => string
  sessionResultForked: (id: string) => string
  sessionResultRenamed: (title: string) => string
  sessionErrorOccupied: string
  sessionErrorArchived: string
  sessionErrorInvalid: string
  sessionActionLabel: (action: string) => string

  // ---- Model select (feishu-model-select.ts) ----
  modelSelectTitle: (newSession: boolean) => string
  modelSelectCurrent: (provider: string, model: string, effort: string) => string
  modelSelectProviderHeader: string
  modelSelectProviderPlaceholder: string
  modelSelectModelHeader: string
  modelSelectModelEmpty: string
  modelSelectModelPlaceholder: (empty: boolean) => string
  modelSelectEffortHeader: string
  modelSelectEffortPlaceholder: string
  modelSelectConfirm: (newSession: boolean) => string
  modelSelectNewSessionTitle: string

  // ---- Permission (feishu-permission.ts) ----
  permissionTitle: string
  permissionCurrent: (mode: string) => string
  permissionHint: string
  permissionReadOnly: string
  permissionWorkspaceWrite: string
  permissionFullAccess: string

  // ---- Busy mode (feishu-busy.ts) ----
  busyTitle: string
  busyIntro: string
  busyQueueLabel: string
  busySteerLabel: string
  busyCurrentOption: (mode: string) => string

  // ---- Questions (feishu-questions.ts) ----
  questionSkip: string
  questionChoicePrefix: string

  // ---- Onboarding (feishu-onboarding.ts) ----
  onboardingTitle: string
  onboardingSubtitle: string
  onboardingSelectPreset: string
  onboardingPresetLabel: (id: string) => string
  onboardingNewSessionLabel: string
  onboardingStart: string

  // ---- Streaming / per-step + turn complete (feishu-streaming.ts) ----
  stepReasoningHeader: string
  stepMessageHeader: string
  stepToolHeader: string
  stepToolSuccess: string
  stepToolError: string
  stepToolRunning: string
  stepToolArgsHeader: string
  stepToolResultHeader: string
  stepCardTitleError: string
  stepCardTitleDone: string
  stepCardTitleCall: string
  stepCardTitleReply: string
  turnCompleteTitle: string
  turnCompleteDetail: (duration: string, llm: string, tools: string) => string
  turnCompleteSteps: (steps: number, tokens: string, speed: string) => string
  enterWhileBusy: string

  // ---- Status (renderStatusCard in index.ts) ----
  statusRunWarning: string
  statusSessionLabel: string
  statusTitleLabel: string
  statusWorkspaceLabel: string
  statusPresetLabel: string
  statusModelLabel: string
  statusReasoningLabel: string
  statusPermissionLabel: string
  statusBusyLabel: string
  statusAgentLabel: string
  statusAgentRunning: string
  statusAgentIdle: string

  // ---- Misc shared ----
  cancel: string
  confirm: string
  back: string
  next: string

  // ---- Extra keys for the bilingual card renderers ----

  // Busy card body (feishu-busy.ts)
  busyCurrentLabel: string
  busyHint: string
  busyQueueWord: string
  busySteerWord: string
  busyQueueDesc: string
  busySteerDesc: string

  // Permission extras (feishu-permission.ts)
  permissionNoSession: string

  // Model select extras (feishu-model-select.ts)
  modelSelectProviderLabel: (label: string) => string
  modelSelectBack: string
  modelSelectSwitchedHeader: string
  modelSelectSwitchedNext: string
  modelSelectEffortLine: (effort: string) => string
  modelSelectFailHeader: string
  modelEffortDefault: string
  modelEffortOff: string
  modelEffortLow: string
  modelEffortHigh: string
  modelEffortMax: string

  // Session panel / confirm / result extras (feishu-session.ts)
  sessionPanelSelectLabel: string
  sessionPanelSelectPlaceholder: (empty: boolean) => string
  sessionPanelActionLabel: string
  sessionPanelCount: (total: number, locked: number) => string
  sessionPanelHint: string
  sessionListButton: string
  sessionRefreshButton: string
  sessionOpSwitch: string
  sessionOpDetach: string
  sessionOpArchive: string
  sessionOpFork: string
  sessionOpRename: string
  sessionConfirmDetailSwitch: (label: string) => string
  sessionConfirmDetailDetach: (label: string) => string
  sessionConfirmDetailArchive: (label: string) => string
  sessionConfirmDetailFork: (label: string) => string
  sessionConfirmDetailRename: (label: string) => string
  sessionResultEmptyTitle: string
  sessionResultEmptyBody: string
  sessionResultUnavailable: string
  sessionResultUnavailableRename: string
  sessionResultRenamedHeader: string
  sessionResultRenamedBody: (label: string) => string
  sessionResultRenameFailed: string
  sessionResultCancelled: string
  sessionResultCancelledBody: string
  sessionResultArchivedHeader: string
  sessionResultArchivedSwitchBody: (label: string) => string
  sessionResultSwitchedHeader: string
  sessionResultSwitchedBody: (label: string) => string
  sessionResultDetachHeader: string
  sessionResultDetachFree: (label: string) => string
  sessionResultDetachReleased: (label: string, owner: string) => string
  sessionResultArchivedOk: string
  sessionResultArchivedBody: (label: string) => string
  sessionResultForkHeader: string
  sessionResultForkBody: (label: string, id: string | undefined) => string
  sessionResultOpFailed: string
  sessionResultUnsupported: (name: string) => string
  sessionRenamePrompt: (label: string) => string
  sessionRenameButton: string
  sessionListTitle: string
  sessionListTableHeader: string
  sessionListNone: string
  sessionTimeJustNow: string
  sessionTimeMinute: string
  sessionTimeHour: string
  sessionTimeDay: string

  // Onboarding extras (feishu-onboarding.ts)
  onboardingAttachTitle: string
  onboardingSessionFallback: (index: number, id: string) => string
  onboardingInUse: (owner: string) => string
  onboardingNoSessions: string
  onboardingPickExisting: string
  onboardingSelectPlaceholder: string
  onboardingAttachButton: string
  onboardingNewButton: string
  onboardingIntro: (threadLabel: string) => string
  onboardingWorkspaceHeader: string
  onboardingNoWorkspaces: string
  onboardingNewWorkspaceHeader: string
  onboardingWorkspacePlaceholder: string
  onboardingCreateWorkspaceButton: string
  onboardingNewTitle: string
  onboardingPresetHeader: string
  onboardingNoPresets: string
  onboardingCreatedTitle: string
  onboardingCreatedBody: (sessionId: string, summary: string) => string
  onboardingAttachedTitle: string
  onboardingTakeover: (owner: string) => string
  onboardingAttachedBody: (sessionId: string, takeover: string) => string
  onboardingAttachArchivedTitle: string
  onboardingAttachArchivedBody: string
  onboardingCreateWorkspaceFailTitle: string
  onboardingCreateWorkspaceFailBody: (path: string, msg: string) => string
  onboardingCancelTitle: string
  onboardingCancelledBody: string

  // Questions extras (feishu-questions.ts)
  questionSelectedSuffix: string
  questionCustomAnswerLabel: string
  questionSkippedLabel: string
  questionSelectedLabel: string
  questionDefaultTitle: string
  questionCustomHint: (hasOptions: boolean) => string
  questionCustomPlaceholder: string
  questionSubmitCustom: string
  questionSkipButton: string
}

/** The zh dictionary: terminology aligned with the DSH native UI. */
export const zh = {
  sessionPanelTitle: '📋 会话管理',
  sessionPanelIntro: '选择会话并执行操作。',
  sessionListHeader: '可用会话：',
  sessionListEmpty: '当前还没有持久化的会话。',
  sessionEntry: (index: number, title: string, id: string, lastActive: string, ownerLabel: string | undefined) =>
    `${index}. ${title} — ${lastActive}${ownerLabel === undefined ? '' : ` — 🔒 ${ownerLabel} 正在使用`} (\`${id}\`)`,
  sessionSwitch: '🔀 切换',
  sessionDetach: '🔓 Detach',
  sessionArchive: '🗄️ 归档',
  sessionFork: '🍴 派生',
  sessionRename: '✏️ 改名',
  sessionConfirmTitle: action => `确认${action}？`,
  sessionConfirmBody: (action, name) => `确定要${action}「${name}」吗？`,
  sessionConfirmOk: '确认',
  sessionConfirmCancel: '取消',
  sessionRenameTitle: '✏️ 重命名会话',
  sessionRenamePlaceholder: '输入新的会话标题…',
  sessionRenameConfirm: '确认',
  sessionRenameCancel: '取消',
  sessionResultSwitched: target => `已切换到会话「${target}」。`,
  sessionResultDetached: label => `🔓 已释放会话。${label} 已重置为全新会话。`,
  sessionResultArchived: () => '会话已归档。可在工作区 WebUI 中取消归档。',
  sessionResultForked: id => `已派生新会话 \`${id}\`。`,
  sessionResultRenamed: title => `会话已重命名为「${title}」。`,
  sessionErrorOccupied: '该会话正被占用，请先 detach 再切换。',
  sessionErrorArchived: '该会话已归档，请先在 WebUI 取消归档。',
  sessionErrorInvalid: '无效的会话。',
  sessionActionLabel: action => `操作「${action}」`,

  modelSelectTitle: newSession => newSession ? '🤖 模型选择（新建会话）' : '🤖 模型选择',
  modelSelectCurrent: (provider, model, effort) =>
    `**当前模型**　\`${provider}/${model}\`\n🧭 思考强度：\`${effort}\``,
  modelSelectProviderHeader: '**选择 Provider**',
  modelSelectProviderPlaceholder: '选择 Provider…',
  modelSelectModelHeader: '**选择模型**',
  modelSelectModelEmpty: '该 Provider 下暂无可用模型。',
  modelSelectModelPlaceholder: empty => empty ? '该 Provider 下暂无可用模型…' : '选择模型…',
  modelSelectEffortHeader: '**思考强度**',
  modelSelectEffortPlaceholder: '选择思考强度…',
  modelSelectConfirm: newSession => newSession ? '✅ 确认并创建会话' : '✅ 确认切换',
  modelSelectNewSessionTitle: '🤖 模型选择（新建会话）',

  permissionTitle: 'Permission',
  permissionCurrent: mode => `**当前权限模式：** \`${mode}\``,
  permissionHint: '_点击下方按钮切换本会话的权限（沙箱）模式。切换写入会话日志，下一次受限调用即生效。_',
  permissionReadOnly: '仅可查看',
  permissionWorkspaceWrite: '可写入工作区',
  permissionFullAccess: '完全权限',

  busyTitle: '⏳ 忙碌行为',
  busyIntro: 'Agent 运行时收到的新消息如何进入？',
  busyQueueLabel: '📥 Queue',
  busySteerLabel: '🎯 Steer',
  busyCurrentOption: mode => `当前：${mode === 'steer' ? 'Steer' : 'Queue'}`,

  questionSkip: '跳过',
  questionChoicePrefix: '选项',

  onboardingTitle: '🤖 新建会话',
  onboardingSubtitle: '选择一个工作区与 Agent 预设开始。',
  onboardingSelectPreset: '选择 Agent 预设',
  onboardingPresetLabel: id => id,
  onboardingNewSessionLabel: '开始会话',
  onboardingStart: '🚀 开始会话',

  stepReasoningHeader: '💬 **推理**',
  stepMessageHeader: '📝 **消息**',
  stepToolHeader: '🔧 **工具调用**',
  stepToolSuccess: '成功',
  stepToolError: '失败',
  stepToolRunning: '运行中…',
  stepToolArgsHeader: '**⚙️ 参数**',
  stepToolResultHeader: '**📤 结果**',
  stepCardTitleError: '工具出错',
  stepCardTitleDone: '工具完成',
  stepCardTitleCall: '工具调用',
  stepCardTitleReply: '回复',
  turnCompleteTitle: '✅ Turn 已完成',
  turnCompleteDetail: (duration, llm, tools) => `总时长 ${duration} · LLM ${llm} · 工具 ${tools}`,
  turnCompleteSteps: (steps, tokens, speed) => `${steps} 步 · ${tokens} · ${speed}`,
  enterWhileBusy: '忙碌时进入',

  statusRunWarning: '> ⚠️ Agent 正在运行中，以上信息可能并非最新。请在 Agent 运行结束后再次发送 `/status` 获取准确信息。',
  statusSessionLabel: '会话',
  statusTitleLabel: '标题',
  statusWorkspaceLabel: '工作区',
  statusPresetLabel: '预设',
  statusModelLabel: '模型',
  statusReasoningLabel: '推理',
  statusPermissionLabel: '权限',
  statusBusyLabel: '忙碌时进入',
  statusAgentRunning: '🔄 运行中',
  statusAgentIdle: '⏸️ 空闲',
  statusAgentLabel: 'Agent',

  cancel: '取消',
  confirm: '确认',
  back: '返回',
  next: '继续',

  // ---- Extra keys for the bilingual card renderers ----
  busyCurrentLabel: '运行中（busy）的 Enter 行为',
  busyHint: '_点击下方按钮切换本聊天在 agent 运行中收到消息时的处理方式（对齐 WebUI「Enter behavior while busy」）。已持久化，重启后保留。_',
  busyQueueWord: 'Queue',
  busySteerWord: 'Steer',
  busyQueueDesc: '当前轮结束后作为新轮运行（默认）',
  busySteerDesc: '注入当前运行轮立即响应',

  permissionNoSession: '当前 chat 还没有会话，请先发一条消息再执行 /permission',

  modelSelectProviderLabel: label => `**Provider**　\`${label}\``,
  modelSelectBack: '← 返回选择 Provider',
  modelSelectSwitchedHeader: '✅ **已切换**',
  modelSelectSwitchedNext: '下一轮对话将使用新模型。',
  modelSelectEffortLine: effort => `🧠 思考强度：\`${effort}\``,
  modelSelectFailHeader: '⚠️ **切换失败**',
  modelEffortDefault: 'default（不指定）',
  modelEffortOff: 'off（关闭思考）',
  modelEffortLow: 'low（轻度思考）',
  modelEffortHigh: 'high（深度思考）',
  modelEffortMax: 'max（最大思考）',

  sessionPanelSelectLabel: '**选择会话**',
  sessionPanelSelectPlaceholder: empty => empty ? '暂无会话' : '选择会话…',
  sessionPanelActionLabel: '**执行操作**',
  sessionPanelCount: (total, locked) => `共 ${total} 个会话${locked > 0 ? ` · ${locked} 个被占用` : ''}`,
  sessionPanelHint: '_选择会话后点下方按钮执行对应操作。_',
  sessionListButton: '📋 列表',
  sessionRefreshButton: '🔄 刷新',
  sessionOpSwitch: '切换',
  sessionOpDetach: '释放',
  sessionOpArchive: '归档',
  sessionOpFork: '派生',
  sessionOpRename: '改名',
  sessionConfirmDetailSwitch: label => `将把这个对话切换到会话 \`${label}\`，若它被其它对话占用会先接管。`,
  sessionConfirmDetailDetach: label => `将释放会话 \`${label}\` 的占用（原持有者重置为新会话）。`,
  sessionConfirmDetailArchive: label => `将归档会话 \`${label}\`。`,
  sessionConfirmDetailFork: label => `将从会话 \`${label}\` fork 出一个新会话（保留到当前事件的对话）。`,
  sessionConfirmDetailRename: label => `将把会话 \`${label}\` 改成新的标题。`,
  sessionResultEmptyTitle: '⚠️ 标题为空',
  sessionResultEmptyBody: '请输入新的会话标题后再确认。',
  sessionResultUnavailable: '⚠️ 暂不可用',
  sessionResultUnavailableRename: '本部署未启用「改名」能力。',
  sessionResultRenamedHeader: '✅ 已改名',
  sessionResultRenamedBody: label => `会话 \`${label}\` 已改名为：`,
  sessionResultRenameFailed: '❌ 改名失败',
  sessionResultCancelled: '已取消',
  sessionResultCancelledBody: '本次操作已取消。',
  sessionResultArchivedHeader: '⚠️ 已归档',
  sessionResultArchivedSwitchBody: label => `会话 \`${label}\` 已归档，无法切换。`,
  sessionResultSwitchedHeader: '✅ 已切换',
  sessionResultSwitchedBody: label => `这个对话已切换到会话 \`${label}\`。下一轮对话将使用它。`,
  sessionResultDetachHeader: '🔓 已 detach',
  sessionResultDetachFree: label => `会话 \`${label}\` 本就空闲。`,
  sessionResultDetachReleased: (label, owner) => `已释放会话 \`${label}\`（原持有者：${owner}）。`,
  sessionResultArchivedOk: '🗄️ 已归档',
  sessionResultArchivedBody: label => `会话 \`${label}\` 已归档。`,
  sessionResultForkHeader: '🍴 已 fork',
  sessionResultForkBody: (label, id) => `已从 \`${label}\` fork 出新会话${id !== undefined ? ` \`${id}\`` : ''}。可用「/new」或并在本面板中切换。`,
  sessionResultOpFailed: '❌ 操作失败',
  sessionResultUnsupported: name => `本部署未启用「${name}」能力。`,
  sessionRenamePrompt: label => `为会话 \`${label}\` 输入新标题：`,
  sessionRenameButton: '✅ 确认改名',
  sessionListTitle: '📋 会话列表',
  sessionListTableHeader: '| 会话 | ID | 预设 | 占用 | 最近活跃 |',
  sessionListNone: '暂无会话。',
  sessionTimeJustNow: '刚刚',
  sessionTimeMinute: 'm 前',
  sessionTimeHour: 'h 前',
  sessionTimeDay: 'd 前',

  onboardingAttachTitle: '🚀 选择会话',
  onboardingSessionFallback: (index, id) => `会话 ${index + 1} (${id})`,
  onboardingInUse: owner => ` 🔒 ${owner} 正在使用`,
  onboardingNoSessions: '当前没有任何历史会话，请点击下方按钮新建一个会话。',
  onboardingPickExisting: '**📚 选择已有会话**',
  onboardingSelectPlaceholder: '选择会话...',
  onboardingAttachButton: '📎 绑定到该会话',
  onboardingNewButton: '✨ 新建会话',
  onboardingIntro: threadLabel => `**👋 开始使用**\n\n${threadLabel} 还没有绑定任何会话。从下方选择一个已有会话继续，或新建一个会话。`,
  onboardingWorkspaceHeader: '**📁 选择工作区**\n\n新建会话将在这个工作区中运行。',
  onboardingNoWorkspaces: '还没有工作区，请在下方输入路径新建一个。',
  onboardingNewWorkspaceHeader: '**🆕 新建工作区**\n\n输入绝对路径，或 `~` 开头的家目录相对路径。',
  onboardingWorkspacePlaceholder: '如 /home/user/projects/my-app 或 ~/projects/my-app',
  onboardingCreateWorkspaceButton: '✅ 确认新建工作区',
  onboardingNewTitle: '🆕 新建会话',
  onboardingPresetHeader: '**🧩 选择 Agent 预设**\n\n模板决定这个会话拥有哪些能力。',
  onboardingNoPresets: '没有可用模板，将使用默认模板。',
  onboardingCreatedTitle: '✅ 会话已创建',
  onboardingCreatedBody: (sessionId, summary) => `**Session** \`${sessionId}\`\n\n${summary}\n\n现在可以发送消息开始对话了。`,
  onboardingAttachedTitle: '📎 会话已绑定',
  onboardingTakeover: owner => `\n\n🔓 已从 ${owner} 接管该会话（原占用者已被重置为新会话）。`,
  onboardingAttachedBody: (sessionId, takeover) => `已绑定到会话 \`${sessionId}\`。${takeover}\n\n现在可以发送消息继续对话了。`,
  onboardingAttachArchivedTitle: '📎 绑定会话',
  onboardingAttachArchivedBody: '⚠️ 该会话已被归档，无法绑定。',
  onboardingCreateWorkspaceFailTitle: '📁 新建工作区',
  onboardingCreateWorkspaceFailBody: (path, msg) => `⚠️ **创建工作区失败**\n\n\`${path}\`\n\n${msg}`,
  onboardingCancelTitle: '🚀 新建会话',
  onboardingCancelledBody: '已取消新建会话。',

  questionSelectedSuffix: '已选择',
  questionCustomAnswerLabel: '自定义回答：',
  questionSkippedLabel: '已跳过',
  questionSelectedLabel: '已选择：',
  questionDefaultTitle: '问题',
  questionCustomHint: hasOptions => hasOptions ? '以上选项都不满意？在下方输入你的自定义回答：' : '请输入你的回答：',
  questionCustomPlaceholder: '在此输入...',
  questionSubmitCustom: '✏️ 提交自定义回答',
  questionSkipButton: '⏭️ 跳过本题',
} as const satisfies Translations

/** The en dictionary, keyed identically to the zh dictionary. */
export const en: Translations = {
  sessionPanelTitle: '📋 Session',
  sessionPanelIntro: 'Pick a session and run an action.',
  sessionListHeader: 'Available sessions:',
  sessionListEmpty: 'No persisted sessions yet.',
  sessionEntry: (index, title, id, lastActive, ownerLabel) =>
    `${index}. ${title} — ${lastActive}${ownerLabel === undefined ? '' : ` — 🔒 in use by ${ownerLabel}`} (\`${id}\`)`,
  sessionSwitch: '🔀 Switch',
  sessionDetach: '🔓 Detach',
  sessionArchive: '🗄️ Archive',
  sessionFork: '🍴 Fork',
  sessionRename: '✏️ Rename',
  sessionConfirmTitle: action => `Confirm ${action}?`,
  sessionConfirmBody: (action, name) => `Are you sure you want to ${action} "${name}"?`,
  sessionConfirmOk: 'Confirm',
  sessionConfirmCancel: 'Cancel',
  sessionRenameTitle: '✏️ Rename session',
  sessionRenamePlaceholder: 'Enter a new session title…',
  sessionRenameConfirm: 'Confirm',
  sessionRenameCancel: 'Cancel',
  sessionResultSwitched: target => `Switched to session "${target}".`,
  sessionResultDetached: label => `🔓 Released the session. ${label} was reset to a brand-new session.`,
  sessionResultArchived: () => 'Session archived. Unarchive it from the workspace webui first.',
  sessionResultForked: id => `Forked a new session \`${id}\`.`,
  sessionResultRenamed: title => `Renamed session to "${title}".`,
  sessionErrorOccupied: 'That session is already occupied — detach it first.',
  sessionErrorArchived: 'That session is archived — unarchive it from the workspace webui first.',
  sessionErrorInvalid: 'Invalid session.',
  sessionActionLabel: action => `Action "${action}"`,

  modelSelectTitle: newSession => newSession ? '🤖 Model selection (new session)' : '🤖 Model selection',
  modelSelectCurrent: (provider, model, effort) =>
    `**Current model**　\`${provider}/${model}\`\n🧭 Reasoning effort: \`${effort}\``,
  modelSelectProviderHeader: '**Select provider**',
  modelSelectProviderPlaceholder: 'Select provider…',
  modelSelectModelHeader: '**Select model**',
  modelSelectModelEmpty: 'No models available under this provider.',
  modelSelectModelPlaceholder: empty => empty ? 'No models available under this provider…' : 'Select model…',
  modelSelectEffortHeader: '**Reasoning effort**',
  modelSelectEffortPlaceholder: 'Select reasoning effort…',
  modelSelectConfirm: newSession => newSession ? '✅ Confirm and create session' : '✅ Confirm switch',
  modelSelectNewSessionTitle: '🤖 Model selection (new session)',

  permissionTitle: 'Permission',
  permissionCurrent: mode => `**Current permission mode:** \`${mode}\``,
  permissionHint: '_Click below to switch this session\'s permission (sandbox) mode. The change is written to the session log and applies on the next restricted call._',
  permissionReadOnly: 'Read Only',
  permissionWorkspaceWrite: 'Workspace Write',
  permissionFullAccess: 'Full access',

  busyTitle: '⏳ Busy behavior',
  busyIntro: 'How should a new message enter while the agent is running?',
  busyQueueLabel: '📥 Queue',
  busySteerLabel: '🎯 Steer',
  busyCurrentOption: mode => `Current: ${mode === 'steer' ? 'Steer' : 'Queue'}`,

  questionSkip: 'Skip',
  questionChoicePrefix: 'Option',

  onboardingTitle: '🤖 New session',
  onboardingSubtitle: 'Pick a workspace and agent preset to start.',
  onboardingSelectPreset: 'Select agent preset',
  onboardingPresetLabel: id => id,
  onboardingNewSessionLabel: 'Start session',
  onboardingStart: '🚀 Start session',

  stepReasoningHeader: '💬 **Reasoning**',
  stepMessageHeader: '📝 **Message**',
  stepToolHeader: '🔧 **Tool Call**',
  stepToolSuccess: 'ok',
  stepToolError: 'failed',
  stepToolRunning: 'running…',
  stepToolArgsHeader: '**⚙️ Args**',
  stepToolResultHeader: '**📤 Result**',
  stepCardTitleError: 'Tool Error',
  stepCardTitleDone: 'Tool Done',
  stepCardTitleCall: 'Tool Call',
  stepCardTitleReply: 'Reply',
  turnCompleteTitle: '✅ Turn complete',
  turnCompleteDetail: (duration, llm, tools) => `Total ${duration} · LLM ${llm} · Tools ${tools}`,
  turnCompleteSteps: (steps, tokens, speed) => `${steps} steps · ${tokens} · ${speed}`,
  enterWhileBusy: 'Enter while busy',

  statusRunWarning: '> ⚠️ The agent is running; this may be stale. Send `/status` again after it finishes.',
  statusSessionLabel: 'Session',
  statusTitleLabel: 'Title',
  statusWorkspaceLabel: 'Workspace',
  statusPresetLabel: 'Preset',
  statusModelLabel: 'Model',
  statusReasoningLabel: 'Reasoning',
  statusPermissionLabel: 'Permission',
  statusBusyLabel: 'Enter while busy',
  statusAgentRunning: '🔄 Running',
  statusAgentIdle: '⏸️ Idle',
  statusAgentLabel: 'Agent',

  cancel: 'Cancel',
  confirm: 'Confirm',
  back: 'Back',
  next: 'Continue',

  // ---- Extra keys for the bilingual card renderers ----
  busyCurrentLabel: 'Enter behavior while running (busy)',
  busyHint: '_Click below to switch how this chat handles a message received while the agent is running (aligned with the WebUI "Enter behavior while busy"). Persisted and kept across restarts._',
  busyQueueWord: 'Queue',
  busySteerWord: 'Steer',
  busyQueueDesc: 'Runs as a new round after the current one (default)',
  busySteerDesc: 'Injects into the current running round to respond immediately',

  permissionNoSession: 'This chat has no session yet — send a message first, then run /permission',

  modelSelectProviderLabel: label => `**Provider**　\`${label}\``,
  modelSelectBack: '← Back to choose provider',
  modelSelectSwitchedHeader: '✅ **Switched**',
  modelSelectSwitchedNext: 'The next round will use the new model.',
  modelSelectEffortLine: effort => `🧠 Reasoning effort: \`${effort}\``,
  modelSelectFailHeader: '⚠️ **Switch failed**',
  modelEffortDefault: 'default (not specified)',
  modelEffortOff: 'off (thinking off)',
  modelEffortLow: 'low (light reasoning)',
  modelEffortHigh: 'high (deep reasoning)',
  modelEffortMax: 'max (max reasoning)',

  sessionPanelSelectLabel: '**Select session**',
  sessionPanelSelectPlaceholder: empty => empty ? 'No sessions' : 'Select session…',
  sessionPanelActionLabel: '**Run an action**',
  sessionPanelCount: (total, locked) => `${total} sessions${locked > 0 ? ` · ${locked} in use` : ''}`,
  sessionPanelHint: '_Pick a session, then tap a button below to run it._',
  sessionListButton: '📋 List',
  sessionRefreshButton: '🔄 Refresh',
  sessionOpSwitch: 'Switch',
  sessionOpDetach: 'detach',
  sessionOpArchive: 'archive',
  sessionOpFork: 'fork',
  sessionOpRename: 'rename',
  sessionConfirmDetailSwitch: label => `This chat will be switched to session \`${label}\`; if another chat owns it, the switch will take it over.`,
  sessionConfirmDetailDetach: label => `This will release session \`${label}\` (the current owner resets to a brand-new session).`,
  sessionConfirmDetailArchive: label => `This will archive session \`${label}\`.`,
  sessionConfirmDetailFork: label => `This will fork a new session from \`${label}\` (keeps the conversation up to the current event).`,
  sessionConfirmDetailRename: label => `This will rename session \`${label}\` to a new title.`,
  sessionResultEmptyTitle: '⚠️ Empty title',
  sessionResultEmptyBody: 'Please enter a session title first, then confirm.',
  sessionResultUnavailable: '⚠️ Unavailable',
  sessionResultUnavailableRename: 'Rename is not enabled in this deployment.',
  sessionResultRenamedHeader: '✅ Renamed',
  sessionResultRenamedBody: label => `Renamed session \`${label}\` to:`,
  sessionResultRenameFailed: '❌ Rename failed',
  sessionResultCancelled: 'Cancelled',
  sessionResultCancelledBody: 'This operation was cancelled.',
  sessionResultArchivedHeader: '⚠️ Archived',
  sessionResultArchivedSwitchBody: label => `Session \`${label}\` is archived and cannot be switched to.`,
  sessionResultSwitchedHeader: '✅ Switched',
  sessionResultSwitchedBody: label => `This chat is now switched to session \`${label}\`. The next round will use it.`,
  sessionResultDetachHeader: '🔓 Detached',
  sessionResultDetachFree: label => `Session \`${label}\` was already free.`,
  sessionResultDetachReleased: (label, owner) => `Released session \`${label}\` (previous owner: ${owner}).`,
  sessionResultArchivedOk: '🗄️ Archived',
  sessionResultArchivedBody: label => `Session \`${label}\` was archived.`,
  sessionResultForkHeader: '🍴 Forked',
  sessionResultForkBody: (label, id) => `Forked a new session from \`${label}\`${id !== undefined ? ` \`${id}\`` : ''}. Use /new or switch to it in this panel.`,
  sessionResultOpFailed: '❌ Operation failed',
  sessionResultUnsupported: name => `${name} is not enabled in this deployment.`,
  sessionRenamePrompt: label => `Enter a new title for session \`${label}\`:` ,
  sessionRenameButton: '✅ Confirm rename',
  sessionListTitle: '📋 Session list',
  sessionListTableHeader: '| Session | ID | Preset | In use | Last active |',
  sessionListNone: 'No sessions.',
  sessionTimeJustNow: 'just now',
  sessionTimeMinute: 'm ago',
  sessionTimeHour: 'h ago',
  sessionTimeDay: 'd ago',

  onboardingAttachTitle: '🚀 Pick a session',
  onboardingSessionFallback: (index, id) => `Session ${index + 1} (${id})`,
  onboardingInUse: owner => ` 🔒 in use by ${owner}`,
  onboardingNoSessions: 'There are no persisted sessions yet. Tap the button below to create a new one.',
  onboardingPickExisting: '**📚 Pick an existing session**',
  onboardingSelectPlaceholder: 'Select session…',
  onboardingAttachButton: '📎 Attach to this session',
  onboardingNewButton: '✨ New session',
  onboardingIntro: threadLabel => `**👋 Getting started**\n\n${threadLabel} is not bound to any session yet. Pick an existing session below to continue, or create a new one.`,
  onboardingWorkspaceHeader: '**📁 Pick a workspace**\n\nThe new session will run in this workspace.',
  onboardingNoWorkspaces: 'No workspaces yet — enter a path below to create one.',
  onboardingNewWorkspaceHeader: '**🆕 New workspace**\n\nEnter an absolute path, or a `~`-relative home path.',
  onboardingWorkspacePlaceholder: 'e.g. /home/user/projects/my-app or ~/projects/my-app',
  onboardingCreateWorkspaceButton: '✅ Confirm and create workspace',
  onboardingNewTitle: '🆕 New session',
  onboardingPresetHeader: '**🧩 Choose an agent preset**\n\nThe preset decides which capabilities this session has.',
  onboardingNoPresets: 'No presets available; the default preset will be used.',
  onboardingCreatedTitle: '✅ Session created',
  onboardingCreatedBody: (sessionId, summary) => `**Session** \`${sessionId}\`\n\n${summary}\n\nYou can now send a message to start chatting.`,
  onboardingAttachedTitle: '📎 Session attached',
  onboardingTakeover: owner => `\n\n🔓 Took over this session from ${owner} (the previous owner was reset to a brand-new session).`,
  onboardingAttachedBody: (sessionId, takeover) => `Attached to session \`${sessionId}\`.${takeover}\n\nYou can now send a message to continue chatting.`,
  onboardingAttachArchivedTitle: '📎 Attach session',
  onboardingAttachArchivedBody: '⚠️ This session is archived and cannot be attached.',
  onboardingCreateWorkspaceFailTitle: '📁 New workspace',
  onboardingCreateWorkspaceFailBody: (path, msg) => `⚠️ **Failed to create workspace**\n\n\`${path}\`\n\n${msg}`,
  onboardingCancelTitle: '🚀 New session',
  onboardingCancelledBody: 'New session creation was cancelled.',

  questionSelectedSuffix: 'selected',
  questionCustomAnswerLabel: 'Custom answer:',
  questionSkippedLabel: 'skipped',
  questionSelectedLabel: 'Selected:',
  questionDefaultTitle: 'Question',
  questionCustomHint: hasOptions => hasOptions ? 'None of the options fit? Type your custom answer below:' : 'Type your answer below:',
  questionCustomPlaceholder: 'Type here…',
  questionSubmitCustom: '✏️ Submit custom answer',
  questionSkipButton: '⏭️ Skip this question',
}

/**
 * Normalise an arbitrary DSH locale preference (BCP 47-ish, e.g. `zh-CN`,
 * `en-US`, `zh`, `en`) into one of the plugin locale ids.
 */
export function toLocaleId(value: string | undefined): LocaleId | undefined {
  if (value === undefined) return undefined
  const base = value.split('-')[0]?.toLowerCase() ?? ''
  if (base === 'zh') return 'zh'
  if (base === 'en') return 'en'
  return undefined
}

/**
 * Resolve the active plugin locale.
 *
 * @param pluginLocale - the plugin's own `locale` setting (`auto` = follow DSH).
 * @param dshPreference - the DSH browser-language preference, if readable.
 * @returns the locale to render with; defaults to `zh`.
 */
export function resolveLocale(pluginLocale: PluginLocale | undefined, dshPreference: string | undefined): LocaleId {
  if (pluginLocale === 'zh' || pluginLocale === 'en') return pluginLocale
  const dsh = toLocaleId(dshPreference)
  if (dsh !== undefined) return dsh
  return 'zh'
}

/** Return the dictionary for a locale. */
export function translationsFor(locale: LocaleId): Translations {
  return locale === 'en' ? en : zh
}
