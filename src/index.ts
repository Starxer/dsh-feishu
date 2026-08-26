import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { CommandRuntime, CommandResult, CommandExecution } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { createLarkChannel } from '@larksuiteoapi/node-sdk'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { ConfigSchema, LARK_SETTINGS_NAMESPACE, resolveSettingsConfig } from './config.ts'
import type { Config as PluginConfig, SettingsConfig } from './config.ts'
import { HarnessConversationService } from './harness.ts'
import type { ConversationMessage } from './conversation.ts'
import { startChannel, type SlashCommandHandler } from './channel.ts'
import { LarkRuntime } from './runtime.ts'
import { createSettingsApi } from './settings-api.ts'
import { renderTerminalQr } from './provision.ts'
import { ProvisionManager } from './provision-manager.ts'
import { registerLarkCommands, formatRelativeTime, type ApprovalControl, type CommandTranslations } from './commands.ts'
import { handleProvisionRequest, handleSettingsRequest, PROVISION_PATH, SETTINGS_PATH } from './web.ts'
import { startFeishuApprovals, type PendingApprovalView } from './feishu-approvals.ts'
import { startFeishuTodos } from './feishu-todos.ts'
import { startFeishuStreaming } from './feishu-streaming.ts'
import type { TurnStats } from './feishu-streaming.ts'

export const name = 'lark-channel'
export const inject = [
  'agents', 'sessions', 'sessionPersistence', 'agentDefaultModel', 'agentPresets', 'workspaceRegistry',
  'settings', 'credentials', 'webServer', 'commands', 'llm', 'attachments', 'apiProxy',
]
export const Config = ConfigSchema
export type { PluginConfig }
export { ConfigSchema } from './config.ts'

import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { startFeishuQuestions } from './feishu-questions.ts'

