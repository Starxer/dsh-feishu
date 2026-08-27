/**
 * Feishu card-based model selector. Renders an interactive Card JSON 2.0
 * flow — current model → provider list → model list → confirmation — so users
 * can browse and switch models without memorising `provider/model` syntax.
 *
 * The cardAction callback is registered globally on the channel; button
 * `value` payloads encode the next step so the handler is stateless. Each
 * navigation step sends a fresh card message (not updateCard) to avoid
 * Feishu's per-card patch limit.
 *
 * @module @starxer/dsh-feishu/feishu-model-select
 */

import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
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
interface CardActionLike {
  messageId?: string
  chatId?: string
  operator?: { openId?: string }
  action?: { value?: unknown; tag?: string; option?: string }
  /** Raw event from Feishu (available when includeRawEvent is true). */
  raw?: { action?: { value?: unknown; tag?: string; option?: string } }
}

/** Channel adapter — same surface as feishu-questions.ts. */
export interface ModelSelectChannel {
  send(to: string, input: { card: object } | { text: string }, opts?: { replyInThread?: boolean }): Promise<{ messageId?: string }>
  updateCard(messageId: string, card: object): Promise<void>
  recallMessage(messageId: string): Promise<void>
  onCardAction(handler: (evt: CardActionLike) => void | Promise<void>): () => void
}

/** Narrow llm directory view — matches the one in commands.ts. */
interface LlmDirectoryLike {
  listProviders(): readonly LlmProviderInfo[]
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
}

/** Narrow apiProxy view — matches the one in commands.ts. */
interface ApiProxyLike {
  sessions: {
    selectModel(request: { rpcId?: string; payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string } }): Promise<unknown>
  }
}

/** A resolved model selection. */
interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** A queued card action with the context needed to execute it. */
interface QueuedAction {
  action: ModelCardAction
  chatMessage: ConversationMessage
}

// ---------------------------------------------------------------------------
// Card action payload types
// ---------------------------------------------------------------------------

type ModelCardAction =
  | { type: 'browse-providers'; page?: number }
  | { type: 'browse-models'; provider: string; page?: number }
  | { type: 'select'; provider: string; model: string }

const PROVIDERS_PER_PAGE = 6
const MODELS_PER_PAGE = 8

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------

/** Build the "current model" card with a single "browse" button. */
export function renderCurrentModelCard(current: ModelSelection): object {
  const effort = current.reasoningEffort !== undefined && current.reasoningEffort !== ''
    ? current.reasoningEffort
    : 'default'
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 模型选择' },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '**当前模型**\n\n' +
            `🔹 \`${current.provider}/${current.model}\`\n` +
            `🧭 思考强度：\`${effort}\`\n\n` +
            '点击下方按钮浏览所有可用模型。',
        },
        {
          tag: 'hr',
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '📋 浏览所有模型' },
          type: 'primary',
          behaviors: [{
            type: 'callback',
            value: { type: 'browse-providers' },
          }],
        },
      ],
    },
  }
}

/** Build the provider-list card. Paginated when providers exceed one page. */
export function renderProvidersCard(
  providers: readonly LlmProviderInfo[],
  page: number,
  current: ModelSelection,
): object {
  const total = providers.length
  const start = page * PROVIDERS_PER_PAGE
  const end = Math.min(start + PROVIDERS_PER_PAGE, total)
  const slice = providers.slice(start, end)
  const totalPages = Math.ceil(total / PROVIDERS_PER_PAGE)

  const elements: object[] = [
    {
      tag: 'markdown',
      content: '**选择 Provider**\n\n' +
        `共 ${total} 个可用，第 ${page + 1}/${totalPages} 页`,
    },
    { tag: 'hr' },
  ]

  for (const provider of slice) {
    const isActive = provider.id === current.provider
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: provider.name !== '' ? `${provider.name} (${provider.id})` : provider.id },
      type: isActive ? 'primary' : 'default',
      behaviors: [{
        type: 'callback',
        value: { type: 'browse-models', provider: provider.id },
      }],
    })
  }

  // Pagination controls.
  if (totalPages > 1) {
    elements.push({ tag: 'hr' })
    if (page > 0) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '← 上一页' },
        type: 'default',
        behaviors: [{
          type: 'callback',
          value: { type: 'browse-providers', page: page - 1 },
        }],
      })
    }
    if (page < totalPages - 1) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '下一页 →' },
        type: 'default',
        behaviors: [{
          type: 'callback',
          value: { type: 'browse-providers', page: page + 1 },
        }],
      })
    }
  }

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

/** Build the model-list card for one provider. Paginated when models exceed
 *  one page. The currently-selected model is highlighted. */
