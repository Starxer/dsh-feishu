import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult, CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { LlmProviderInfo, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { HarnessConversationService } from './harness.ts'
import type { ConversationMessage } from './conversation.ts'
import type { PendingApprovalView } from './feishu-approvals.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by `@deepseek-ai/dsh-commands`; declared here so this file
     *  does not need a runtime import. */
    commands: CommandRuntime
  }
}

interface LlmDirectoryLike {
  listProviders(): readonly LlmProviderInfo[]
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
}

/**
 * Discover every provider/model route so the user can pick one in chat.
 * Returns a sorted list of `provider/model` strings plus the human-readable
 * catalog used to render the response.
 */
async function buildModelCatalog(
  llm: LlmDirectoryLike,
  t: Pick<CommandTranslations, 'modelListHeader' | 'modelListEmpty'>,
): Promise<string> {
  const providers = llm.listProviders()
  if (providers.length === 0) {
    return t.modelListEmpty
  }
  const lines: string[] = [t.modelListHeader]
  for (const provider of providers) {
    let models: readonly LlmModelInfo[]
    try {
      models = await llm.listModels(provider.id)
    } catch {
      models = []
    }
    if (models.length === 0) {
      lines.push(`• \`${provider.id}\` (no models available)`)
      continue
    }
    for (const model of models) {
      lines.push(`• \`${provider.id}/${model.id}\``)
    }
  }
  return lines.join('\n')
}

export interface CommandTranslations {
  readonly modelDescription: string
  readonly modelCurrentHeader: string
  readonly modelUsage: string
  readonly modelListHeader: string
  readonly modelListEmpty: string
  readonly modelSwitched: (provider: string, model: string) => string
  readonly modelUnknown: (route: string) => string
  readonly modelPersisted: string
  readonly modelLiveApplied: string
  readonly newDescription: string
  readonly newSessionReady: (sessionId: string) => string
  readonly threadDescription: string
  readonly threadUsage: string
  readonly threadListHeader: string
  readonly threadListEmpty: string
  readonly threadListEntry: (index: number, id: string, title: string, lastActive: string) => string
  readonly threadSwitched: (index: number, id: string) => string
  readonly threadInvalidIndex: string
  readonly threadArchived: string
  /** Title fallback when the bridge has no in-memory events for a cold
   *  session; receives the session id so the surface can show a short prefix
   *  that distinguishes multiple cold sessions from one another. */
  readonly threadIdle: (id: string) => string
  readonly threadLastActiveJustNow: string
  readonly threadLastActiveMinutesAgo: (n: number) => string
  readonly threadLastActiveHoursAgo: (n: number) => string
  readonly threadLastActiveDaysAgo: (n: number) => string
  readonly threadLastActiveUnknown: string
  readonly helpDescription: string
  readonly helpHeader: string
  readonly helpUsage: string
  readonly helpEntry: (name: string, description: string, hint: string | undefined) => string
  readonly helpEmpty: string
  /** Approval-flavored slash command translations. Feishu users without a
   *  clickable card can answer the most recent (or `<shortCode>`-targeted)
   *  pending approval with `/approve` / `/deny`. */
  readonly approveDescription: string
  readonly approveApproveHint: string
  readonly approveApprovedNoPending: string
  readonly approveApproved: (shortCode: string, toolName: string) => string
  readonly approveUnknownShort: (shortCode: string) => string
  readonly denyDescription: string
  readonly denyHint: string
  readonly denyDenied: (shortCode: string, toolName: string) => string
  readonly approveDenyUsage: string
  readonly approvalsDescription: string
  readonly approvalsEmpty: string
  readonly approvalsHeader: string
  readonly approvalsEntry: (index: number, shortCode: string, toolName: string, age: string) => string
  readonly approvalsAgeJustNow: string
  readonly approvalsAgeSeconds: (n: number) => string
  readonly approvalsAgeMinutes: (n: number) => string
  readonly approvalsAgeHours: (n: number) => string
  readonly statusDescription: string
  readonly statusOutput: (meta: { sessionId: string; workspace: string; agentPreset: string; model: string; title: string; turns: number; steps: number; toolCalls: number; inputTokens: number; outputTokens: number; contextWindow: number; lastInputTokens: number }) => string
  readonly streamDescription: string
  readonly stopDescription: string
  readonly reasoningDescription: string
  readonly reasoningUsage: string
  readonly reasoningCurrent: (effort: string) => string
  readonly reasoningCurrentDefault: string
  readonly reasoningSwitched: (effort: string) => string
  readonly reasoningLevels: string
  readonly reasoningUnknown: (level: string) => string
  readonly reasoningShowToggled: (enabled: boolean) => string
}

