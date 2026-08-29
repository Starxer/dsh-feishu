import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import type {} from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
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
  'settings', 'credentials', 'webServer', 'commands', 'llm', 'attachments', 'tools',
  'sessionController', 'userQuestions', 'approval',
]
export const Config = ConfigSchema
export type { PluginConfig }
export { ConfigSchema } from './config.ts'

import { startFeishuQuestions } from './feishu-questions.ts'
import { startFeishuSendFileTool } from './feishu-send-file.ts'
import { startFeishuModelSelect, renderProviderSelectCard, sendModelCardV2, type ModelSelectChannel } from './feishu-model-select.ts'
import { startFeishuOnboarding, type FeishuOnboardingHandle } from './feishu-onboarding.ts'
import type { ChatCreationOptions } from './harness.ts'

/** DSH file-sandbox mode vocabulary (mirrors `dsh-sandbox-policy`). */
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const

export async function apply(ctx: Context, rawConfig: PluginConfig): Promise<void> {
  console.log('dsh-feishu: apply() called, sessionController=', ctx.get('sessionController') !== undefined ? 'available' : 'UNDEFINED', 'userQuestions=', ctx.get('userQuestions') !== undefined ? 'available' : 'UNDEFINED', 'approval=', ctx.get('approval') !== undefined ? 'available' : 'UNDEFINED')
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const sessionPersistence = ctx.get('sessionPersistence')
  const defaultModel = ctx.get('agentDefaultModel')
  const agentPresets = ctx.get('agentPresets')
  const sessionController = ctx.get('sessionController')
  const sandboxPolicy = ctx.get('sandboxPolicy') as { resolve?: (r: { session?: any }) => { mode: string; workspaceRoot?: string } } | undefined
  const userQuestions = ctx.get('userQuestions')
  const approval = ctx.get('approval')
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
  // All three capability seams (session controller, user questions, approval)
  // must be present for the streaming, question, and approval listeners to
  // register. Without them the plugin still binds to Lark but the per-step
  // cards, question cards, and approval cards are disabled.
  const seamNames: Array<[string, unknown]> = [
    ['sessionController', sessionController],
    ['userQuestions', userQuestions],
    ['approval', approval],
  ]
  const missing = seamNames.filter(([, v]) => v === undefined).map(([n]) => n)
  if (missing.length > 0) {
    ctx.logger('dsh-feishu').warn(`dsh-feishu: missing services ${missing.join(', ')} — streaming/questions/approvals/toolcalls/todos will not work`)
  } else {
    ctx.logger('dsh-feishu').info('dsh-feishu: all capability seams present — will start streaming/questions/approvals listeners')
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
  let stopSendFileTool: () => void = () => undefined
  let modelSelectHandle: { dispose: () => void; cardByMessage: Map<string, string>; sequenceByCard: Map<string, number> } | undefined = undefined
  let onboardingHandle: FeishuOnboardingHandle | undefined = undefined
  const channelHolder: { current: LarkChannel | undefined } = { current: undefined }
  // The approvals handle IS the ApprovalControl surface; the new
  // approval/request waterfall listener inside startFeishuApprovals owns the
  // request fan-out and the settle() closes the listener's deferred promise.
  // The actual startFeishuApprovals call is deferred until cardChannel is
  // declared below.
  const buildApprovalControl = (): ApprovalControl => {
    const approvalsHandle = startFeishuApprovals({
      ctx,
      channel: cardChannel,
      bridgeHolder,
      logger: ctx.logger('dsh-feishu'),
    })
    stopApprovals = approvalsHandle.stop
    return {
      pendingForSession: approvalsHandle.pendingForSession,
      findPending: approvalsHandle.findPending,
      async settle(view: PendingApprovalView, outcome: 'allowed-once' | 'rejected') {
        await approvalsHandle.settle(view.pendingId, outcome)
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
    send: (to: string, input: { card: object } | { text: string }, opts?: { replyInThread?: boolean }): Promise<{ messageId?: string }> => {
      const ch = channelHolder.current
      if (ch === undefined) return Promise.reject(new Error('dsh-feishu: channel not connected'))
      return ch.send(to, input, opts) as Promise<{ messageId?: string }>
    },
    /**
     * Create a Feishu card instance (cardkit.v1.card.create) and return its
     * `card_id`. The instance can be referenced from messages and updated
     * unlimited times via {@link updateCardInstance} — unlike
     * {@link updateCard} (im.v1.message.patch) which caps at ~20 edits per
     * message and silently disables the card's buttons afterwards.
     */
    createCardInstance: (card: object): Promise<string> => {
      const ch = channelHolder.current
      if (ch === undefined) return Promise.reject(new Error('dsh-feishu: channel not connected'))
      return ch.rawClient.cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(card) },
      }).then((r: any) => {
        const cardId = r.data?.card_id as string | undefined
        if (cardId === undefined) throw new Error('dsh-feishu: cardkit.card.create returned no card_id')
        return cardId
      })
    },
    /**
     * Send a message that references a card instance by `card_id` instead of
     * embedding the card JSON. Used together with {@link createCardInstance}
     * and {@link updateCardInstance} for the V2 card flow.
     *
     * When `replyTo` is set (a topic root message id), the message goes
     * through `im.v1.message.reply` with `reply_in_thread` — the only SDK
     * path that lands inside a Feishu topic. Without it, `message.create` is
     * used (main-chat fallback).
     */
    sendCardByReference: (to: string, cardId: string, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }> => {
      const ch = channelHolder.current
      if (ch === undefined) return Promise.reject(new Error('dsh-feishu: channel not connected'))
      const content = JSON.stringify({ type: 'card', data: { card_id: cardId } })
      if (opts?.replyTo !== undefined && opts.replyTo !== '') {
        return ch.rawClient.im.v1.message.reply({
          path: { message_id: opts.replyTo },
          data: {
            content,
            msg_type: 'interactive',
            reply_in_thread: opts.replyInThread === true,
          },
        }).then((r: any) => {
          const id = r.data?.message_id as string | undefined
          return id === undefined ? {} : { messageId: id }
        })
      }
      // Infer receive_id_type from the target id prefix (same logic as the
      // SDK's detectReceiveIdType): oc_→chat_id, ou_→open_id, on_→union_id.
      const receiveIdType = to.startsWith('oc_') ? 'chat_id'
        : to.startsWith('ou_') ? 'open_id'
        : to.startsWith('on_') ? 'union_id'
        : to.includes('@') ? 'email' : 'user_id'
      return ch.rawClient.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: to,
          msg_type: 'interactive',
          // The SDK's `im.v1.message.create` expects `content` to be a JSON
          // string. The content object follows the same format as the
          // SDK's rawSend: { type: 'card', data: { card_id: cardId } }.
          content,
        },
      }).then((r: any) => {
        const id = r.data?.message_id as string | undefined
        return id === undefined ? {} : { messageId: id }
      })
    },
    /**
     * Full-update a card instance (cardkit.v1.card.update). The message that
     * references this card_id automatically reflects the new content — no
     * im.v1.message.patch needed, so there is no 20-edit cap.
     *
     * `sequence` must be monotonically increasing per card instance.
     */
    updateCardInstance: (cardId: string, card: object, sequence: number): Promise<void> => {
      const ch = channelHolder.current
      if (ch === undefined) return Promise.reject(new Error('dsh-feishu: channel not connected'))
      return ch.rawClient.cardkit.v1.card.update({
        path: { card_id: cardId },
        data: {
          card: { type: 'card_json', data: JSON.stringify(card) },
          sequence,
        },
      }).then((r: any) => {
        if (r.code !== undefined && r.code !== 0) {
          throw new Error(`dsh-feishu: cardkit.card.update failed: code=${r.code} msg=${r.msg ?? 'unknown'}`)
        }
      })
    },
    updateCard: (messageId: string, card: object): Promise<void> => {
      const ch = channelHolder.current
      if (ch === undefined) return Promise.reject(new Error('dsh-feishu: channel not connected'))
      return ch.updateCard(messageId, card)
    },
    recallMessage: (messageId: string): Promise<void> => {
      const ch = channelHolder.current
      if (ch === undefined) return Promise.reject(new Error('dsh-feishu: channel not connected'))
      return ch.recallMessage(messageId)
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
        }, sessionController, agents, sandboxPolicy, llm, defaultModel, cardChannel,
        modelSelectHandle !== undefined ? { cardByMessage: modelSelectHandle.cardByMessage, sequenceByCard: modelSelectHandle.sequenceByCard } : undefined,
        onboardingHandle, workspaceRegistry, agentPresets),
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
        undefined,  // messageInterceptor (unused here)
        onboardingHandle === undefined ? undefined : {
          needsOnboarding: async (message) => {
            const bridge = bridgeHolder.current
            if (bridge === undefined) return false
            const coords: ConversationMessage = {
              chatId: message.chatId,
              chatType: message.chatType,
              ...message.threadId === undefined ? {} : { threadId: message.threadId },
            }
            return bridge.needsOnboarding(coords)
          },
          sendOnboardingCard: async (message) => {
            const threadLabel = message.threadId === undefined ? '这个对话框' : '这个话题'
            // Feishu topic replies must target the topic ROOT message; for the
            // root message itself rootId is absent and the message is its own
            // reply target (same rule as channel.ts's replyToId).
            const replyToId = message.rootId ?? message.messageId
            const coords: ConversationMessage = {
              chatId: message.chatId,
              chatType: message.chatType,
              ...message.threadId === undefined ? {} : { threadId: message.threadId },
              ...message.threadId === undefined ? {} : { rootId: replyToId },
            }
            await onboardingHandle?.sendOnboardingCard(coords, threadLabel)
          },
        },
      )
    },
  })
  // Pin the channel holder so the card adapter's `send`/`onCardAction` always
  // reach the live channel. The questions/approvals listeners wrap this
  // callback to also attach their cardAction handlers on reconnect.
  runtime.onChannelChange = channel => {
    channelHolder.current = channel
  }
  // `feishu_send_file` is independent of the questions/approvals seams: it only
  // needs the live channel + the session→chat reverse lookup, so it registers
  // unconditionally. Unbound sessions fail at execution time with a clear error.
  stopSendFileTool = startFeishuSendFileTool({
    ctx,
    bridgeHolder,
    channelHolder,
    logger: ctx.logger('dsh-feishu'),
  })
  if (sessionController !== undefined && userQuestions !== undefined && approval !== undefined) {
    stopQuestions = startFeishuQuestions({
      ctx,
      channel: cardChannel,
      bridgeHolder,
      logger: ctx.logger('dsh-feishu'),
    })
    stopTodos = startFeishuTodos({
      ctx,
      channel: cardChannel,
      bridgeHolder,
      logger: ctx.logger('dsh-feishu'),
    })
    const streamingResult = startFeishuStreaming({
      ctx,
      channel: cardChannel,
      bridgeHolder,
      logger: ctx.logger('dsh-feishu'),
      showReasoning: () => currentSettings().showReasoning,
    })
    stopStreaming = streamingResult.stop
    consumeReasoning = streamingResult.consumeReasoning
    consumeLastStepHadContent = streamingResult.consumeLastStepHadContent
    flushed = streamingResult.flushed
    modelSelectHandle = startFeishuModelSelect({
      llm,
      agentDefaultModel: defaultModel,
      bridgeHolder,
      sessionController,
      channel: cardChannel,
      logger: ctx.logger('dsh-feishu'),
      topicFor: chatId => onboardingHandle?.topicFor(chatId) ?? {},
      onNewSessionConfirm: async (chatMessage, selection, messageId) => {
        // The `/new` card flow's model step confirmed — create the session
        // with the workspace/preset captured by the onboarding flow and the
        // model chosen here.
        const bridge = bridgeHolder.current
        if (bridge === undefined) return
        const flowOptions = onboardingHandle?.creationOptionsFor(chatMessage.chatId) ?? {}
        await commitNewSession(bridge, cardChannel, chatMessage, {
          ...(flowOptions.workspace !== undefined ? { workspace: flowOptions.workspace } : {}),
          ...(flowOptions.agentPreset !== undefined ? { agentPreset: flowOptions.agentPreset } : {}),
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort as never } : {}),
        }, messageId, onboardingHandle?.topicFor(chatMessage.chatId))
      },
    })
    onboardingHandle = startFeishuOnboarding({
      bridgeHolder,
      channel: cardChannel,
      logger: ctx.logger('dsh-feishu'),
      workspaceRegistry,
      agentPresets,
      agentDefaultModel: defaultModel,
      config: {
        workspace: currentSettings().workspace,
        agentPreset: currentSettings().agentPreset,
        provider: currentSettings().provider,
        model: currentSettings().model,
      },
      onModelStep: async (chatMessage, messageId, flowState) => {
        // Advance the `/new` flow to the model card, reusing the
        // model-select provider card with the `new-session` flow marker.
        const bridge = bridgeHolder.current
        if (bridge === undefined || modelSelectHandle === undefined) return
        const current = defaultModel.currentSelection()
        const card = renderProviderSelectCard(llm.listProviders(), current, 'new-session')
        const cardId = await cardChannel.createCardInstance(card)
        const topic = onboardingHandle?.topicFor(chatMessage.chatId) ?? {}
        const opts = topic.threadId !== undefined && topic.rootId !== undefined
          ? { replyInThread: true, replyTo: topic.rootId }
          : {}
        const result = await cardChannel.sendCardByReference(chatMessage.chatId, cardId, opts)
        const sentId = result.messageId ?? ''
        if (sentId !== '') {
          modelSelectHandle.cardByMessage.set(sentId, cardId)
          modelSelectHandle.sequenceByCard.set(cardId, 0)
        }
      },
    })
  }
  registerLarkCommands(
    ctx,
    llm,
    defaultModel,
    {
      startNewSession: (chatMessage, salt) => bridgeHolder.current?.startNewSession(chatMessage, salt) ?? '',
      switchToSession: (chatMessage, sessionId) => bridgeHolder.current?.switchToSession(chatMessage, sessionId) ?? 'archived',
      detachSession: sessionId => bridgeHolder.current?.detachSession(sessionId) ?? { kind: 'free' as const },
      describeChatKey: key => bridgeHolder.current?.describeChatKey(key) ?? key,
      listSessions: async () => bridgeHolder.current?.listSessions() ?? [],
      getSessionMeta: async (chatMessage) => bridgeHolder.current?.getSessionMeta(chatMessage) ?? { sessionId: '', workspace: '', agentPreset: '', model: '', reasoningEffort: '', title: '', turns: 0, steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, contextWindow: 0, lastInputTokens: 0, cacheHitRate: 0, ttftAvgMs: 0, tokensPerSecond: 0, llmDurationMs: 0, toolDurationMs: 0 },
      resolveAgent: async (chatMessage) => bridgeHolder.current?.resolveAgent(chatMessage),
      resolveSessionIdFor: (chatMessage) => bridgeHolder.current?.resolveSessionIdFor(chatMessage) ?? '',
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
    buildApprovalControl(),
    {
      get: () => currentSettings().showReasoning,
      toggle: () => {
        const current = currentSettings().showReasoning
        void settings.mutate(namespace, [{ op: 'set', path: ['showReasoning'], value: !current }], currentRevision())
      },
    },
    sessionController,
  )
  ctx.effect(() => () => {
    stopQuestions()
    stopApprovals()
    stopTodos()
    stopStreaming()
    stopSendFileTool()
    modelSelectHandle?.dispose()
  }, 'dsh-feishu: feishu questions + approvals + todos + streaming + send-file + model-select listeners')

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
  newDescription: 'Create a new session in this chat (card flow, or /new <workspace> <preset> [model])',
  newUsage: 'Usage: /new <workspace> <agentPreset> [provider/model[:reasoning]] — or run `/new` with no arguments for the card flow.',
  newSessionReady: sessionId => `Started a new conversation. Next message uses session \`${sessionId}\`.`,
  threadDescription: 'List persisted sessions or switch the chat to one by index',
  threadUsage: 'Usage: /thread [N]',
  threadListHeader: 'Available sessions (reply with `/thread N` to switch):',
  threadListEmpty: 'No persisted sessions yet.',
  threadListEntry: (index, id, title, lastActive) => `${index}. ${title} — ${lastActive} (\`${id}\`)`,
  threadListEntryOwned: (index, id, title, lastActive, ownerLabel) => `${index}. ${title} — ${lastActive} — 🔒 ${ownerLabel} 正在使用 (\`${id}\`)`,
  threadSwitched: (index, id) => `Switched to session #${index} (\`${id}\`).`,
  threadInvalidIndex: 'Invalid session index.',
  threadArchived: 'That session is archived — unarchive it from the workspace webui first.',
  threadOccupied: ownerLabel => `That session is already in use by ${ownerLabel}. Pick a free session, or run \`/detach\` on it to force-release it.`,
  threadIdle: id => `(idle: ${id.slice(-12)})`,
  detachDescription: 'Force-release a session so any dialog can switch to it',
  detachUsage: 'Usage: /detach <N>',
  detachInvalidIndex: 'Invalid session index.',
  detachFree: 'That session is already free — no dialog owns it.',
  detachReleased: (index, id, ownerLabel) => `🔓 Released session #${index} (\`${id}\`). ${ownerLabel} was reset to a brand-new session and can no longer hold it.`,
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
}, agentRunning: boolean, sandboxMode?: string): object {
  const fields: string[] = []
  fields.push(`**Session:** \`${meta.sessionId}\``)
  if (meta.title !== '') fields.push(`**Title:** ${meta.title}`)
  fields.push(`**Workspace:** \`${meta.workspace || '(default)'}\``)
  fields.push(`**Preset:** \`${meta.agentPreset || '(default)'}\``)
  fields.push(`**Model:** \`${meta.model}\``)
  if (meta.reasoningEffort !== '') fields.push(`**Reasoning:** \`${meta.reasoningEffort}\``)
  if (sandboxMode !== undefined) {
    const label = sandboxMode === 'workspace-write' ? 'workspace-write ✍️'
      : sandboxMode === 'danger-full-access' ? 'danger-full-access 🔓'
        : sandboxMode === 'read-only' ? 'read-only 📖' : sandboxMode
    fields.push(`**Sandbox:** \`${sandboxMode}\` (${label})`)
  }
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
      const ownerLabel = entry.ownedBy === undefined ? undefined : bridge.describeChatKey(entry.ownedBy)
      lines.push(ownerLabel === undefined
        ? t.threadListEntry(index + 1, entry.id, title, lastActive)
        : t.threadListEntryOwned(index + 1, entry.id, title, lastActive, ownerLabel))
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
  const result = bridge.switchToSession(chatMessage, entry.id)
  if (result === 'archived') {
    return { kind: 'error', text: t.threadArchived }
  }
  if (result === 'occupied') {
    const ownerLabel = entry.ownedBy === undefined ? '另一个对话框' : bridge.describeChatKey(entry.ownedBy)
    return { kind: 'error', text: t.threadOccupied(ownerLabel) }
  }
  return { kind: 'success', text: t.threadSwitched(index, entry.id) }
}

