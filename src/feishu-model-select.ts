/**
 * Feishu card-based model selector. Two-step flow:
 *   1. Provider selection — pick a provider from a dropdown.
 *   2. Model selection — pick a model from a dropdown, click "确认" to apply.
 *
 * The model dropdown and confirm button are inside a form container so that
 * selecting a model does NOT trigger any callback — only clicking "确认"
 * submits the form and applies the switch.
 *
 * @module @starxer/dsh-feishu/feishu-model-select
 */

import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { LlmProviderInfo, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { HarnessConversationService } from './harness.ts'
import type { ConversationMessage } from './conversation.ts'

/** Minimal logger surface. */
interface PluginLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** Source of the current bridge — recreated on every channel reconcile. */
interface BridgeHolder {
  current: HarnessConversationService | undefined
}

/** Subset of the cardAction event the selector consumes. */
export interface CardActionLike {
  messageId?: string
  chatId?: string
  operator?: { openId?: string }
  action?: { value?: unknown; tag?: string; option?: string }
  raw?: { action?: { value?: unknown; tag?: string; option?: string; form_value?: Record<string, unknown> } }
}

/** Channel adapter — same surface as feishu-questions.ts plus the V2 card
 *  instance methods used by the model selector. */
export interface ModelSelectChannel {
  send(to: string, input: { card: object } | { text: string }, opts?: { replyInThread?: boolean }): Promise<{ messageId?: string }>
  updateCard(messageId: string, card: object): Promise<void>
  recallMessage(messageId: string): Promise<void>
  onCardAction(handler: (evt: CardActionLike) => void | Promise<void>): () => void
  createCardInstance(card: object): Promise<string>
  sendCardByReference(to: string, cardId: string, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCardInstance(cardId: string, card: object, sequence: number): Promise<void>
}

/** Narrow llm directory view. */
interface LlmDirectoryLike {
  listProviders(): readonly LlmProviderInfo[]
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModelInfo(provider: string, model: string): Promise<{ reasoning?: { efforts: readonly { id: string }[]; defaultEffort?: string } | undefined }>
}

/** Narrow SessionController view — what feishu-model-select actually uses. */
interface SessionControllerLike {
  selectModel(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
}

/** A resolved model selection. */
interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** A queued card action. */
interface QueuedAction {
  action: ModelCardAction
  flow?: ModelCardFlow
  chatMessage: ConversationMessage
  messageId: string | undefined
}

// ---------------------------------------------------------------------------
// Card action payload types
// ---------------------------------------------------------------------------

type ModelCardAction =
  | { type: 'enter-select' }
  | { type: 'select-provider'; provider: string }
  | { type: 'go-back' }
  | { type: 'confirm-select'; provider: string; model: string; reasoningEffort?: string }

/** Flow marker embedded in card action values. `undefined` = the standalone
 *  `/model` switch flow; `'new-session'` = the `/new` card flow reusing the
 *  same provider/model cards but committing to session creation instead. */
export type ModelCardFlow = 'new-session' | undefined

// ---------------------------------------------------------------------------
// Card rendering — two-step dropdown flow
// ---------------------------------------------------------------------------

const REASONING_EFFORT_OPTIONS = [
  { label: 'default（不指定）', value: 'default' },
  { label: 'off（关闭思考）', value: 'off' },
  { label: 'low（轻度思考）', value: 'low' },
  { label: 'high（深度思考）', value: 'high' },
  { label: 'max（最大思考）', value: 'max' },
]

function buildProviderOptions(providers: readonly LlmProviderInfo[]): object[] {
  return providers.map(p => ({
    text: { tag: 'plain_text', content: p.name !== '' ? `${p.name} (${p.id})` : p.id },
    value: p.id,
  }))
}

function buildModelOptions(models: readonly LlmModelInfo[]): object[] {
  return models.map(m => ({
    text: { tag: 'plain_text', content: m.name !== '' && m.name !== m.id ? `${m.name} (${m.id})` : m.id },
    value: m.id,
  }))
}

/** Step 1 — Provider selection card. `flow` distinguishes the standalone
 *  `/model` switch from the `/new` card flow reusing the same card. */
export function renderProviderSelectCard(
  providers: readonly LlmProviderInfo[],
  current: ModelSelection,
  flow?: ModelCardFlow,
): object {
  const effort = current.reasoningEffort !== undefined && current.reasoningEffort !== ''
    ? current.reasoningEffort
    : 'default'

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: flow === 'new-session' ? '🤖 模型选择（新建会话）' : '🤖 模型选择' },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `**当前模型**　\`${current.provider}/${current.model}\`\n🧭 思考强度：\`${effort}\``,
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: '**选择 Provider**',
        },
        {
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: '选择 Provider...' },
          options: buildProviderOptions(providers),
          value: current.provider,
          behaviors: [{
            type: 'callback',
            value: { action: 'select-provider', ...(flow === undefined ? {} : { flow }) },
          }],
        },
      ],
    },
  }
}