/**
 * Format a millisecond timestamp as a coarse relative-time string (e.g.
 * "just now", "5m ago", "3h ago", "2d ago"). Returns the unknown label
 * when the timestamp is missing or invalid.
 */
export function formatRelativeTime(timestamp: number, t: CommandTranslations, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return t.threadLastActiveUnknown
  const delta = now - timestamp
  if (delta < 0) return t.threadLastActiveJustNow
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return t.threadLastActiveJustNow
  if (minutes < 60) return t.threadLastActiveMinutesAgo(minutes)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t.threadLastActiveHoursAgo(hours)
  const days = Math.floor(hours / 24)
  return t.threadLastActiveDaysAgo(days)
}

/** Format the age of a pending approval as a short relative-time string. */
function formatApprovalAge(createdAt: number, t: Pick<CommandTranslations, 'approvalsAgeJustNow' | 'approvalsAgeSeconds' | 'approvalsAgeMinutes' | 'approvalsAgeHours'>, now: number = Date.now()): string {
  const delta = Math.max(0, now - createdAt)
  const seconds = Math.floor(delta / 1000)
  if (seconds < 5) return t.approvalsAgeJustNow
  if (seconds < 60) return t.approvalsAgeSeconds(seconds)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t.approvalsAgeMinutes(minutes)
  const hours = Math.floor(minutes / 60)
  return t.approvalsAgeHours(hours)
}

/** Parse `provider/model` or `provider/model:reasoning-effort` from the raw input. */
function parseModelRoute(rawInput: string): { provider: string; model: string; reasoningEffort?: string } | undefined {
  const trimmed = rawInput.trim()
  if (trimmed === '') return undefined
  const segments = trimmed.split('/')
  if (segments.length !== 2) return undefined
  const provider = segments[0]?.trim() ?? ''
  const modelSegment = segments[1]?.trim() ?? ''
  if (provider === '' || modelSegment === '') return undefined
  const modelParts = modelSegment.split(':')
  const model = modelParts[0]?.trim() ?? ''
  const reasoningEffort = modelParts[1]?.trim()
  if (model === '') return undefined
  return reasoningEffort === undefined || reasoningEffort === ''
    ? { provider, model }
    : { provider, model, reasoningEffort }
}

/**
 * Surface that backs the approval slash commands. Held by `index.ts` so the
 * approvals listener owns the registry; the command handlers receive only
 * read access plus a `settle` callback that mirrors the card-click path
 * (so the card-click and slash-command paths share one apiproxy call site).
 */
export interface ApprovalControl {
  pendingForSession(sessionId: string): PendingApprovalView[]
  findPending(sessionId: string, rpcIdOrShort: string): PendingApprovalView | undefined
  settle(view: PendingApprovalView, outcome: 'allowed-once' | 'rejected'): Promise<void>
}

/**
 * Register every `/`-prefixed command owned by the Feishu channel. The bridge
 * is supplied as a narrow structural view so handlers can read and mutate the
 * per-chat state without depending on the full service surface.
 *
 * `chatMessageFor` recovers the inbound chat coordinates from a closure
 * maintained by `index.ts` because the `CommandInvocation` shape only carries
 * the agent (and therefore the session), not the chatId/threadId the bridge
 * needs.
 */