export function renderModelsCard(
  provider: string,
  models: readonly LlmModelInfo[],
  page: number,
  current: ModelSelection,
): object {
  const total = models.length
  const start = page * MODELS_PER_PAGE
  const end = Math.min(start + MODELS_PER_PAGE, total)
  const slice = models.slice(start, end)
  const totalPages = Math.ceil(total / MODELS_PER_PAGE)

  const elements: object[] = [
    {
      tag: 'markdown',
      content: `**选择模型 — \`${provider}\`**\n\n` +
        `共 ${total} 个模型，第 ${page + 1}/${totalPages} 页`,
    },
    { tag: 'hr' },
  ]

  for (const model of slice) {
    const isActive = provider === current.provider && model.id === current.model
    const label = model.name !== '' && model.name !== model.id
      ? `${model.name} (\`${model.id}\`)`
      : `\`${model.id}\``
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: label },
      type: isActive ? 'primary' : 'default',
      behaviors: [{
        type: 'callback',
        value: { type: 'select', provider, model: model.id },
      }],
    })
  }

  if (totalPages > 1) {
    elements.push({ tag: 'hr' })
    if (page > 0) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '← 上一页' },
        type: 'default',
        behaviors: [{
          type: 'callback',
          value: { type: 'browse-models', provider, page: page - 1 },
        }],
      })
    }
    if (page < totalPages - 1) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '下一页 →' },
        type: 'default',
        behaviors: [{
          type: 'callback',
          value: { type: 'browse-models', provider, page: page + 1 },
        }],
      })
    }
  }

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

/** Build the confirmation card shown after a successful switch. */
function renderSwitchedCard(provider: string, model: string, name?: string): object {
  const label = name !== undefined && name !== '' && name !== model
    ? `${name} (\`${provider}/${model}\`)`
    : `\`${provider}/${model}\``
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
            `🔹 ${label}\n\n` +
            '下一轮对话将使用新模型。',
        },
      ],
    },
  }
}

// ---------------------------------------------------------------------------
// Card action handler
// ---------------------------------------------------------------------------

/** Parse the button `value` from a cardAction event, handling Feishu's
 *  potential double (or triple) JSON encoding. Returns undefined when the
 *  value is not a recognised model-select action. */
function parseAction(raw: unknown): ModelCardAction | undefined {
  let parsed: unknown
  if (typeof raw === 'string') {
    try {
      let result: unknown = JSON.parse(raw)
      // Feishu may double-encode (JSON string containing JSON). After a
      // card update the encoding can stack to triple — keep unwrapping
      // until we get a non-string or run out of depth.
      let depth = 0
      while (typeof result === 'string' && depth < 4) {
        try {
          result = JSON.parse(result)
        } catch {
          break
        }
        depth++
      }
      parsed = result
    } catch {
      return undefined
    }
  } else if (typeof raw === 'object' && raw !== null) {
    parsed = raw
  } else {
    return undefined
  }
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') return undefined
  const obj = parsed as Record<string, unknown>
  if (typeof obj.type !== 'string') return undefined
  switch (obj.type) {
    case 'browse-providers':
      return { type: 'browse-providers', page: typeof obj.page === 'number' ? obj.page : 0 }
    case 'browse-models':
      if (typeof obj.provider !== 'string') return undefined
      return { type: 'browse-models', provider: obj.provider, page: typeof obj.page === 'number' ? obj.page : 0 }
    case 'select':
      if (typeof obj.provider !== 'string' || typeof obj.model !== 'string') return undefined
      return { type: 'select', provider: obj.provider, model: obj.model }
    default:
      return undefined
  }
}

/** Build a ConversationMessage from a cardAction event's chat coordinates. */
function chatMessageFromEvent(evt: CardActionLike): ConversationMessage | undefined {
  if (evt.chatId === undefined) return undefined
  return { chatId: evt.chatId, chatType: 'p2p' }
}

/**
 * Subscribe to cardAction events and drive the model selector card flow.
 * Returns a disposer that detaches the listener; safe to call multiple times.
 *
 * Each navigation step sends a fresh card message (not updateCard) to avoid
 * Feishu's per-card patch limit — after 2-3 `im.v1.message.patch` calls the
 * card's buttons stop responding entirely. Old cards remain in the chat
 * (recall is not supported), but every click produces a working card.
 * Rapid clicks are enqueued and drained sequentially with a minimum interval
 * between sends, so no click is ever silently dropped.
 */