/** Step 2 — Model selection card.
 *  Model dropdown + (optional) reasoning effort dropdown + confirm button
 *  inside a form. Selecting a model or effort does NOT trigger a callback —
 *  only clicking "确认" submits the form and applies the switch.
 *  Back button outside the form. */
export function renderModelSelectCard(
  providers: readonly LlmProviderInfo[],
  models: readonly LlmModelInfo[],
  selectedProvider: string,
  selectedModel: string,
  currentEffort?: string,
  supportsReasoning = true,
  flow?: ModelCardFlow,
): object {
  const modelOptions = buildModelOptions(models)

  const providerInfo = providers.find(p => p.id === selectedProvider)
  const providerLabel = providerInfo !== undefined && providerInfo.name !== ''
    ? `${providerInfo.name} (${providerInfo.id})`
    : selectedProvider

  // Reasoning effort dropdown options
  const effortValue = currentEffort !== undefined && currentEffort !== '' ? currentEffort : 'default'
  const effortOptions = REASONING_EFFORT_OPTIONS.map(o => ({
    text: { tag: 'plain_text', content: o.label },
    value: o.value,
  }))

  // Build form elements — conditionally include reasoning effort dropdown.
  const formElements: object[] = [
    {
      tag: 'markdown',
      content: '**选择模型**',
    },
    {
      tag: 'select_static',
      name: 'model',
      placeholder: { tag: 'plain_text', content: modelOptions.length > 0 ? '选择模型...' : '该 Provider 下暂无可用模型' },
      options: modelOptions,
      value: selectedModel,
    },
  ]

  if (supportsReasoning) {
    formElements.push({
      tag: 'markdown',
      content: '**思考强度**',
    })
    formElements.push({
      tag: 'select_static',
      name: 'reasoning_effort',
      placeholder: { tag: 'plain_text', content: '选择思考强度...' },
      options: effortOptions,
      value: effortValue,
    })
  }

  formElements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: flow === 'new-session' ? '✅ 确认并创建会话' : '✅ 确认切换' },
    type: 'primary',
    name: 'confirm',
    form_action_type: 'submit',
    behaviors: [{
      type: 'callback',
      value: { action: 'confirm-select', provider: selectedProvider, ...(flow === undefined ? {} : { flow }) },
    }],
  })

  const elements: object[] = [
    {
      tag: 'markdown',
      content: `**Provider**　\`${providerLabel}\``,
    },
    { tag: 'hr' },
    {
      tag: 'form',
      name: `model_form_${selectedProvider}`,
      elements: formElements,
    },
    // Back button — outside the form so it triggers a regular callback.
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '← 返回选择 Provider' },
      type: 'default',
      behaviors: [{
        type: 'callback',
        value: { action: 'go-back' },
      }],
    },
  ]

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 模型选择' },
      template: 'blue',
    },
    body: { elements },
  }
}

/** Confirmation card after a successful switch. */
function renderSwitchedCard(provider: string, model: string, name?: string, reasoningEffort?: string): object {
  const label = name !== undefined && name !== '' && name !== model
    ? `${name} (\`${provider}/${model}\`)`
    : `\`${provider}/${model}\``
  const effortLine = reasoningEffort !== undefined && reasoningEffort !== ''
    ? `\n🧠 思考强度：\`${reasoningEffort}\``
    : ''
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 模型选择' },
      template: 'green',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '✅ **已切换**\n\n' +
            `🔹 ${label}${effortLine}\n\n` +
            '下一轮对话将使用新模型。',
        },
      ],
    },
  }
}

// ---------------------------------------------------------------------------
// Card action handler
// ---------------------------------------------------------------------------

/** Parse cardAction events. Handles both button callbacks (action.value)
 *  and form submissions (raw.action.form_value). */