export function registerLarkCommands(
  ctx: Context,
  llm: LlmDirectoryLike,
  agentDefaultModel: AgentDefaultModelConfig,
  bridge: Pick<
    HarnessConversationService,
    'setCurrentSelection' | 'currentSelectionFor' | 'startNewSession' | 'switchToSession' | 'listSessions' | 'getSessionMeta'
  >,
  chatMessageFor: (invocation: CommandInvocation) => ConversationMessage,
  t: CommandTranslations,
  commands: Pick<CommandRuntime, 'list'>,
  approvals: ApprovalControl,
  showReasoning: { get: () => boolean; toggle: () => void },
): void {
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'model',
      description: t.modelDescription,
      handler: invocation => handleModelCommand(
        invocation,
        llm,
        agentDefaultModel,
        bridge,
        chatMessageFor,
        t,
      ),
    })
    yield ctx.commands.register({
      name: 'new',
      description: t.newDescription,
      handler: invocation => handleNewCommand(
        invocation,
        bridge,
        chatMessageFor,
        t,
      ),
    })
    yield ctx.commands.register({
      name: 'thread',
      description: t.threadDescription,
      handler: invocation => handleThreadCommand(
        invocation,
        bridge,
        chatMessageFor,
        t,
      ),
    })
    yield ctx.commands.register({
      name: 'help',
      description: t.helpDescription,
      handler: invocation => handleHelpCommand(invocation, commands, t),
    })
    yield ctx.commands.register({
      name: 'approve',
      description: t.approveDescription,
      handler: invocation => handleApprovalCommand(invocation, approvals, 'allowed-once', t),
    })
    yield ctx.commands.register({
      name: 'deny',
      description: t.denyDescription,
      handler: invocation => handleApprovalCommand(invocation, approvals, 'rejected', t),
    })
    yield ctx.commands.register({
      name: 'approvals',
      description: t.approvalsDescription,
      handler: invocation => handleListApprovalsCommand(invocation, approvals, t),
    })
    yield ctx.commands.register({
      name: 'status',
      description: t.statusDescription,
      handler: invocation => handleStatusCommand(invocation, bridge, chatMessageFor, t),
    })
    yield ctx.commands.register({
      name: 'stream',
      description: t.streamDescription,
      handler: async () => ({ kind: 'success', text: '' }),
    })
    yield ctx.commands.register({
      name: 'reasoning',
      description: t.reasoningDescription,
      handler: invocation => handleReasoningCommand(
        invocation,
        agentDefaultModel,
        bridge,
        chatMessageFor,
        t,
        showReasoning,
      ),
    })
  }, 'dsh-feishu: /model /new /thread /help /approve /deny /approvals /status /stream /reasoning commands')
}

async function handleModelCommand(
  invocation: CommandInvocation,
  llm: LlmDirectoryLike,
  agentDefaultModel: AgentDefaultModelConfig,
  bridge: Pick<HarnessConversationService, 'setCurrentSelection' | 'currentSelectionFor'>,
  chatMessageFor: (invocation: CommandInvocation) => ConversationMessage,
  t: CommandTranslations,
): Promise<CommandResult> {
  const rawInput = invocation.rawInput.trim()
  if (rawInput === 'list') {
    const list = await buildModelCatalog(llm, t)
    return { kind: 'success', text: list }
  }
  const route = parseModelRoute(rawInput)
  if (rawInput !== '' && route === undefined) {
    return { kind: 'error', text: `${t.modelUnknown(rawInput)}\n${t.modelUsage}` }
  }
  // Prefer the chat's live selection ref over the global default so the
  // status reflects in-flight switches made earlier in this session.
  const liveCurrent = bridge.currentSelectionFor(chatMessageFor(invocation))
  const defaultCurrent = agentDefaultModel.currentSelection()
  const current = liveCurrent ?? defaultCurrent
  if (route === undefined) {
    return {
      kind: 'success',
      text: `${t.modelCurrentHeader}\n• \`${current.provider}/${current.model}\``,
    }
  }
  const providers = new Set(llm.listProviders().map(provider => provider.id))
  if (!providers.has(route.provider)) {
    return { kind: 'error', text: `${t.modelUnknown(`${route.provider}/${route.model}`)}\n${t.modelUsage}` }
  }
  const selection = {
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort as never },
  }
  // saveSelection accepts a string-typed reasoning effort; cast at the boundary
  // because the parser does not yet know the target provider's brand type.
  await agentDefaultModel.saveSelection(selection as Parameters<AgentDefaultModelConfig['saveSelection']>[0])
  // Mutate the chat's cached selection ref so the agent loop's
  // `installModelSelection` listener reads the new provider/model on the next
  // inbound message. `setCurrentSelection` returns undefined when the chat has
  // not yet produced an agent (slash command before any user message); in
  // that case `agentDefaultModel.currentSelection()` already returns the new
  // value for the next `createAgent` call.
  const previous = bridge.setCurrentSelection(chatMessageFor(invocation), selection)
  const liveNote = previous === undefined ? t.modelPersisted : t.modelLiveApplied
  return { kind: 'success', text: `${t.modelSwitched(route.provider, route.model)}\n${liveNote}` }
}

const VALID_REASONING_LEVELS = ['off', 'low', 'high', 'max'] as const

/**
 * Handle `/reasoning [level] [show on|off]`. Show or change the reasoning effort.
 * The setting is persisted through agentDefaultModel.saveSelection so it
 * survives DSH restarts. `show on|off` toggles reasoning content display.
 */