/** Handle /detach directly: force-release a session so any dialog can switch to it. */
async function handleDetachDirect(
  rawInput: string,
  bridge: HarnessConversationService,
): Promise<{ kind: 'success' | 'error'; text: string }> {
  const t = larkCommandTranslations
  const index = Number.parseInt(rawInput.trim(), 10)
  if (!Number.isInteger(index) || index < 1) {
    return { kind: 'error', text: `${t.detachInvalidIndex}\n${t.detachUsage}` }
  }
  const sessions = await bridge.listSessions()
  const entry = sessions[index - 1]
  if (entry === undefined) {
    return { kind: 'error', text: `${t.detachInvalidIndex}\n${t.detachUsage}` }
  }
  const outcome = bridge.detachSession(entry.id)
  if (outcome.kind === 'free') {
    return { kind: 'success', text: t.detachFree }
  }
  return { kind: 'success', text: t.detachReleased(index, entry.id, outcome.ownerLabel) }
}

/** Parse `provider/model` or `provider/model:reasoning-effort` for the
 *  optional model argument of the `/new` text command. */
function parseNewModelRoute(rawInput: string): { provider: string; model: string; reasoningEffort?: string } | undefined {
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

/** Create a fresh session for a chat with explicit creation options, and
 *  render the confirmation card. Shared by the `/new` card flow (model step
 *  confirmed) and the `/new <workspace> <preset> [model]` text command. */
async function commitNewSession(
  bridge: HarnessConversationService,
  cardChannel: ModelSelectChannel,
  chatMessage: ConversationMessage,
  options: ChatCreationOptions,
  messageId?: string,
  topic?: { rootId?: string; threadId?: string },
): Promise<{ messageId?: string }> {
  const salt = `new-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const sessionId = bridge.startNewSession(chatMessage, salt, options)
  const parts: string[] = []
  if (options.workspace !== undefined) parts.push(`📁 \`${options.workspace}\``)
  if (options.agentPreset !== undefined) parts.push(`🧩 \`${options.agentPreset}\``)
  if (options.provider !== undefined && options.model !== undefined) {
    parts.push(`🤖 \`${options.provider}/${options.model}\``)
  }
  const summary = parts.length > 0 ? parts.join(' · ') : '使用默认设置'
  const card = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '✅ 会话已创建' }, template: 'green' },
    body: {
      elements: [
        { tag: 'markdown', content: `**Session** \`${sessionId}\`\n\n${summary}\n\n现在可以发送消息开始对话了。` },
      ],
    },
  }
  const opts = topic?.threadId !== undefined && topic.rootId !== undefined
    ? { replyInThread: true, replyTo: topic.rootId }
    : {}
  if (messageId === undefined) {
    const cardId = await cardChannel.createCardInstance(card)
    return cardChannel.sendCardByReference(chatMessage.chatId, cardId, opts)
  }
  await cardChannel.updateCard(messageId, card)
  return {}
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
  sessionController?: { selectModel?: (r: any) => Promise<any>; cancel?: (r: any) => Promise<any> },
  agents?: { get: (id: any) => { cancel: (cause: { kind: 'user' }, opts: { keepInbox?: boolean }) => void; session?: any } | undefined },
  sandboxPolicy?: { resolve?: (r: { session?: any }) => { mode: string; workspaceRoot?: string } },
  llm?: LlmRuntime,
  agentDefaultModel?: AgentDefaultModelConfig,
  cardChannel?: ModelSelectChannel,
  modelSelectMaps?: { cardByMessage: Map<string, string>; sequenceByCard: Map<string, number> },
  onboardingHandle?: FeishuOnboardingHandle,
  workspaceRegistry?: { list(): { path: string; name?: string }[] },
  agentPresets?: { list(): Promise<Array<{ id: string; title?: string }>> },
): Promise<
  | { kind: 'success' | 'error'; text: string; card?: object }
  | { kind: 'consumed' }
  | undefined