function parseCardAction(evt: CardActionLike): { action: ModelCardAction; flow?: ModelCardFlow } | undefined {
  // --- Form submission: confirm button inside the model form ---
  const formValue = evt.raw?.action?.form_value
  if (formValue !== undefined) {
    const raw = evt.action?.value
    let valueObj: Record<string, unknown> | undefined
    if (typeof raw === 'object' && raw !== null) {
      valueObj = raw as Record<string, unknown>
    } else if (typeof raw === 'string') {
      try {
        let result: unknown = JSON.parse(raw)
        let depth = 0
        while (typeof result === 'string' && depth < 4) {
          try { result = JSON.parse(result) } catch { break }
          depth++
        }
        if (typeof result === 'object' && result !== null) valueObj = result as Record<string, unknown>
      } catch { /* not JSON */ }
    }
    const actionType = valueObj !== undefined
      ? (typeof valueObj.action === 'string' ? valueObj.action : undefined)
      : undefined
    const provider = valueObj !== undefined
      ? (typeof valueObj.provider === 'string' ? valueObj.provider : undefined)
      : undefined
    const flow = valueObj !== undefined && valueObj.flow === 'new-session' ? 'new-session' as const : undefined

    if (actionType === 'confirm-select' && typeof provider === 'string') {
      const model = typeof formValue.model === 'string' ? formValue.model : undefined
      const effort = typeof formValue.reasoning_effort === 'string' && formValue.reasoning_effort !== 'default'
        ? formValue.reasoning_effort
        : undefined
      if (typeof model === 'string' && model !== '') {
        return { action: { type: 'confirm-select', provider, model, ...(effort !== undefined ? { reasoningEffort: effort } : {}) }, flow }
      }
    }
    return undefined
  }

  // --- Button callback ---
  const raw = evt.action?.value
  let valueObj: Record<string, unknown> | undefined
  if (typeof raw === 'string') {
    try {
      let result: unknown = JSON.parse(raw)
      let depth = 0
      while (typeof result === 'string' && depth < 4) {
        try { result = JSON.parse(result) } catch { break }
        depth++
      }
      if (typeof result === 'object' && result !== null) valueObj = result as Record<string, unknown>
    } catch { /* not JSON */ }
  } else if (typeof raw === 'object' && raw !== null) {
    valueObj = raw as Record<string, unknown>
  }

  if (valueObj === undefined) return undefined
  const actionType = typeof valueObj.action === 'string' ? valueObj.action : (typeof valueObj.type === 'string' ? valueObj.type : undefined)
  const provider = typeof valueObj.provider === 'string' ? valueObj.provider : undefined
  const option = evt.action?.option
  const flow = valueObj.flow === 'new-session' ? 'new-session' as const : undefined

  if (actionType === 'enter-select') return { action: { type: 'enter-select' }, flow }
  if (actionType === 'select-provider' && typeof option === 'string') return { action: { type: 'select-provider', provider: option }, flow }
  if (actionType === 'go-back') return { action: { type: 'go-back' }, flow }
  return undefined
}

function chatMessageFromEvent(evt: CardActionLike): ConversationMessage | undefined {
  if (evt.chatId === undefined) return undefined
  return { chatId: evt.chatId, chatType: 'p2p' }
}

// ---------------------------------------------------------------------------
// V2 card instance helpers
// ---------------------------------------------------------------------------