async function handleReasoningCommand(
  invocation: CommandInvocation,
  agentDefaultModel: AgentDefaultModelConfig,
  bridge: Pick<HarnessConversationService, 'setCurrentSelection' | 'currentSelectionFor'>,
  chatMessageFor: (invocation: CommandInvocation) => ConversationMessage,
  t: CommandTranslations,
  showReasoning: { get: () => boolean; toggle: () => void },
): Promise<CommandResult> {
  const rawInput = invocation.rawInput.trim().toLowerCase()
  const current = agentDefaultModel.currentSelection()
  const currentEffort = current.reasoningEffort ? String(current.reasoningEffort) : undefined

  // Handle "show on/off" sub-command
  if (rawInput.startsWith('show')) {
    const arg = rawInput.slice(4).trim()
    if (arg === 'on' || arg === 'off') {
      const desired = arg === 'on'
      if (showReasoning.get() !== desired) {
        showReasoning.toggle()
      }
      return { kind: 'success', text: t.reasoningShowToggled(desired) }
    }
    // Show current state
    const state = showReasoning.get() ? 'on' : 'off'
    return { kind: 'success', text: `🧠 Reasoning content display: **${state}**\nUse \`/reasoning show on|off\` to toggle.` }
  }

  // No argument → show current level + show state
  if (rawInput === '') {
    const display = currentEffort ?? t.reasoningCurrentDefault
    const showState = showReasoning.get() ? 'on' : 'off'
    const lines = [
      t.reasoningCurrent(display),
      `🧠 Reasoning display: **${showState}**`,
      '',
      t.reasoningLevels,
    ]
    return { kind: 'success', text: lines.join('\n') }
  }

  // Validate level
  if (!(VALID_REASONING_LEVELS as readonly string[]).includes(rawInput)) {
    return { kind: 'error', text: `${t.reasoningUnknown(rawInput)}\n${t.reasoningLevels}` }
  }

  const level = rawInput as typeof VALID_REASONING_LEVELS[number]

  // Preserve existing provider/model, only change reasoningEffort
  const selection = {
    provider: current.provider,
    model: current.model,
    reasoningEffort: level as never,
  }
  await agentDefaultModel.saveSelection(selection)
  bridge.setCurrentSelection(chatMessageFor(invocation), selection)
  return { kind: 'success', text: t.reasoningSwitched(level) }
}

/**
 * Handle `/new`. Redirects the chat to a fresh, never-used session id so the
 * next regular message starts a clean conversation. The salt uses a
 * monotonically increasing counter so two consecutive `/new` calls in the
 * same chat land on different sessions.
 */