export async function apply(ctx: Context, rawConfig: PluginConfig): Promise<void> {
  console.log('dsh-feishu: apply() called, apiProxy=', ctx.get('apiProxy') !== undefined ? 'available' : 'UNDEFINED')
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const sessionPersistence = ctx.get('sessionPersistence')
  const defaultModel = ctx.get('agentDefaultModel')
  const agentPresets = ctx.get('agentPresets')
  const apiProxy = ctx.get('apiProxy') as ApiProxy | undefined
  const workspaceRegistry = ctx.get('workspaceRegistry')
  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')
  const webServer = ctx.get('webServer')
  const commands = ctx.get('commands')
  const llm = ctx.get('llm') as LlmRuntime | undefined
  const attachments = ctx.get('attachments')
  if (agents === undefined || sessions === undefined || sessionPersistence === undefined || defaultModel === undefined || agentPresets === undefined || workspaceRegistry === undefined || settings === undefined || credentials === undefined || webServer === undefined) {
    throw new Error('dsh-feishu requires Harness agent, settings, credentials, workspace, and webServer services')
  }
  if (commands === undefined || llm === undefined) {
    throw new Error('dsh-feishu requires commands and llm services for /model support')
  }
  if (attachments === undefined) {
    throw new Error('dsh-feishu requires the attachments service for inbound image messages')
  }
  // apiProxy is optional: when absent (Feishu-only deployments without the
  // web-app bundle), we simply skip the questions listener. The harness's own
  // user-questions provider still runs, so an answer via the WebUI is the
  // only path in that case — the Feishu chat gets no card. We log the gap so
  // operators see why a deployment loses the option UI.
  if (apiProxy === undefined) {
    ctx.logger('dsh-feishu').warn('dsh-feishu: apiProxy unavailable — streaming/questions/approvals/toolcalls/todos will not work')
  } else {
    ctx.logger('dsh-feishu').info('dsh-feishu: apiProxy available — will start streaming/questions/approvals listeners')
  }

  const settingsScope = settings.register(
    settingsNamespace(LARK_SETTINGS_NAMESPACE),
    ConfigSchema,
    { base: rawConfig, applies: 'live' },
  )
  const namespace = settingsNamespace(LARK_SETTINGS_NAMESPACE)
  const currentSettings = (): SettingsConfig => resolveSettingsConfig(settingsScope.get())
  const currentRevision = () => settings.describe({ redactSecrets: true }).find(item => item.ns === namespace)?.revision ?? 0
  let apiUpdateDepth = 0

  // The bridge is recreated every time the Lark channel reconciles; hold it
  // in a single-cell so the `/model` command always reaches the bridge that
  // is currently serving the inbound message. `lastChatMessage` is overwritten
  // on every inbound message under `chatQueue.enabled: true`, so a synchronous
  // command dispatch sees its own chat coordinates; concurrent chats in
  // different sessions are serialized by the queue and the race never happens.
  const bridgeHolder: {
    current: HarnessConversationService | undefined
    lastChatMessage: { chatId: string; chatType: 'p2p' | 'group'; threadId?: string } | undefined
  } = { current: undefined, lastChatMessage: undefined }
  // Channel adapter and listener registry live above `registerLarkCommands`
  // so the approval-control adapter they produce is available when the
  // command handlers register. The actual SSE iteration starts only after
  // the runtime reconnects (see the `runtime.onChannelChange` hook).
  let stopQuestions: () => void = () => undefined
  let stopApprovals: () => void = () => undefined
  let stopStreaming: () => void = () => undefined
  let consumeReasoning: (sessionId: string) => string | undefined = () => undefined
  let consumeLastStepHadContent: (sessionId: string) => boolean = () => false
  let flushed: (sessionId: string) => Promise<TurnStats | undefined> = () => Promise.resolve(undefined)
  let stopTodos: () => void = () => undefined
  const channelHolder: { current: LarkChannel | undefined } = { current: undefined }
  const buildApprovalControl = (apiProxy: ApiProxy): ApprovalControl => {
    const approvalsHandle = startFeishuApprovals({
      apiProxy,
      channel: cardChannel,
      bridgeHolder,
      logger: ctx.logger('dsh-feishu'),
    })
    stopApprovals = approvalsHandle.stop
    return {
      pendingForSession: approvalsHandle.pendingForSession,
      findPending: approvalsHandle.findPending,
      async settle(view: PendingApprovalView, outcome: 'allowed-once' | 'rejected') {
        // Use the approvals handle's settle which tracks the card messageId
        // and updates the approval card after settlement.
        await approvalsHandle.settle(view.rpcId, outcome)
      },
    }
  }
  type CardActionEvent = {
    messageId?: string
    chatId?: string
    operator?: { openId?: string }
    action?: { value?: unknown; tag?: string; option?: string }
  }
  const cardActionHandlers = new Set<(evt: CardActionEvent) => void | Promise<void>>()
  const attachedChannels = new Set<LarkChannel>()
  const cardChannel = {
    send: (to: string, input: { card: object }, opts?: { replyInThread?: boolean }): Promise<{ messageId?: string }> => {
      const ch = channelHolder.current
      if (ch === undefined) return Promise.reject(new Error('dsh-feishu: channel not connected'))
      return ch.send(to, input, opts) as Promise<{ messageId?: string }>
    },
    updateCard: (messageId: string, card: object): Promise<void> => {
      const ch = channelHolder.current
      if (ch === undefined) return Promise.reject(new Error('dsh-feishu: channel not connected'))
      return ch.updateCard(messageId, card)
    },
    onCardAction: (handler: (evt: CardActionEvent) => void | Promise<void>): (() => void) => {
      cardActionHandlers.add(handler)
      const attach = (ch: LarkChannel): (() => void) => {
        if (attachedChannels.has(ch)) return () => undefined
        attachedChannels.add(ch)
        return ch.on('cardAction', (...args) => {
          for (const h of cardActionHandlers) void h(args[0] as CardActionEvent)
        })
      }
      const unsubList: Array<() => void> = []
      if (channelHolder.current !== undefined) {
        const u = attach(channelHolder.current)
        if (u !== undefined) unsubList.push(u)
      }
      const previous = runtime.onChannelChange
      runtime.onChannelChange = (ch) => {
        previous?.(ch)
        const u = attach(ch)
        if (u !== undefined) unsubList.push(u)
      }
      return () => {
        cardActionHandlers.delete(handler)
        for (const u of unsubList) u()
      }
    },
  }
  // The questions listener is paired with the approvals listener: they share
  // the cardChannel adapter so a single cardAction dispatcher feeds both.
  // When apiProxy is missing, both no-op (slash commands fall back to
  // errors explaining no pending approvals / questions).
  const runtime = new LarkRuntime({
    settings: currentSettings,
    resolveSecret: async ref => (await credentials.resolve(credentialRef(ref)))?.value,
    start: async config => {
      const dshHome = process.env.DSH_HOME || `${homedir()}/.dsh`
      const statePath = `${dshHome}/lark-session-map.json`
      const bridge = new HarnessConversationService({
        agents,
        sessions,
        sessionPersistence,
        selection: () => defaultModel.currentSelection(),
        agentPresets,
        workspaceRegistry,
      }, { ...config, statePath })
      bridgeHolder.current = bridge
      return startChannel(
        config,
        bridge,
        createLarkChannel,
        ctx.logger,
        console,
        message => executeSlashCommand(message, bridge, commands, bridgeHolder, () => {
          const current = currentSettings().showIntermediateMessages
          const next = !current
          ctx.logger('dsh-feishu').info(`dsh-feishu: /stream toggle: ${current} → ${next}`)
          void settings.mutate(namespace, [{ op: 'set', path: ['showIntermediateMessages'], value: next }], currentRevision())
          return { enabled: next as boolean }
        }, apiProxy),
        attachments,
        async (coords) => {
          const meta = await bridge.getSessionMeta(coords as ConversationMessage)
          return {
            workspace: meta.workspace,
            agentPreset: meta.agentPreset,
            model: meta.model,
            reasoningEffort: meta.reasoningEffort,
            contextWindow: meta.contextWindow,
            lastInputTokens: meta.lastInputTokens,
          }
        },
        undefined,  // consumeReasoning (unused; bridge handles intermediate tracking)
        undefined,  // consumeLastStepHadContent (unused)
        flushed,
      )
    },
  })
  // Pin the channel holder so the card adapter's `send`/`onCardAction` always
  // reach the live channel. The questions/approvals listeners wrap this
  // callback to also attach their cardAction handlers on reconnect.
  runtime.onChannelChange = channel => {
    channelHolder.current = channel
  }
  if (apiProxy !== undefined) {
    stopQuestions = startFeishuQuestions({
      apiProxy,
      channel: cardChannel,
      bridgeHolder,
      logger: ctx.logger('dsh-feishu'),
    })
    stopTodos = startFeishuTodos({
      apiProxy,
      channel: cardChannel,
      bridgeHolder,
      logger: ctx.logger('dsh-feishu'),
    })
    const streamingResult = startFeishuStreaming({
      apiProxy,
      channel: cardChannel,
      bridgeHolder,
      logger: ctx.logger('dsh-feishu'),
      showReasoning: () => currentSettings().showReasoning,
    })
    stopStreaming = streamingResult.stop
    consumeReasoning = streamingResult.consumeReasoning
    consumeLastStepHadContent = streamingResult.consumeLastStepHadContent
    flushed = streamingResult.flushed
  }
  registerLarkCommands(
    ctx,
    llm,
    defaultModel,
    {
      setCurrentSelection: (chatMessage, next) => bridgeHolder.current?.setCurrentSelection(chatMessage, next),
      currentSelectionFor: chatMessage => bridgeHolder.current?.currentSelectionFor(chatMessage),
      startNewSession: (chatMessage, salt) => bridgeHolder.current?.startNewSession(chatMessage, salt) ?? '',
      switchToSession: (chatMessage, sessionId) => bridgeHolder.current?.switchToSession(chatMessage, sessionId) ?? false,
      listSessions: async () => bridgeHolder.current?.listSessions() ?? [],
      getSessionMeta: async (chatMessage) => bridgeHolder.current?.getSessionMeta(chatMessage) ?? { sessionId: '', workspace: '', agentPreset: '', model: '', reasoningEffort: '', title: '', turns: 0, steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, contextWindow: 0, lastInputTokens: 0, cacheHitRate: 0, ttftAvgMs: 0, tokensPerSecond: 0, llmDurationMs: 0, toolDurationMs: 0 },
    },
    () => {
      const last = bridgeHolder.lastChatMessage
      if (last === undefined) {
        throw new Error('dsh-feishu: chat coordinates missing for /model command — send a regular message first')
      }
      return last
    },
    larkCommandTranslations,
    commands,
    apiProxy === undefined
      ? {
          pendingForSession: () => [],
          findPending: () => undefined,
          async settle() { /* noop when apiProxy is absent */ },
        }
      : buildApprovalControl(apiProxy),
    {
      get: () => currentSettings().showReasoning,
      toggle: () => {
        const current = currentSettings().showReasoning
        void settings.mutate(namespace, [{ op: 'set', path: ['showReasoning'], value: !current }], currentRevision())
      },
    },
  )
  ctx.effect(() => () => {
    stopQuestions()
    stopApprovals()
    stopTodos()
    stopStreaming()
  }, 'dsh-feishu: feishu questions + approvals + todos + streaming listeners')

  let lastPrintedQrUrl: string | undefined
  const provisionManager = new ProvisionManager({
    domain: () => currentSettings().domain,
    onState: state => {
      if (state.phase === 'waiting' && state.qrUrl !== undefined && state.qrUrl !== lastPrintedQrUrl) {
        lastPrintedQrUrl = state.qrUrl
        renderTerminalQr(state.qrUrl, ctx.logger)
      }
    },
    onProvisioned: async result => {
      const ref = currentSettings().appSecretRef
      apiUpdateDepth += 1
      try {
        await credentials.set(credentialRef(ref), result.appSecret)
        await settings.mutate(namespace, [{ op: 'set', path: ['appId'], value: result.appId }], currentRevision())
      } finally {
        apiUpdateDepth -= 1
      }
      await runtime.reconcile()
    },
  })

  const api = createSettingsApi({
    getSettings: currentSettings,
    revision: currentRevision,
    beginUpdate: () => { apiUpdateDepth += 1 },
    endUpdate: () => { apiUpdateDepth -= 1 },
    updateSettings: (patch, unset, expectedRevision) => settings.mutate(namespace, [
      ...Object.entries(patch).map(([key, value]) => ({ op: 'set' as const, path: [key], value })),
      ...unset.map(key => ({ op: 'unset' as const, path: [key] })),
    ], expectedRevision),
    credentials: {
      describe: ref => credentials.describe(credentialRef(ref)),
      set: (ref, value) => credentials.set(credentialRef(ref), value),
      unset: ref => credentials.unset(credentialRef(ref)),
    },
    runtimeStatus: () => runtime.status(),
    reconcile: () => runtime.reconcile(),
    provision: {
      status: () => provisionManager.status(),
      start: () => provisionManager.start(),
    },
  })

  settingsScope.watch(() => apiUpdateDepth > 0 ? undefined : runtime.reconcile())
  ctx.on('credentials/updated', ref => {
    if (apiUpdateDepth === 0 && ref === currentSettings().appSecretRef) void runtime.reconcile()
  })
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: SETTINGS_PATH,
    handler: (req, res) => handleSettingsRequest(req, res, api),
  }), 'dsh-feishu: settings page')
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: PROVISION_PATH,
    handler: (req, res) => handleProvisionRequest(req, res, api),
  }), 'dsh-feishu: provision endpoint')
  ctx.effect(() => () => {
    provisionManager.dispose()
    return runtime.dispose()
  }, 'dsh-feishu: runtime')
  await runtime.reconcile()
}