> {
  const parsed = parseCommand(message.content)
  if (parsed === undefined) return undefined
  const chatMessage = {
    chatId: message.chatId,
    chatType: message.chatType,
    ...message.threadId === undefined ? {} : { threadId: message.threadId },
    // Topic root id (fallback: the message itself is the root) so cards sent
    // from slash commands land inside the topic and `recordTopic` captures it.
    ...message.threadId === undefined ? {} : { rootId: message.rootId ?? message.messageId },
  }
  // Record topic context so later card actions (model selector, onboarding)
  // can recover the thread key even though card action events carry no
  // thread id.
  if (message.threadId !== undefined) {
    onboardingHandle?.noteTopic(chatMessage)
  }
  // /status, /new, /thread are handled directly — they don't need a live agent.
  if (parsed.name === 'status') {
    const meta = await bridge.getSessionMeta(chatMessage)
    const agentRunning = bridge.isAgentRunning(chatMessage)
    const sessionId = meta.sessionId
    const session = agents?.get(sessionId)?.session as any
    const sandboxMode = sandboxPolicy?.resolve?.({ session })?.mode
    return { kind: 'success', text: '', card: renderStatusCard(meta, agentRunning, sandboxMode) }
  }
  if (parsed.name === 'new') {
    const args = parsed.rawInput.trim().split(/\s+/).filter(s => s !== '')
    if (args.length === 0) {
      // Card flow: workspace → preset → model → create. Consumed so the
      // channel does not send a text follow-up.
      if (onboardingHandle === undefined) {
        return { kind: 'error', text: '⚠️ 新建会话卡片不可用。' }
      }
      await onboardingHandle.startNewFlow(chatMessage)
      return { kind: 'consumed' }
    }
    // Text form: /new <workspace> <agentPreset> [provider/model[:reasoning]]
    if (args.length < 2) {
      return { kind: 'error', text: larkCommandTranslations.newUsage }
    }
    const [workspaceArg, presetArg, modelArg] = args
    if (workspaceArg === undefined || presetArg === undefined) {
      return { kind: 'error', text: larkCommandTranslations.newUsage }
    }
    // Validate workspace exists
    if (workspaceRegistry === undefined) {
      return { kind: 'error', text: '⚠️ 工作区服务不可用。' }
    }
    const workspaces = workspaceRegistry.list()
    const workspace = workspaces.find(w => w.path === workspaceArg || w.name === workspaceArg)
    if (workspace === undefined) {
      const names = workspaces.map(w => w.name !== undefined && w.name !== '' ? w.name : w.path).join('`, `')
      return { kind: 'error', text: `⚠️ 未知工作区 \`${workspaceArg}\`。可用：\`${names}\`` }
    }
    // Validate preset exists
    if (agentPresets === undefined) {
      return { kind: 'error', text: '⚠️ Agent 模板服务不可用。' }
    }
    const presets = await agentPresets.list()
    if (!presets.some(p => p.id === presetArg)) {
      const ids = presets.map(p => p.id).join('`, `')
      return { kind: 'error', text: `⚠️ 未知 Agent 模板 \`${presetArg}\`。可用：\`${ids}\`` }
    }
    // Optional model route: provider/model[:reasoning]
    let modelOptions: ChatCreationOptions = {}
    if (modelArg !== undefined && modelArg !== '') {
      const route = parseNewModelRoute(modelArg)
      if (route === undefined) {
        return { kind: 'error', text: `⚠️ 无法解析模型参数 \`${modelArg}\`，格式：\`provider/model\` 或 \`provider/model:reasoning\`` }
      }
      modelOptions = {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort as never } : {}),
      }
    }
    const options: ChatCreationOptions = {
      workspace: workspace.path,
      agentPreset: presetArg,
      ...(modelOptions.provider !== undefined ? { provider: modelOptions.provider } : {}),
      ...(modelOptions.model !== undefined ? { model: modelOptions.model } : {}),
      ...(modelOptions.reasoningEffort !== undefined ? { reasoningEffort: modelOptions.reasoningEffort } : {}),
    }
    if (options.agentPreset === undefined) {
      return { kind: 'error', text: larkCommandTranslations.newUsage }
    }
    if (cardChannel === undefined) {
      return { kind: 'error', text: '⚠️ 卡片通道不可用。' }
    }
    await commitNewSession(bridge, cardChannel, chatMessage, options, undefined, {
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
      ...(message.threadId === undefined ? {} : { rootId: message.rootId ?? message.messageId }),
    })
    return { kind: 'consumed' }
  }
  if (parsed.name === 'thread') {
    return await handleThreadDirect(parsed.rawInput.trim(), bridge, chatMessage)
  }
  if (parsed.name === 'detach') {
    return await handleDetachDirect(parsed.rawInput.trim(), bridge)
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
  // /stop cancels the running agent — mirrors the WebUI stop button. It reaches
  // the live agent directly (rather than `sessionController.cancel`, which
  // hardcodes `keepInbox: true`) so it can also drop the pending inbox.
  if (parsed.name === 'stop') {
    if (sessionController === undefined) {
      return { kind: 'error', text: '⚠️ Cannot stop: sessionController is not available.' }
    }
    // Resolve the session id for this chat without creating an agent.
    const sessionId = bridge.resolveSessionIdFor(chatMessage)
    const agent = agents?.get(sessionId)
    if (agent === undefined) {
      return { kind: 'error', text: '⚠️ 该 session 当前没有运行中的 agent，无需停止。' }
    }
    // Cancel with `keepInbox: false` so the pending inbox (a Feishu message
    // queued while the previous turn was still running) is DROPPED as well —
    // matching the WebUI stop button, which terminates all runs instead of
    // letting a queued message immediately spawn a new loop. The session
    // controller's own `cancel` hardcodes `keepInbox: true`, which is exactly
    // the "abort turn but restart from the queue" behaviour we are replacing.
    agent.cancel({ kind: 'user' }, { keepInbox: false })
    return { kind: 'success', text: '⏹️ Agent 已停止，排队中的消息已丢弃。当前 turn 的工具执行将尽快终止。' }
  }
  // /steer <text> injects a message into the RUNNING agent turn (DSH next-step
  // inbox) instead of queueing it as a new turn — the Feishu equivalent of the
  // WebUI's steer gesture while busy. Returns consumed so the steered content
  // renders through the per-step cards and no duplicate reply card is sent.
  if (parsed.name === 'steer') {
    const text = parsed.rawInput.trim()
    if (text === '') {
      return { kind: 'error', text: '⚠️ 用法：/steer <内容> —— 在 agent 运行中把一条消息注入当前 turn。' }
    }
    try {
      await bridge.steer({ ...chatMessage, content: text })
      return { kind: 'consumed' }
    } catch (error: unknown) {
      return { kind: 'error', text: `⚠️ /steer 失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  // /sandbox [mode] shows the current file-sandbox mode or switches it. The
  // switch mirrors DSH's `dsh-sandbox-policy` per-session override: one
  // log-only `sandbox/mode` event (the `setSandboxMode` write path) that takes
  // effect on the session's next confined call. Reading uses the policy
  // service's resolve (explicit grant > session override > deployment default).
  if (parsed.name === 'sandbox') {
    if (sandboxPolicy?.resolve === undefined) {
      return { kind: 'error', text: '⚠️ dsh-sandbox-policy 服务不可用，无法管理沙箱模式。' }
    }
    const sessionId = bridge.resolveSessionIdFor(chatMessage)
    const session = agents?.get(sessionId)?.session as any
    if (session === undefined) {
      return { kind: 'error', text: '⚠️ 当前 chat 还没有会话，请先发一条消息再执行 /sandbox。' }
    }
    const raw = parsed.rawInput.trim()
    const current = sandboxPolicy.resolve({ session }).mode
    if (raw === '') {
      const lines = [
        '**当前沙箱模式：**',
        `- \`${current}\`${current === 'workspace-write' ? ' ✍️' : current === 'danger-full-access' ? ' 🔓' : current === 'read-only' ? ' 📖' : ''}`,
        '',
        '**切换方法：** `/sandbox <模式>`',
        '',
        '**可选模式：**',
        ...SANDBOX_MODES.map(m => `- \`${m}\`${m === current ? ' （当前）' : ''}`),
        '',
        '_切换写入会话日志，下一次受限调用（bash / 文件系统）即生效。_',
      ]
      return { kind: 'success', text: lines.join('\n') }
    }
    if (!(SANDBOX_MODES as readonly string[]).includes(raw)) {
      return { kind: 'error', text: `⚠️ 未知沙箱模式 \`${raw}\`。可选：${SANDBOX_MODES.join(' | ')}` }
    }
    // setSandboxMode(session, raw) — appends the log-only switch event.
    session.append('sandbox/mode', { mode: raw })
    return { kind: 'success', text: `✅ 沙箱模式已切换为 \`${raw}\`。将从下一次受限调用起生效。` }
  }
  // /model with no arguments renders the model selector card (V2 card
  // instance) instead of falling through to commands.execute. The card's
  // dropdowns drive the feishu-model-select flow; `/model provider/model`
  // and `/model list` still go through commands.execute as before.
  if (parsed.name === 'model' && parsed.rawInput.trim() === '') {
    if (agentDefaultModel === undefined) {
      return { kind: 'error', text: '⚠️ Agent default model service is not available.' }
    }
    if (llm === undefined) {
      return { kind: 'error', text: '⚠️ LLM service is not available.' }
    }
    if (cardChannel === undefined || modelSelectMaps === undefined) {
      // Fallback: return the card in the old format (embedded JSON).
      const current = agentDefaultModel.currentSelection()
      const providers = llm.listProviders()
      return { kind: 'success', text: '', card: renderProviderSelectCard(providers, {
        provider: current.provider,
        model: current.model,
        ...(current.reasoningEffort !== undefined ? { reasoningEffort: String(current.reasoningEffort) } : {}),
      }) }
    }
    // V2 flow: create card instance + send by card_id reference.
    const current = agentDefaultModel.currentSelection()
    const providers = llm.listProviders()
    const card = renderProviderSelectCard(providers, {
      provider: current.provider,
      model: current.model,
      ...(current.reasoningEffort !== undefined ? { reasoningEffort: String(current.reasoningEffort) } : {}),
    })
    try {
      await sendModelCardV2(cardChannel, chatMessage, card, modelSelectMaps.cardByMessage, modelSelectMaps.sequenceByCard)
      // V2 card was sent directly via cardkit. Signal "consumed" so channel.ts
      // sends no follow-up message AND does not fall through into the agent
      // loop (returning `undefined` would treat `/model` as a regular message).
      return { kind: 'consumed' }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      // Fallback: send as embedded card (old format).
      return { kind: 'success', text: '', card }
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