async function handleNewCommand(
  _invocation: CommandInvocation,
  bridge: Pick<HarnessConversationService, 'startNewSession'>,
  chatMessageFor: (invocation: CommandInvocation) => ConversationMessage,
  t: CommandTranslations,
): Promise<CommandResult> {
  const salt = `new-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const sessionId = bridge.startNewSession(chatMessageFor(_invocation), salt)
  return { kind: 'success', text: t.newSessionReady(sessionId) }
}

/**
 * Handle `/thread`. With no argument, list every persisted session so the
 * user can pick one by index; with a numeric argument, switch the chat to
 * that session. Listing never mutates state, so it is always safe to call.
 */
async function handleThreadCommand(
  invocation: CommandInvocation,
  bridge: Pick<HarnessConversationService, 'switchToSession' | 'listSessions'>,
  chatMessageFor: (invocation: CommandInvocation) => ConversationMessage,
  t: CommandTranslations,
): Promise<CommandResult> {
  const rawInput = invocation.rawInput.trim()
  if (rawInput === '') {
    const sessions = await bridge.listSessions()
    if (sessions.length === 0) {
      return { kind: 'success', text: t.threadListEmpty }
    }
    const lines = [t.threadListHeader]
    sessions.forEach((entry, index) => {
      // Cold sessions have no in-memory log to read titles from; show a short
      // id prefix instead of "(untitled)" so the user can still distinguish
      // them from live ones they have just started.
      const title = entry.title === '' ? t.threadIdle(entry.id) : entry.title.replace(/\s+/g, ' ').slice(0, 60)
      const lastActive = formatRelativeTime(entry.updatedAt, t)
      lines.push(t.threadListEntry(index + 1, entry.id, title, lastActive))
    })
    lines.push(t.threadUsage)
    return { kind: 'success', text: lines.join('\n') }
  }
  const index = Number.parseInt(rawInput, 10)
  if (!Number.isInteger(index) || index < 1) {
    return { kind: 'error', text: `${t.threadInvalidIndex}\n${t.threadUsage}` }
  }
  const sessions = await bridge.listSessions()
  const entry = sessions[index - 1]
  if (entry === undefined) {
    return { kind: 'error', text: `${t.threadInvalidIndex}\n${t.threadUsage}` }
  }
  if (!bridge.switchToSession(chatMessageFor(invocation), entry.id)) {
    return { kind: 'error', text: t.threadArchived }
  }
  return { kind: 'success', text: t.threadSwitched(index, entry.id) }
}

/**
 * Handle `/help`. Lists every slash command currently registered on the
 * receiving agent's command view, including commands contributed by other
 * plugins (e.g. `compact`, `goal`, `feedback`, `export`). Listing reads the
 * command runtime directly so newly-registered commands appear without any
 * change to this plugin.
 */
async function handleHelpCommand(
  invocation: CommandInvocation,
  commands: Pick<CommandRuntime, 'list'>,
  t: CommandTranslations,
): Promise<CommandResult> {
  const descriptors = commands.list(invocation.agent)
  if (descriptors.length === 0) {
    return { kind: 'success', text: t.helpEmpty }
  }
  const lines = [t.helpHeader]
  for (const descriptor of descriptors) {
    lines.push(t.helpEntry(
      descriptor.name,
      descriptor.description,
      descriptor.input?.hint,
    ))
  }
  lines.push(t.helpUsage)
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Handle `/approve` and `/deny`. With no input, targets the most-recent
 * pending approval in the receiving agent's session; with a shortCode
 * argument, targets the matching pending approval. Replies with a short
 * human-readable summary the user can verify in the chat log.
 */
async function handleApprovalCommand(
  invocation: CommandInvocation,
  approvals: ApprovalControl,
  outcome: 'allowed-once' | 'rejected',
  t: CommandTranslations,
): Promise<CommandResult> {
  const sessionId = invocation.agent.session.id as unknown as string
  const rawInput = invocation.rawInput.trim()
  const list = approvals.pendingForSession(sessionId)
  if (list.length === 0) {
    // Either nothing is pending, or the matching session belongs to a
    // chat that is not this Feishu chat (an in-flight webui approval on
    // the same session would still be on the list — but webui users would
    // have answered it themselves before this command fires). Surface a
    // clear error so the user does not assume the slash command succeeded.
    return { kind: 'error', text: t.approveApprovedNoPending }
  }
  const target = rawInput === ''
    ? list[0]
    : approvals.findPending(sessionId, rawInput)
  if (target === undefined) {
    return { kind: 'error', text: `${t.approveUnknownShort(rawInput)}\n${t.approveDenyUsage}` }
  }
  await approvals.settle(target, outcome)
  return {
    kind: 'success',
    text: outcome === 'allowed-once'
      ? t.approveApproved(target.shortCode, target.toolName)
      : t.denyDenied(target.shortCode, target.toolName),
  }
}

/**
 * Handle `/approvals`. Lists every pending approval for the receiving
 * agent's session so the user can identify the shortCode to feed back
 * into `/approve<short>` / `/deny<short>`.
 */
async function handleListApprovalsCommand(
  invocation: CommandInvocation,
  approvals: ApprovalControl,
  t: CommandTranslations,
): Promise<CommandResult> {
  const sessionId = invocation.agent.session.id as unknown as string
  const list = approvals.pendingForSession(sessionId)
  if (list.length === 0) {
    return { kind: 'success', text: t.approvalsEmpty }
  }
  const now = Date.now()
  const lines = [t.approvalsHeader]
  list.forEach((view, index) => {
    const age = formatApprovalAge(view.createdAt, t, now)
    lines.push(t.approvalsEntry(index + 1, view.shortCode, view.toolName, age))
  })
  lines.push(t.approveDenyUsage)
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Handle `/status`. Shows the current session's metadata: session id,
 * workspace, agent preset, and model — matching the reply-card footer.
 */
async function handleStatusCommand(
  invocation: CommandInvocation,
  bridge: Pick<HarnessConversationService, 'getSessionMeta'>,
  chatMessageFor: (invocation: CommandInvocation) => ConversationMessage,
  t: CommandTranslations,
): Promise<CommandResult> {
  const meta = await bridge.getSessionMeta(chatMessageFor(invocation))
  return { kind: 'success', text: t.statusOutput(meta) }
}