/**
 * Localized strings for the `/model` command. Keeping these inline (rather
 * than registering a locale namespace) keeps the dependency surface small —
 * the strings are owned by the Feishu-facing command handler and rarely
 * change.
 */

/** Compact token count display: 517 / 12.2K / 1.2M */
function formatTokenCount(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}K`
  return `${Math.round(n / 100_000) / 10}M`
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

const larkCommandTranslations: CommandTranslations = {
  modelDescription: 'Show, list, or switch the active model',
  modelCurrentHeader: 'Current model:',
  modelUsage: 'Usage: /model [list|<provider>/<model>[:reasoning]]',
  modelListHeader: 'Available models:',
  modelListEmpty: 'No registered providers are available.',
  modelSwitched: (provider, model) => `Switched default model to \`${provider}/${model}\`.`,
  modelUnknown: route => `Unknown model route "${route}".`,
  modelPersisted: 'The change is persisted; the next message in this chat will use it.',
  modelLiveApplied: 'The change applies to this chat immediately on the next message.',
  newDescription: 'Start a fresh conversation in this chat',
  newSessionReady: sessionId => `Started a new conversation. Next message uses session \`${sessionId}\`.`,
  threadDescription: 'List persisted sessions or switch the chat to one by index',
  threadUsage: 'Usage: /thread [N]',
  threadListHeader: 'Available sessions (reply with `/thread N` to switch):',
  threadListEmpty: 'No persisted sessions yet.',
  threadListEntry: (index, id, title, lastActive) => `${index}. ${title} — ${lastActive} (\`${id}\`)`,
  threadSwitched: (index, id) => `Switched to session #${index} (\`${id}\`).`,
  threadInvalidIndex: 'Invalid session index.',
  threadArchived: 'That session is archived — unarchive it from the workspace webui first.',
  threadIdle: id => `(idle: ${id.slice(-12)})`,
  threadLastActiveJustNow: 'just now',
  threadLastActiveMinutesAgo: n => `${n}m ago`,
  threadLastActiveHoursAgo: n => `${n}h ago`,
  threadLastActiveDaysAgo: n => `${n}d ago`,
  threadLastActiveUnknown: 'unknown',
  helpDescription: 'List every slash command available in this chat',
  helpHeader: 'Available commands:',
  helpUsage: 'Send `/<name> [arguments]` to run a command. Optional input hints appear in `[brackets]`.',
  helpEntry: (name, description, hint) => hint === undefined
    ? `• \`/${name}\` — ${description}`
    : `• \`/${name}\` — ${description} \`[${hint}]\``,
  helpEmpty: 'No slash commands are available right now.',
  approveDescription: 'Approve the most recent (or `<shortCode>`) pending approval in this chat',
  approveApproveHint: '[shortCode]',
  approveApprovedNoPending: 'No pending approvals on this session — nothing to approve.',
  approveApproved: (shortCode, toolName) => `✅ Approved \`${toolName}\` (\`${shortCode}\`). The agent continues.`,
  approveUnknownShort: shortCode => `No pending approval with id \`${shortCode}\` on this session.`,
  denyDescription: 'Reject the most recent (or `<shortCode>`) pending approval in this chat',
  denyHint: '[shortCode]',
  denyDenied: (shortCode, toolName) => `❌ Rejected \`${toolName}\` (\`${shortCode}\`). The agent stops.`,
  approveDenyUsage: 'Usage: `/approve` or `/approve <shortCode>` (and `/deny` likewise). Run `/approvals` to see the short codes.',
  approvalsDescription: 'List every pending approval for this chat with its short code',
  approvalsEmpty: 'No pending approvals on this session.',
  approvalsHeader: 'Pending approvals (newest first):',
  approvalsEntry: (index, shortCode, toolName, age) => `${index}. \`${shortCode}\` — \`${toolName}\` — ${age}`,
  approvalsAgeJustNow: 'just now',
  approvalsAgeSeconds: n => `${n}s ago`,
  approvalsAgeMinutes: n => `${n}m ago`,
  approvalsAgeHours: n => `${n}h ago`,
  statusDescription: 'Show current session status (workspace, preset, model, stats)',
  statusOutput: (meta) => {
    const lines = [
      '**Session Status**',
      `• Session: \`${meta.sessionId}\``,
    ]
    if (meta.title !== '') lines.push(`• Title: ${meta.title}`)
    lines.push(
      `• Workspace: \`${meta.workspace || '(default)'}\``,
      `• Preset: \`${meta.agentPreset || '(default)'}\``,
      `• Model: \`${meta.model}\``,
    )
    if (meta.turns > 0 || meta.steps > 0) {
      const parts: string[] = [`${meta.turns} turns`, `${meta.steps} steps`]
      if (meta.toolCalls > 0) parts.push(`${meta.toolCalls} tool calls`)
      lines.push(`• Activity: ${parts.join(' · ')}`)
      if (meta.inputTokens > 0 || meta.outputTokens > 0) {
        lines.push(`• Tokens: ${formatTokenCount(meta.inputTokens)} in · ${formatTokenCount(meta.outputTokens)} out`)
      }
      if (meta.cacheHitRate > 0) {
        lines.push(`• Cache hit: ${meta.cacheHitRate}%`)
      }
      if (meta.llmDurationMs > 0 || meta.toolDurationMs > 0) {
        const durParts: string[] = []
        if (meta.llmDurationMs > 0) durParts.push(`LLM ${formatDuration(meta.llmDurationMs)}`)
        if (meta.toolDurationMs > 0) durParts.push(`Tools ${formatDuration(meta.toolDurationMs)}`)
        lines.push(`• Duration: ${durParts.join(' · ')}`)
      }
      if (meta.ttftAvgMs > 0) {
        lines.push(`• TTFT avg: ${formatDuration(meta.ttftAvgMs)}`)
      }
      if (meta.tokensPerSecond > 0) {
        lines.push(`• Throughput: ${meta.tokensPerSecond} tok/s`)
      }
    }
    if (meta.contextWindow > 0) {
      const pct = Math.min(100, Math.round(meta.lastInputTokens / meta.contextWindow * 100))
      lines.push(`• Context: ${formatTokenCount(meta.lastInputTokens)} / ${formatTokenCount(meta.contextWindow)} (${pct}%)`)
    }
    return lines.join('\n')
  },
  streamDescription: 'Toggle intermediate assistant messages during agent turns',
  stopDescription: 'Stop the currently running agent in this chat (like the WebUI stop button)',
  reasoningDescription: 'Show or change the model reasoning effort (thinking intensity)',
  reasoningUsage: 'Usage: /reasoning [off|low|high|max] [show on|off]',
  reasoningCurrent: (effort: string) => `🧠 Current reasoning effort: **${effort}**`,
  reasoningCurrentDefault: '(provider default)',
  reasoningSwitched: (effort: string) => `🧠 Reasoning effort switched to **${effort}**. Persisted across restarts.`,
  reasoningLevels: 'Available levels: `off` · `low` · `high` · `max`\nUse `/reasoning show on|off` to toggle reasoning content display.',
  reasoningUnknown: (level: string) => `Unknown reasoning level "${level}".`,
  reasoningShowToggled: (enabled: boolean) => `🧠 Reasoning content display: **${enabled ? 'on' : 'off'}**. Persisted across restarts.`,
}

