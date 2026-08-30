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
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { createLarkChannel } from '@larksuiteoapi/node-sdk'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { ConfigSchema, LARK_SETTINGS_NAMESPACE, resolveSettingsConfig } from './config.ts'
import type { Config as PluginConfig, SettingsConfig } from './config.ts'
import { HarnessConversationService, TurnDroppedError, type BusyMode } from './harness.ts'
import type { ConversationMessage } from './conversation.ts'
import { startChannel, type SlashCommandHandler } from './channel.ts'
import { LarkRuntime } from './runtime.ts'
import { createSettingsApi } from './settings-api.ts'
import { renderTerminalQr } from './provision.ts'
import { ProvisionManager } from './provision-manager.ts'
import { registerLarkCommands, formatRelativeTime, handleHelpCommand, handleModelCommand, handleReasoningCommand, handleApprovalCommand, handleListApprovalsCommand, renderFeishuCommandsOnly, type ApprovalControl, type CommandTranslations } from './commands.ts'
import { commandTranslationsFor } from './commands-i18n.ts'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { handleProvisionRequest, handleSettingsRequest, PROVISION_PATH, SETTINGS_PATH } from './web.ts'
import { startFeishuApprovals, type PendingApprovalView } from './feishu-approvals.ts'
import { startFeishuTodos } from './feishu-todos.ts'
import { startFeishuStreaming } from './feishu-streaming.ts'
import type { TurnStats } from './feishu-streaming.ts'
import { resolveLocale, translationsFor, type LocaleId, type Translations } from './i18n.ts'

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
import { startFeishuPermission, SANDBOX_MODES, PERMISSION_LABELS, type FeishuPermissionHandle } from './feishu-permission.ts'
import { startFeishuBusy, type FeishuBusyHandle } from './feishu-busy.ts'
import { startFeishuSession, renderSessionListCard, renderSessionResultCard, type FeishuSessionHandle } from './feishu-session.ts'
import { startFeishuOnboarding, type FeishuOnboardingHandle } from './feishu-onboarding.ts'
import type { ChatCreationOptions } from './harness.ts'

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
    LARK_SETTINGS_NAMESPACE as SettingsNamespace,
    ConfigSchema,
    { base: rawConfig, applies: 'live' },
  )
  const namespace = LARK_SETTINGS_NAMESPACE as SettingsNamespace
  const currentSettings = (): SettingsConfig => resolveSettingsConfig(settingsScope.get())
  const currentRevision = () => settings.describe({ redactSecrets: true }).find(item => item.ns === namespace)?.revision ?? 0
  let apiUpdateDepth = 0

  // Active plugin language. The plugin `locale` field wins; `auto` (default)
  // follows the DSH browser-language preference (the host `locale` namespace
  // registered by `@deepseek-ai/dsh-client-locale`). When DSH does not expose
  // a preference, fall back to `zh`.
  const currentLocale = (): { id: LocaleId; plugin: 'zh' | 'en' | 'auto'; dsh: string | undefined } => {
    const plugin = currentSettings().locale ?? 'auto'
    let dsh: string | undefined
    try {
      const localeNs = settings.get('locale' as Parameters<typeof settings.get>[0]) as { preference?: string } | undefined
      dsh = localeNs?.preference
    } catch {
      dsh = undefined
    }
    return { id: resolveLocale(plugin, dsh), plugin, dsh }
  }
  // Keep the module-level command translations in sync with the resolved
  // locale. Called at apply time and whenever `/lang` changes the plugin's
  // `locale` field.
  const refreshLocale = (): void => setActiveCommandTranslations(currentLocale().id)
  refreshLocale()

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
  let permissionHandle: FeishuPermissionHandle | undefined = undefined
  let busyHandle: FeishuBusyHandle | undefined = undefined
  let sessionHandle: FeishuSessionHandle | undefined = undefined
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
        }, sessionController, agents, sandboxPolicy, permissionHandle, llm, defaultModel, cardChannel,
        busyHandle,
        modelSelectHandle !== undefined ? { cardByMessage: modelSelectHandle.cardByMessage, sequenceByCard: modelSelectHandle.sequenceByCard } : undefined,
        onboardingHandle, workspaceRegistry, agentPresets, approvalControl, showReasoningControl, sessionHandle,
        { current: currentLocale, set: setPluginLocale }),
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
            busyMode: bridgeHolder.current?.busyMode(coords as ConversationMessage) ?? 'queue',
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
      () => translationsFor(currentLocale().id),
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
  // Interactive `/permission` picker card. Independent of the questions/
  // approvals seams; only needs the live card channel + the sandbox policy.
  permissionHandle = startFeishuPermission({
    channel: cardChannel,
    sandbox: sandboxPolicy,
    sessionGetter: (id: string) => (agents as any)?.get?.(id)?.session,
    logger: ctx.logger('dsh-feishu'),
    getTranslations: () => translationsFor(currentLocale().id),
  })
  // Interactive `/busy` picker card. Independent of the questions/approvals
  // seams; only needs the live card channel + the bridge's per-chat busy mode.
  busyHandle = startFeishuBusy({
    channel: cardChannel,
    getMode: chat => bridgeHolder.current?.busyMode(chat) ?? 'queue',
    setMode: (chat, mode) => bridgeHolder.current?.setBusyMode(chat, mode),
    logger: ctx.logger('dsh-feishu'),
    getTranslations: () => translationsFor(currentLocale().id),
  })
  // Interactive `/session` management panel (switch / detach / rename /
  // archive / fork). Independent of the questions/approvals seams; only needs
  // the live card channel + the bridge + optional DSH session/workspace APIs.
  sessionHandle = startFeishuSession({
    channel: cardChannel,
    bridge: () => bridgeHolder.current,
    sessionController,
    workspaceRegistry,
    logger: ctx.logger('dsh-feishu'),
    getTranslations: () => translationsFor(currentLocale().id),
  })
  if (sessionController !== undefined && userQuestions !== undefined && approval !== undefined) {
    stopQuestions = startFeishuQuestions({
      ctx,
      channel: cardChannel,
      bridgeHolder,
      logger: ctx.logger('dsh-feishu'),
      getTranslations: () => translationsFor(currentLocale().id),
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
      getTranslations: () => translationsFor(currentLocale().id),
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
      getTranslations: () => translationsFor(currentLocale().id),
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
      getTranslations: () => translationsFor(currentLocale().id),
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
        const card = renderProviderSelectCard(llm.listProviders(), current, 'new-session', translationsFor(currentLocale().id))
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
  // Approval control (the Feishu waterfall listener) and the reasoning-display
  // toggle are shared by the command runtime and the same-session standalone
  // dispatches in executeSlashCommand (which must not require a live agent).
  const approvalControl = buildApprovalControl()
  const showReasoningControl = {
    get: () => currentSettings().showReasoning,
    toggle: () => {
      const current = currentSettings().showReasoning
      void settings.mutate(namespace, [{ op: 'set', path: ['showReasoning'], value: !current }], currentRevision())
    },
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
    activeCommandTranslations,
    commands,
    approvalControl,
    showReasoningControl,
    sessionController,
  )
  ctx.effect(() => () => {
    stopQuestions()
    stopApprovals()
    stopTodos()
    stopStreaming()
    stopSendFileTool()
    modelSelectHandle?.dispose()
    permissionHandle?.stop()
    busyHandle?.stop()
    sessionHandle?.stop()
  }, 'dsh-feishu: feishu questions + approvals + todos + streaming + send-file + model-select + permission + busy + session listeners')

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

  // Persist the plugin's `locale` field (used by `/lang`). Passing `'auto'`
  // unsets the field so the plugin again follows the DSH preference.
  const setPluginLocale = (value: 'zh' | 'en' | 'auto'): Promise<void> => {
    const expected = currentRevision()
    const ops = value === 'auto'
      ? [{ op: 'unset' as const, path: ['locale'] }]
      : [{ op: 'set' as const, path: ['locale'], value }]
    return settings.mutate(namespace, ops, expected).then(() => refreshLocale())
  }

  settingsScope.watch(() => apiUpdateDepth > 0 ? undefined : runtime.reconcile())
  // Credentials-change event was renamed `credentials/updated` →
  // `credentials/reference-updated` in a newer Harness. Register under BOTH
  // names via a loose cast so `tsc` typechecks against either version; the
  // name a given Harness never emits simply never fires (a no-op there). The
  // ref are credential-reference names, so `=== appSecretRef` matches.
  const onCredentialRefUpdated = (ref: string): void => {
    if (apiUpdateDepth === 0 && ref === currentSettings().appSecretRef) void runtime.reconcile()
  }
  const looseOn = (name: string, handler: (ref: string) => void): void => {
    ;(ctx as unknown as { on(name: string, handler: (ref: string) => void): unknown }).on(name, handler)
  }
  looseOn('credentials/updated', onCredentialRefUpdated)
  looseOn('credentials/reference-updated', onCredentialRefUpdated)
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

// Active command-layer translations. Kept in sync with the resolved locale by
// the apply closure (see `setActiveCommandTranslations`); module-level command
// handlers read this single cell so they render in the user's language without
// threading a `t` through every call site.
let activeCommandTranslations: CommandTranslations = commandTranslationsFor('zh')
function setActiveCommandTranslations(locale: 'zh' | 'en'): void {
  activeCommandTranslations = commandTranslationsFor(locale)
}

/** Render the /status result as a Feishu interactive card. */
function renderStatusCard(meta: {
  sessionId: string; workspace: string; agentPreset: string; model: string; reasoningEffort: string; title: string
  turns: number; steps: number; toolCalls: number; inputTokens: number; outputTokens: number
  contextWindow: number; lastInputTokens: number
}, agentRunning: boolean, sandboxMode?: string, busyMode?: string, t: Translations = translationsFor('zh')): object {
  const fields: string[] = []
  fields.push(`**${t.statusSessionLabel}:** \`${meta.sessionId}\``)
  if (meta.title !== '') fields.push(`**${t.statusTitleLabel}:** ${meta.title}`)
  fields.push(`**${t.statusWorkspaceLabel}:** \`${meta.workspace || '(default)'}\``)
  fields.push(`**${t.statusPresetLabel}:** \`${meta.agentPreset || '(default)'}\``)
  fields.push(`**${t.statusModelLabel}:** \`${meta.model}\``)
  if (meta.reasoningEffort !== '') fields.push(`**${t.statusReasoningLabel}:** \`${meta.reasoningEffort}\``)
  if (sandboxMode !== undefined) {
    const label = PERMISSION_LABELS[sandboxMode] ?? sandboxMode
    const icon = sandboxMode === 'workspace-write' ? ' ✍️' : sandboxMode === 'danger-full-access' ? ' 🔓' : sandboxMode === 'read-only' ? ' 📖' : ''
    fields.push(`**${t.statusPermissionLabel}:** \`${sandboxMode}\` ${label}${icon}`)
  }
  if (busyMode !== undefined) {
    // WebUI names this "Enter behavior while busy"; options Queue / Steer.
    const label = busyMode === 'steer' ? 'Steer' : 'Queue'
    const icon = busyMode === 'steer' ? '🎯' : '📥'
    fields.push(`**${t.statusBusyLabel}:** ${icon} ${label}`)
  }
  fields.push(`**${t.statusAgentLabel}:** ${agentRunning ? t.statusAgentRunning : t.statusAgentIdle}`)
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
    fields.push(t.statusRunWarning)
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

/** Handle /detach directly: force-release a session so any dialog can switch to it. */
async function handleDetachDirect(
  rawInput: string,
  bridge: HarnessConversationService,
): Promise<{ kind: 'success' | 'error'; text: string }> {
  const t = activeCommandTranslations
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
  permissionCard?: { open: (chat: ConversationMessage, sessionId: string) => Promise<string | undefined> },
  llm?: LlmRuntime,
  agentDefaultModel?: AgentDefaultModelConfig,
  cardChannel?: ModelSelectChannel,
  busyCard?: { open: (chat: ConversationMessage) => Promise<string | undefined> },
  modelSelectMaps?: { cardByMessage: Map<string, string>; sequenceByCard: Map<string, number> },
  onboardingHandle?: FeishuOnboardingHandle,
  workspaceRegistry?: { list(): { path: string; name?: string }[] },
  agentPresets?: { list(): Promise<Array<{ id: string; title?: string }>> },
  approvals?: ApprovalControl,
  showReasoning?: { get: () => boolean; toggle: () => void },
  sessionCard?: FeishuSessionHandle,
  localeControl?: {
    current: () => { id: LocaleId; plugin: 'zh' | 'en' | 'auto'; dsh: string | undefined }
    set: (value: 'zh' | 'en' | 'auto') => Promise<void>
  },
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
  // /status, /new, /session are handled directly — they don't need a live agent.
  if (parsed.name === 'status') {
    const meta = await bridge.getSessionMeta(chatMessage)
    const agentRunning = bridge.isAgentRunning(chatMessage)
    const sessionId = meta.sessionId
    const session = agents?.get(sessionId)?.session as any
    const sandboxMode = sandboxPolicy?.resolve?.({ session })?.mode
    const busyMode = bridge.busyMode(chatMessage)
    return { kind: 'success', text: '', card: renderStatusCard(meta, agentRunning, sandboxMode, busyMode, translationsFor(localeControl?.current().id ?? 'zh')) }
  }
  if (parsed.name === 'lang') {
    const arg = parsed.rawInput.trim().toLowerCase()
    const current = localeControl?.current() ?? { id: 'zh' as LocaleId, plugin: 'auto' as const, dsh: undefined }
    const LANG_STRS: Record<string, string> = { zh: '中文', en: 'English', auto: 'auto' }
    const describe = (): string => {
      const label = LANG_STRS[current.id] ?? current.id
      const source = current.plugin === 'auto'
        ? (current.dsh === undefined
            ? '跟随 DSH 优先 / 默认中文'
            : `跟随 DSH（\`${current.dsh}\`）`)
        : `由插件锁定（\`${current.plugin}\`）`
      return `当前语言：**${label}**（${source}）`
    }
    if (arg === '' || arg === 'show') {
      return { kind: 'success', text: describe() }
    }
    if (arg === 'zh' || arg === 'en') {
      await localeControl?.set(arg)
      const after = localeControl?.current()
      return { kind: 'success', text: after === undefined ? '已切换。' : `已切换为 **${LANG_STRS[after.id]}**。${describe()}` }
    }
    if (arg === 'auto') {
      await localeControl?.set('auto')
      return { kind: 'success', text: `已切换为跟随 DSH 语言。${describe()}` }
    }
    return { kind: 'error', text: `用法：\`/lang [zh|en|auto]\`\n- \`zh\` 中文 · \`en\` English · \`auto\` 跟随 DSH\n当前：**${LANG_STRS[current.id] ?? current.id}**` }
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
      return { kind: 'error', text: activeCommandTranslations.newUsage }
    }
    const [workspaceArg, presetArg, modelArg] = args
    if (workspaceArg === undefined || presetArg === undefined) {
      return { kind: 'error', text: activeCommandTranslations.newUsage }
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
      return { kind: 'error', text: activeCommandTranslations.newUsage }
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
  if (parsed.name === 'session') {
    const input = parsed.rawInput.trim()
    if (input === '') {
      // Interactive management panel (switch / detach / rename / archive / fork).
      if (sessionCard === undefined) {
        return { kind: 'error', text: '⚠️ 会话管理卡片不可用。' }
      }
      await sessionCard.open(chatMessage)
      return { kind: 'consumed' }
    }
    if (input === 'list') {
      const sessions = await bridge.listSessions()
      return { kind: 'success', text: '', card: renderSessionListCard(sessions, translationsFor(localeControl?.current().id ?? 'zh')) }
    }
    const index = Number.parseInt(input, 10)
    if (!Number.isInteger(index) || index < 1) {
      return { kind: 'error', text: `${activeCommandTranslations.threadInvalidIndex}\n${activeCommandTranslations.threadUsage}` }
    }
    const sessions = await bridge.listSessions()
    const entry = sessions[index - 1]
    if (entry === undefined) {
      return { kind: 'error', text: `${activeCommandTranslations.threadInvalidIndex}\n${activeCommandTranslations.threadUsage}` }
    }
    // Quick switch with the same detach+attach semantics as the panel.
    const outcome = bridge.attachSession(chatMessage, entry.id)
    if (outcome === 'archived') {
      return { kind: 'error', text: activeCommandTranslations.threadArchived }
    }
    return { kind: 'success', text: activeCommandTranslations.threadSwitched(index, entry.id) }
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
  // /stop cancels the running agent — mirrors the WebUI stop button. The
  // bridge both bumps the per-chat stop generation (so a message queued behind
  // the running turn is DROPPED instead of auto-restarting) and cancels the
  // live agent with `keepInbox:false` (aborting the turn and clearing the inbox).
  if (parsed.name === 'stop') {
    if (!bridge.stopSession(chatMessage)) {
      return { kind: 'error', text: '⚠️ 该 session 当前没有运行中的 agent，无需停止。' }
    }
    return { kind: 'success', text: '⏹️ Agent 已停止，排队中的消息已丢弃。当前 turn 的工具执行将尽快终止。' }
  }
  // /busy [queue|steer] sets the per-chat behavior for messages sent while the
  // agent is running: queue (wait for the turn, then run as a new turn) or
  // steer (inject into the running turn). Persisted across restarts. With no
  // argument it opens the interactive picker card (buttons switch the mode);
  // `/busy <mode>` still switches directly by text. The one-off `/steer <text>`
  // remains for a temporary injection.
  if (parsed.name === 'busy') {
    const raw = parsed.rawInput.trim()
    if (raw === '') {
      // Interactive picker card: clicking a button switches the mode and the
      // card re-marks the active one. Fall back to a text listing when the
      // picker handle is unavailable.
      if (busyCard !== undefined) {
        try {
          await busyCard.open(chatMessage)
          return { kind: 'consumed' }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: `⚠️ /busy 卡片失败：${msg}` }
        }
      }
      const current = bridge.busyMode(chatMessage)
      const icon = current === 'steer' ? ' 🎯' : ' 📥'
      const label = current === 'steer' ? 'Steer' : 'Queue'
      return { kind: 'success', text: [
        `**运行中（busy）的 Enter 行为：** \`${current}\` ${label}${icon}`,
        '',
        '仅运行中生效：',
        '- `queue`：排队发送，当前轮结束后作为新轮运行（默认）',
        '- `steer`：插话发送，把消息注入当前运行轮立即响应',
        '',
        '**切换：** `/busy queue` 或 `/busy steer`（持久化）',
        '_一次性插话用 `/steer <内容>`_',
      ].join('\n') }
    }
    if (raw !== 'queue' && raw !== 'steer') {
      return { kind: 'error', text: '⚠️ 未知 busy 模式。可选：queue | steer' }
    }
    bridge.setBusyMode(chatMessage, raw)
    const desc = raw === 'steer' ? '插话发送（注入当前轮）' : '排队发送（当前轮结束后开新轮）'
    return { kind: 'success', text: `✅ 已把本聊天运行中（busy）的 Enter 行为切为 \`${raw}\`（${desc}）。已持久化。` }
  }
  // /queue <text> is the conjugate of /steer: it forces a message onto the
  // QUEUE path even when the chat is in steer mode, so it runs as a new turn
  // after the current one instead of being injected into the running turn.
  // When the chat is ALREADY in queue mode this is redundant (a plain message
  // queues anyway), so short-circuit with a hint instead of submitting.
  if (parsed.name === 'queue') {
    const text = parsed.rawInput.trim()
    if (text === '') {
      return { kind: 'error', text: '⚠️ 用法：/queue <内容> —— 在 steer 模式下也强制把一条消息排队为新轮（/steer 的共轭）。' }
    }
    // Idle fallback: nothing is running, so "queue behind a live turn" is moot —
    // just send the content as a new message (the Feishu default) instead of
    // erroring, and say so explicitly.
    if (!bridge.isAgentRunning(chatMessage)) {
      void bridge.reply({ ...chatMessage, content: text }).catch((error: unknown) => {
        if (error instanceof TurnDroppedError) return
        console.error('dsh-feishu: /queue idle-fallback reply failed:', error instanceof Error ? error.message : String(error))
      })
      return {
        kind: 'success',
        text: `💬 Agent 当前空闲，已把内容作为新消息发送：\`${text}\``,
      }
    }
    if (bridge.busyMode(chatMessage) === 'queue') {
      return { kind: 'error', text: '⚠️ 本聊天已在 queue 模式：直接发送消息即会排队为新轮，无需 /queue。\n\n若想注入当前运行轮，用 `/steer <内容>` 或改用 `/busy steer`。' }
    }
    // Submit in the background so the command can acknowledge immediately; the
    // queue path waits for the current turn then runs it as a new turn. A
    // `TurnDroppedError` (user ran /stop while queued) is a silent drop, not a
    // failure — the acknowledgment already told them they can /stop.
    void bridge.reply({ ...chatMessage, content: text }, { forceQueue: true }).catch((error: unknown) => {
      if (error instanceof TurnDroppedError) return
      console.error('dsh-feishu: /queue background reply failed:', error instanceof Error ? error.message : String(error))
    })
    return {
      kind: 'success',
      text: `📥 已把消息排队为该聊天下一轮运行：\`${text}\`\n\n当前 turn 结束后会自动生成本次回答。排队期间可用 \`/stop\` 丢弃。`,
    }
  }
  // /steer <text> injects a message into the RUNNING agent turn (DSH next-step
  // inbox) instead of queueing it as a new turn — the Feishu equivalent of the
  // WebUI's steer gesture while busy. When the chat is ALREADY in steer mode
  // this is redundant (a plain message injects anyway), so short-circuit with a
  // hint instead of submitting. The bridge does not wait for idle, so we
  // acknowledge immediately with a confirmation text (the steered content
  // itself still renders through the per-step streaming cards as the turn
  // continues) — otherwise the injection would be silent with no feedback.
  if (parsed.name === 'steer') {
    const text = parsed.rawInput.trim()
    if (text === '') {
      return { kind: 'error', text: '⚠️ 用法：/steer <内容> —— 在 agent 运行中把一条消息注入当前 turn。' }
    }
    // Idle fallback: nothing is running (no agent or agent not in a turn), so an
    // injection cannot apply. Instead of erroring, send the content as a new
    // message (the Feishu default) and say so explicitly. The reply() call never
    // steers when not running, so this is always a fresh turn.
    if (!bridge.isAgentRunning(chatMessage)) {
      void bridge.reply({ ...chatMessage, content: text }).catch((error: unknown) => {
        if (error instanceof TurnDroppedError) return
        console.error('dsh-feishu: /steer idle-fallback reply failed:', error instanceof Error ? error.message : String(error))
      })
      return {
        kind: 'success',
        text: `💬 Agent 当前空闲，已把内容作为新消息发送：\`${text}\`\n\n若要在 agent 运行中插话，请等本轮结束后用它再发一条普通消息即可（或改用 \`/busy steer\` 常开插话）。`,
      }
    }
    if (bridge.busyMode(chatMessage) === 'steer') {
      return { kind: 'error', text: '⚠️ 本聊天已在 steer 模式：直接发送消息即会注入当前运行轮，无需 /steer。\n\n若想排队为新轮，用 `/queue <内容>` 或改用 `/busy queue`。' }
    }
    try {
      await bridge.steer({ ...chatMessage, content: text })
      return {
        kind: 'success',
        text: `🎯 已注入运行中的 turn：\`${text}\`\n\nAgent 会把它作为下一步指令继续执行。若想中止，发送 \`/stop\`。`,
      }
    } catch (error: unknown) {
      return { kind: 'error', text: `⚠️ /steer 失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  // /permission [preset] shows / switches the session file-permission mode.
  // Naming and labels match the DSH WebUI's `ui-permission-presets` plugin
  // (the `/permission` command; presets read-only / workspace-write /
  // danger-full-access shown as Read Only / Workspace Write / Full access).
  // The switch mirrors `dsh-sandbox-policy`'s per-session override: one
  // log-only `sandbox/mode` event (the `setSandboxMode` write path) that takes
  // effect on the session's next confined call. Reading uses the policy
  // service's resolve (explicit grant > session override > deployment default).
  // `/sandbox` is kept as a hidden alias for anyone already using the old name.
  if (parsed.name === 'permission' || parsed.name === 'sandbox') {
    if (sandboxPolicy?.resolve === undefined) {
      return { kind: 'error', text: '⚠️ dsh-sandbox-policy 服务不可用，无法管理权限模式。' }
    }
    const sessionId = bridge.resolveSessionIdFor(chatMessage)
    const session = agents?.get(sessionId)?.session as any
    if (session === undefined) {
      return { kind: 'error', text: '⚠️ 当前 chat 还没有会话，请先发一条消息再执行 /permission。' }
    }
    const raw = parsed.rawInput.trim()
    const current = sandboxPolicy.resolve({ session }).mode
    const currentLabel = PERMISSION_LABELS[current] ?? current
    if (raw === '') {
      // Interactive picker card: clicking a button switches the mode and the
      // card re-marks the active preset. Fall back to a text listing when the
      // picker handle is unavailable.
      if (permissionCard !== undefined) {
        try {
          await permissionCard.open(chatMessage, sessionId)
          return { kind: 'consumed' }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: `⚠️ /permission 卡片失败：${msg}` }
        }
      }
      const lines = [
        '**当前权限模式：**',
        `- \`${current}\` ${currentLabel}${current === 'danger-full-access' ? ' 🔓' : current === 'workspace-write' ? ' ✍️' : ' 📖'}`,
        '',
        '**切换方法：** `/permission <模式>`',
        '',
        '**可选模式：**',
        ...SANDBOX_MODES.map(m => `- \`${m}\` ${PERMISSION_LABELS[m] ?? m}${m === current ? ' （当前）' : ''}`),
        '',
        '_切换写入会话日志，下一次受限调用（bash / 文件系统）即生效。_',
      ]
      return { kind: 'success', text: lines.join('\n') }
    }
    if (!(SANDBOX_MODES as readonly string[]).includes(raw)) {
      return { kind: 'error', text: `⚠️ 未知权限模式 \`${raw}\`。可选：${SANDBOX_MODES.join(' | ')}（对应 Read Only / Workspace Write / Full access）` }
    }
    // setSandboxMode(session, raw) — appends the log-only switch event.
    session.append('sandbox/mode', { mode: raw })
    return { kind: 'success', text: `✅ 权限模式已切换为 \`${raw}\`（${PERMISSION_LABELS[raw] ?? raw}）。将从下一次受限调用起生效。` }
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
      }, undefined, translationsFor(localeControl?.current().id ?? 'zh')) }
    }
    // V2 flow: create card instance + send by card_id reference.
    const current = agentDefaultModel.currentSelection()
    const providers = llm.listProviders()
    const card = renderProviderSelectCard(providers, {
      provider: current.provider,
      model: current.model,
      ...(current.reasoningEffort !== undefined ? { reasoningEffort: String(current.reasoningEffort) } : {}),
    }, undefined, translationsFor(localeControl?.current().id ?? 'zh'))
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
  // ── Conversation-free slash commands ────────────────────────────────
  // These only need deployment config and/or a derived session id — not a live
  // agent — so they work right after a restart (before any new message) and on
  // a brand-new chat. Commands that genuinely need an existing/running session
  // (`steer`, `permission`, and DSH-native `compact`/`goal`/…) are NOT listed
  // here: they fall through to the resolveAgent gate below.
  bridgeHolder.lastChatMessage = chatMessage
  const freeSessionId = bridge.resolveSessionIdFor(chatMessage)
  const freeInvocation = (rawInput: string, agentOverride?: unknown) =>
    ({ name: parsed.name, rawInput, agent: agentOverride ?? { session: { id: freeSessionId } } }) as unknown as CommandInvocation
  const freeChatMessageFor = () => chatMessage as ConversationMessage
  // CommandResult has an optional `text`; normalize to the handler's echo shape.
  const toEcho = (r: CommandResult) =>
    ({ kind: r.kind, text: r.text ?? `Command /${parsed.name} produced no output.` } as const) as unknown as { kind: 'success' | 'error'; text: string; card?: object }
  if (parsed.name === 'model' && parsed.rawInput.trim() !== '' && llm !== undefined && agentDefaultModel !== undefined) {
    return toEcho(await handleModelCommand(freeInvocation(parsed.rawInput), llm, agentDefaultModel, bridge, freeChatMessageFor, activeCommandTranslations, (sessionController ?? {}) as never))
  }
  if (parsed.name === 'reasoning' && agentDefaultModel !== undefined) {
    return toEcho(await handleReasoningCommand(freeInvocation(parsed.rawInput), agentDefaultModel, bridge, freeChatMessageFor, activeCommandTranslations, showReasoning ?? { get: () => false, toggle: () => {} }, (sessionController ?? {}) as never))
  }
  if (parsed.name === 'approvals' && approvals !== undefined) {
    return toEcho(await handleListApprovalsCommand(freeInvocation(parsed.rawInput), approvals, activeCommandTranslations))
  }
  if ((parsed.name === 'approve' || parsed.name === 'deny') && approvals !== undefined) {
    return toEcho(await handleApprovalCommand(freeInvocation(parsed.rawInput), approvals, parsed.name === 'approve' ? 'allowed-once' : 'rejected', activeCommandTranslations))
  }
  if (parsed.name === 'help') {
    // Prefer the full scoped command list when a session/agent exists (a
    // persisted cold session is resumed here); otherwise fall back to listing
    // the commands this plugin contributes so /help always works. Rendered as
    // a card so markdown (headers / code) renders — a plain text message does
    // not.
    const scoped = await bridge.resolveAgentOrResume(chatMessage)
    const helpText = scoped !== undefined
      ? ((await handleHelpCommand(freeInvocation(parsed.rawInput, scoped), commands, activeCommandTranslations))?.text ?? '')
      : renderFeishuCommandsOnly(activeCommandTranslations)
    return { kind: 'success', text: '', card: renderSessionResultCard('🧭 帮助', [helpText]) }
  }
  // Stash the chat coordinates so the registered handler can find them
  // without holding per-invocation state on the agent. The bridge serializes
  // inbound messages per chat, so a synchronous dispatch always sees its own
  // chat context here.
  const agent = await bridge.resolveAgentOrResume(chatMessage)
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