export function startFeishuModelSelect(deps: {
  llm: LlmDirectoryLike
  agentDefaultModel: AgentDefaultModelConfig
  bridgeHolder: BridgeHolder
  apiProxy?: ApiProxyLike
  channel: ModelSelectChannel
  logger: PluginLogger
}): () => void {
  const { llm, agentDefaultModel, bridgeHolder, apiProxy, channel, logger } = deps

  // Per-chat queue: rapid clicks are enqueued and processed sequentially.
  // The processing lock prevents concurrent drains; the interval between
  // consecutive sends avoids overwhelming the chat. Each action sends a
  // fresh card (not updateCard), so there is no per-card patch limit to hit.
  // Unlike the previous drop-on-interval approach, queuing means no click is
  // silently lost — the card always advances to the page the user asked for.
  const processing = new Map<string, true>()
  const actionQueue = new Map<string, QueuedAction[]>()
  const MIN_SEND_INTERVAL_MS = 500

  /** Send a fresh card message for each navigation step. Using `send` (not
   *  `updateCard`) avoids Feishu's per-card patch limit — after 2-3 patches
   *  `im.v1.message.patch` silently stops updating the card and its buttons
   *  become unresponsive. Old cards remain in the chat (the user does not
   *  want recall), but every navigation step produces a working, clickable
   *  card. */
  async function sendCard(card: object, chatMessage: ConversationMessage): Promise<void> {
    try {
      await channel.send(chatMessage.chatId, { card })
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: model-select send failed: ${msg}`)
    }
  }

  async function handleBrowseProviders(
    chatMessage: ConversationMessage,
    page: number,
  ): Promise<void> {
    const bridge = bridgeHolder.current
    if (bridge === undefined) return
    const current = bridge.currentSelectionFor(chatMessage) ?? agentDefaultModel.currentSelection()
    const providers = llm.listProviders()
    const card = renderProvidersCard(providers, page, current)
    await sendCard(card, chatMessage)
  }

  async function handleBrowseModels(
    chatMessage: ConversationMessage,
    provider: string,
    page: number,
  ): Promise<void> {
    const bridge = bridgeHolder.current
    if (bridge === undefined) return
    const current = bridge.currentSelectionFor(chatMessage) ?? agentDefaultModel.currentSelection()
    let models: readonly LlmModelInfo[]
    try {
      models = await llm.listModels(provider)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-feishu: failed to list models for ${provider}: ${msg}`)
      return
    }
    if (models.length === 0) return
    const card = renderModelsCard(provider, models, page, current)
    await sendCard(card, chatMessage)
  }

  async function handleSelect(
    chatMessage: ConversationMessage,
    provider: string,
    model: string,
  ): Promise<void> {
    const bridge = bridgeHolder.current
    if (bridge === undefined) return

    // Validate that the provider is registered.
    const providers = new Set(llm.listProviders().map(p => p.id))
    if (!providers.has(provider)) {
      logger.warn(`dsh-feishu: model-select attempted to switch to unknown provider ${provider}`)
      return
    }

    // Resolve the model's human-readable name for the confirmation card.
    let modelName: string | undefined
    try {
      const models = await llm.listModels(provider)
      const found = models.find(m => m.id === model)
      modelName = found?.name
    } catch {
      // Non-fatal: the name is cosmetic.
    }

    // Persist + apply the selection (same chain as /model slash command).
    const selection = { provider, model }
    await agentDefaultModel.saveSelection(selection as never)
    bridge.setCurrentSelection(chatMessage, selection)

    if (apiProxy !== undefined) {
      try {
        const sessionId = bridge.resolveSessionIdFor(chatMessage)
        await apiProxy.sessions.selectModel({
          payload: { sessionId, provider, model },
        })
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-feishu: model-select failed to sync apiProxy: ${msg}`)
      }
    }

    // Send a fresh confirmation card.
    const card = renderSwitchedCard(provider, model, modelName)
    await sendCard(card, chatMessage)
  }

  const onCardAction = async (evt: CardActionLike): Promise<void> => {
    const action = parseAction(evt.action?.value)
    if (action === undefined) return

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

    const key = chatMessage.chatId

    // Enqueue — never drop. The drain loop processes actions sequentially
    // with a minimum interval between sends to avoid overwhelming the chat.
    // Each action sends a fresh card (not updateCard), so there is no per-card
    // patch limit to hit — every click produces a working, clickable card.
    let queue = actionQueue.get(key)
    if (queue === undefined) {
      queue = []
      actionQueue.set(key, queue)
    }
    queue.push({ action, chatMessage })

    await drainQueue(key)
  }

  /** Drain the per-chat action queue sequentially. Only one drain runs at
   *  a time per chat; concurrent calls return immediately and let the
   *  active drain pick up the newly queued items. */
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
            case 'browse-providers':
              await handleBrowseProviders(item.chatMessage, item.action.page ?? 0)
              break
            case 'browse-models':
              await handleBrowseModels(item.chatMessage, item.action.provider, item.action.page ?? 0)
              break
            case 'select':
              await handleSelect(item.chatMessage, item.action.provider, item.action.model)
              break
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error)
          logger.error(`dsh-feishu: model-select action failed: ${msg}`)
        }
        // Rate guard: wait between consecutive sends to avoid overwhelming
        // the chat or tripping Feishu's send rate limit. Only wait when
        // there is another action queued — the last action needs no delay.
        if (queue.length > 0) {
          await new Promise<void>(r => setTimeout(r, MIN_SEND_INTERVAL_MS))
        }
      }
    } finally {
      processing.delete(key)
      actionQueue.delete(key)
    }
  }

  const unsubscribe = channel.onCardAction(onCardAction)
  return () => {
    unsubscribe()
    processing.clear()
    actionQueue.clear()
  }
}