/** Render the /status result as a Feishu interactive card. */
function renderStatusCard(meta: {
  sessionId: string; workspace: string; agentPreset: string; model: string; reasoningEffort: string; title: string
  turns: number; steps: number; toolCalls: number; inputTokens: number; outputTokens: number
  contextWindow: number; lastInputTokens: number
}, agentRunning: boolean): object {
  const fields: string[] = []
  fields.push(`**Session:** \`${meta.sessionId}\``)
  if (meta.title !== '') fields.push(`**Title:** ${meta.title}`)
  fields.push(`**Workspace:** \`${meta.workspace || '(default)'}\``)
  fields.push(`**Preset:** \`${meta.agentPreset || '(default)'}\``)
  fields.push(`**Model:** \`${meta.model}\``)
  if (meta.reasoningEffort !== '') fields.push(`**Reasoning:** \`${meta.reasoningEffort}\``)
  fields.push(`**Agent:** ${agentRunning ? '🔄 Running' : '⏸️ Idle'}`)
  if (meta.turns > 0 || meta.steps > 0) {
    const parts: string[] = [`${meta.turns} turns`, `${meta.steps} steps`]
    if (meta.toolCalls > 0) parts.push(`${meta.toolCalls} tool calls`)
    fields.push(`**Activity:** ${parts.join(' · ')}`)
    if (meta.inputTokens > 0 || meta.outputTokens > 0) {
      fields.push(`**Tokens:** ${formatTokenCount(meta.inputTokens)} in · ${formatTokenCount(meta.outputTokens)} out`)
    }
  }
  if (meta.contextWindow > 0) {
    const pct = Math.min(100, Math.round(meta.lastInputTokens / meta.contextWindow * 100))
    fields.push(`**Context:** ${formatTokenCount(meta.lastInputTokens)} / ${formatTokenCount(meta.contextWindow)} (${pct}%)`)
  }
  if (agentRunning) {
    fields.push('')
    fields.push('> ⚠️ Agent 正在运行中，以上信息可能并非最新。请在 Agent 运行结束后再次发送 `/status` 获取准确信息。')
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📊 Session Status' },
      template: 'turquoise',
    },
    body: { elements: [{ tag: 'markdown', content: fields.join('\n') }] },
  }
}