export async function sendModelCardV2(
  channel: ModelSelectChannel,
  chatMessage: ConversationMessage,
  card: object,
  cardByMessage: Map<string, string>,
  sequenceByCard: Map<string, number>,
): Promise<{ messageId: string; cardId: string }> {
  const cardId = await channel.createCardInstance(card)
  // Topic messages must be sent as replies to the topic ROOT message so the
  // card lands inside the topic instead of leaking to the main chat stream.
  const opts = chatMessage.threadId !== undefined && chatMessage.rootId !== undefined
    ? { replyInThread: true, replyTo: chatMessage.rootId }
    : {}
  const result = await channel.sendCardByReference(chatMessage.chatId, cardId, opts)
  const messageId = result.messageId ?? ''
  if (messageId !== '') {
    cardByMessage.set(messageId, cardId)
    sequenceByCard.set(cardId, 0)
  }
  return { messageId, cardId }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function startFeishuModelSelect(deps: {
  llm: LlmDirectoryLike
  agentDefaultModel: AgentDefaultModelConfig
  bridgeHolder: BridgeHolder
  sessionController: SessionControllerLike
  channel: ModelSelectChannel
  logger: PluginLogger
  /** When set, confirm actions carrying the `new-session` flow marker are
   *  forwarded here instead of applying the model switch. Used by the
   *  `/new` card flow, which reuses the provider/model cards but commits the
   *  selection to session creation. */
  onNewSessionConfirm?: (chatMessage: ConversationMessage, selection: { provider: string; model: string; reasoningEffort?: string }, messageId: string | undefined) => Promise<void>
  /** Topic reply context recorded for a chat (rootId/threadId). Card action
   *  events carry only chatId + messageId, so the caller restores the thread
   *  context here — otherwise selections / new-session commits inside a topic
   *  would target the main chat key instead of the topic key. */
  topicFor?: (chatId: string) => { rootId?: string; threadId?: string }
}): { dispose: () => void; cardByMessage: Map<string, string>; sequenceByCard: Map<string, number> } {
  const { llm, agentDefaultModel, bridgeHolder, sessionController, channel, logger, onNewSessionConfirm, topicFor } = deps

  const processing = new Map<string, true>()
  const actionQueue = new Map<string, QueuedAction[]>()
  const MIN_UPDATE_INTERVAL_MS = 500

  const cardByMessage = new Map<string, string>()
  const sequenceByCard = new Map<string, number>()

  async function updateCardInstanceOnMessage(
    messageId: string | undefined,
    chatMessage: ConversationMessage,
    card: object,
  ): Promise<void> {
    if (messageId === undefined) {
      await sendModelCardV2(channel, chatMessage, card, cardByMessage, sequenceByCard)
      return
    }
    const cardId = cardByMessage.get(messageId)
    if (cardId === undefined) {
      await sendModelCardV2(channel, chatMessage, card, cardByMessage, sequenceByCard)
      return
    }
    const seq = (sequenceByCard.get(cardId) ?? 0) + 1
    sequenceByCard.set(cardId, seq)
    try {
      await channel.updateCardInstance(cardId, card, seq)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: model-select updateCardInstance failed: ${msg} — sending fresh card`)
      const fresh = await sendModelCardV2(channel, chatMessage, card, cardByMessage, sequenceByCard)
      cardByMessage.set(fresh.messageId, fresh.cardId)
    }
  }

  /** Step 1 → Step 2: provider selected, load its models. */
  async function handleSelectProvider(
    chatMessage: ConversationMessage,
    messageId: string | undefined,
    provider: string,
    flow?: ModelCardFlow,
  ): Promise<void> {
    const bridge = bridgeHolder.current
    if (bridge === undefined) return
    const current = agentDefaultModel.currentSelection()

    let models: readonly LlmModelInfo[]
    try {
      models = await llm.listModels(provider)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: failed to list models for ${provider}: ${msg}`)
      models = []
    }

    // Check if any model in this provider supports reasoning effort.
    // If none do, hide the reasoning dropdown to avoid confusing the user.
    let supportsReasoning = false
    try {
      const checks = await Promise.allSettled(
        models.slice(0, 8).map(m => llm.resolveModelInfo(provider, m.id)),
      )
      supportsReasoning = checks.some(r =>
        r.status === 'fulfilled' &&
        r.value.reasoning !== undefined &&
        r.value.reasoning.efforts.length > 0,
      )
    } catch {
      // If we can't resolve, default to not showing (safer).
    }

    const providers = llm.listProviders()
    const card = renderModelSelectCard(providers, models, provider, current.model, current.reasoningEffort, supportsReasoning, flow)
    await updateCardInstanceOnMessage(messageId, chatMessage, card)
  }

  /** Step 2 → Step 1: back button (form reset). */
  async function handleGoBack(
    chatMessage: ConversationMessage,
    messageId: string | undefined,
    flow?: ModelCardFlow,
  ): Promise<void> {
    const bridge = bridgeHolder.current
    if (bridge === undefined) return
    const current = agentDefaultModel.currentSelection()
    const providers = llm.listProviders()
    const card = renderProviderSelectCard(providers, current, flow)
    await updateCardInstanceOnMessage(messageId, chatMessage, card)
  }

  /** Step 3: confirm button clicked, apply the selection. */
  async function handleConfirmSelect(
    chatMessage: ConversationMessage,
    messageId: string | undefined,
    provider: string,
    model: string,
    reasoningEffort?: string,
    flow?: ModelCardFlow,
  ): Promise<void> {
    const bridge = bridgeHolder.current
    if (bridge === undefined) return

    // New-session flow: the card is part of `/new` session creation — commit
    // the selection to the caller (which creates the session) instead of
    // switching the current chat's model.
    if (flow === 'new-session') {
      if (onNewSessionConfirm === undefined) {
        logger.warn('dsh-feishu: new-session confirm received but no onNewSessionConfirm callback registered')
        return
      }
      await onNewSessionConfirm(chatMessage, { provider, model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) }, messageId)
      return
    }

    const providers = new Set(llm.listProviders().map(p => p.id))
    if (!providers.has(provider)) {
      logger.warn(`dsh-feishu: model-select attempted to switch to unknown provider ${provider}`)
      return
    }

    // Get model name and check reasoning support (non-fatal).
    let modelName: string | undefined
    let modelSupportsReasoning = true
    try {
      const models = await llm.listModels(provider)
      const found = models.find(m => m.id === model)
      modelName = found?.name
    } catch {
      // Non-fatal
    }
    try {
      const info = await llm.resolveModelInfo(provider, model)
      modelSupportsReasoning = info.reasoning !== undefined && info.reasoning.efforts.length > 0
    } catch {
      // If we can't resolve, assume supported.
    }

    // Strip reasoning effort if the model doesn't support it.
    const effectiveReasoningEffort = modelSupportsReasoning ? reasoningEffort : undefined

    // Atomic model switch via session controller: resolves the session
    // (creating the live agent if needed), validates the model, writes the
    // agent-scoped selection ref so the WebUI sees the change immediately,
    // AND persists the default selection. No two-step fallback needed.
    try {
      const sessionId = bridge.resolveSessionIdFor(chatMessage)
      await sessionController.selectModel({
        sessionId,
        provider,
        model,
        ...(effectiveReasoningEffort !== undefined ? { reasoningEffort: effectiveReasoningEffort } : {}),
      })
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: model-select failed: ${msg}`)
      const card = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '🤖 模型选择' }, template: 'red' },
        body: { elements: [{ tag: 'markdown', content: `⚠️ **切换失败**

${msg}` }] },
      }
      await updateCardInstanceOnMessage(messageId, chatMessage, card)
      return
    }

    // Step 3: Show success card.
    const card = renderSwitchedCard(provider, model, modelName, effectiveReasoningEffort)
    await updateCardInstanceOnMessage(messageId, chatMessage, card)
  }

  const onCardAction = async (evt: CardActionLike): Promise<void> => {
    const parsed = parseCardAction(evt)
    if (parsed === undefined) return

    const bridge = bridgeHolder.current
    if (bridge === undefined) {
      logger.warn('dsh-feishu: model-select card action received but bridge is not ready')
      return
    }

    const chatMessage = chatMessageFromEvent(evt)
    if (chatMessage === undefined) {
      logger.warn('dsh-feishu: model-select card action missing chatId')
      return
    }

    // Card actions carry only chatId + messageId; restore the topic context
    // recorded when the card was sent so selections and `new-session` commits
    // target the topic's key instead of the main chat's.
    const topic = topicFor?.(chatMessage.chatId)
    if (topic?.threadId !== undefined && chatMessage.threadId === undefined) {
      chatMessage.threadId = topic.threadId
      if (topic.rootId !== undefined) chatMessage.rootId = topic.rootId
    }

    const key = chatMessage.chatId
    let queue = actionQueue.get(key)
    if (queue === undefined) {
      queue = []
      actionQueue.set(key, queue)
    }
    queue.push({ action: parsed.action, flow: parsed.flow, chatMessage, messageId: evt.messageId })
    await drainQueue(key)
  }

  async function drainQueue(key: string): Promise<void> {
    if (processing.has(key)) return
    processing.set(key, true)
    try {
      const queue = actionQueue.get(key)
      if (queue === undefined) return
      while (queue.length > 0) {
        const item = queue.shift()!
        try {
          switch (item.action.type) {
            case 'enter-select': {
              const bridge = bridgeHolder.current
              if (bridge === undefined) break
              const current = agentDefaultModel.currentSelection()
              const providers = llm.listProviders()
              const card = renderProviderSelectCard(providers, current, item.flow)
              await updateCardInstanceOnMessage(item.messageId, item.chatMessage, card)
              break
            }
            case 'select-provider':
              await handleSelectProvider(item.chatMessage, item.messageId, item.action.provider, item.flow)
              break
            case 'go-back':
              await handleGoBack(item.chatMessage, item.messageId, item.flow)
              break
            case 'confirm-select':
              await handleConfirmSelect(item.chatMessage, item.messageId, item.action.provider, item.action.model, item.action.reasoningEffort, item.flow)
              break
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error)
          logger.error(`dsh-feishu: model-select action failed: ${msg}`)
        }
        if (queue.length > 0) {
          await new Promise<void>(r => setTimeout(r, MIN_UPDATE_INTERVAL_MS))
        }
      }
    } finally {
      processing.delete(key)
      actionQueue.delete(key)
    }
  }

  const unsubscribe = channel.onCardAction(onCardAction)
  return {
    dispose: () => {
      unsubscribe()
      processing.clear()
      actionQueue.clear()
    },
    cardByMessage,
    sequenceByCard,
  }
}