/** Handle /thread directly without needing a live agent. */
async function handleThreadDirect(
  rawInput: string,
  bridge: HarnessConversationService,
  chatMessage: ConversationMessage,
): Promise<{ kind: 'success' | 'error'; text: string }> {
  const t = larkCommandTranslations
  if (rawInput === '') {
    const sessions = await bridge.listSessions()
    if (sessions.length === 0) return { kind: 'success', text: t.threadListEmpty }
    const lines = [t.threadListHeader]
    sessions.forEach((entry, index) => {
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
  if (!bridge.switchToSession(chatMessage, entry.id)) {
    return { kind: 'error', text: t.threadArchived }
  }
  return { kind: 'success', text: t.threadSwitched(index, entry.id) }
}

/**
 * Detect a slash command in an inbound chat message and dispatch it through
 * the Harness command runtime, returning the textual result so the channel
 * can echo it back to the user. A `undefined` return signals that the
 * message is not a command and should fall through to the agent reply.
 */
async function executeSlashCommand(
  message: NormalizedMessage,
  bridge: HarnessConversationService,
  commands: CommandRuntime,
  bridgeHolder: { lastChatMessage: { chatId: string; chatType: 'p2p' | 'group'; threadId?: string } | undefined },
  toggleStream?: () => { enabled: boolean },
  apiProxy?: ApiProxy,
): Promise<{ kind: 'success' | 'error'; text: string; card?: object } | undefined> {
  const parsed = parseCommand(message.content)
  if (parsed === undefined) return undefined
  const chatMessage = {
    chatId: message.chatId,
    chatType: message.chatType,
    ...message.threadId === undefined ? {} : { threadId: message.threadId },
  }
  // /status, /new, /thread are handled directly — they don't need a live agent.
  if (parsed.name === 'status') {
    const meta = await bridge.getSessionMeta(chatMessage)
    const agentRunning = bridge.isAgentRunning(chatMessage)
    return { kind: 'success', text: '', card: renderStatusCard(meta, agentRunning) }
  }
  if (parsed.name === 'new') {
    const salt = `new-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const sessionId = bridge.startNewSession(chatMessage, salt)
    return { kind: 'success', text: larkCommandTranslations.newSessionReady(sessionId) }
  }
  if (parsed.name === 'thread') {
    return await handleThreadDirect(parsed.rawInput.trim(), bridge, chatMessage)
  }
  if (parsed.name === 'stream') {
    if (toggleStream === undefined) {
      return { kind: 'error', text: 'Stream mode toggle is not available.' }
    }
    const result = toggleStream()
    const lines = [
      result.enabled
        ? '🟢 Streaming intermediate assistant messages: **ON**'
        : '🔴 Streaming intermediate assistant messages: **OFF**',
      '',
      'When ON, assistant text responses between tool calls will appear as purple cards in the chat.',
      'This setting persists across restarts.',
    ]
    return { kind: 'success', text: lines.join('\n') }
  }
  // /stop cancels the running agent — mirrors the WebUI stop button's
  // `sessions.cancel` RPC. Unlike `/approve`/`/deny`, this does not need
  // a live agent handle; the apiProxy call reaches the host directly.
  if (parsed.name === 'stop') {
    if (apiProxy === undefined) {
      return { kind: 'error', text: '⚠️ Cannot stop: apiProxy is not available.' }
    }
    // Resolve the session id for this chat without creating an agent.
    const sessionId = bridge.resolveSessionIdFor(chatMessage)
    try {
      const response = await apiProxy.sessions.cancel({
        rpcId: RpcId(`feishu-stop-${Date.now()}`),
        payload: { sessionId: sessionId as never },
      })
      if (response.result.ok) {
        return { kind: 'success', text: '⏹️ Agent 已停止。当前 turn 的工具执行将尽快终止。' }
      }
      // Known error codes
      const code = response.result.error?.code
      if (code === 'session-not-found') {
        return { kind: 'error', text: '⚠️ 该 session 当前没有运行中的 agent，无需停止。' }
      }
      return { kind: 'error', text: `⚠️ 停止失败: ${response.result.error?.message ?? 'unknown error'} (${code ?? 'no code'})` }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: `⚠️ 停止失败: ${msg}` }
    }
  }
  // Stash the chat coordinates so the registered handler can find them
  // without holding per-invocation state on the agent. The bridge serializes
  // inbound messages per chat, so a synchronous dispatch always sees its own
  // chat context here.
  bridgeHolder.lastChatMessage = chatMessage
  const agent = await bridge.resolveAgent(chatMessage)
  if (agent === undefined) {
    return {
      kind: 'error',
      text: 'Slash commands need an existing conversation in this chat — send a regular message first.',
    }
  }
  const controller = new AbortController()
  const line = `/${parsed.name}${parsed.rawInput}`
  // `commands.execute` is reached through Cordis's traceable Proxy, which
  // shadows every method call's `thisArg` (see vendor/cordis `createShadowMethod`).
  // Extracting it to a local `execute` and invoking as a free function would
  // detach `this`, causing `this.view(agent)` inside the runtime to throw
  // "Cannot read properties of undefined (reading 'view')". Call it as a
  // method on `commands` so the proxy sees the correct receiver.
  //
  // The 4-arg shape `(agent, line, images, signal)` matches `^0.1.0-rc.7`
  // and later; the plugin has no image-attachment path so we pass `[]`.
  const execution = await commands.execute(agent, line, [], controller.signal) as CommandExecution | undefined
  if (execution === undefined) return undefined
  const result: CommandResult = execution.result
  return { kind: result.kind, text: result.text ?? `Command /${parsed.name} produced no output.` }
}

// Keep the SlashCommandHandler import live for callers that prefer the type
// alias without reaching into `./channel.ts`.
export type { SlashCommandHandler }
