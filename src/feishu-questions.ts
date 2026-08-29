/**
 * Feishu UI bridge for the `ask_user_question` tool: subscribes to the
 * apiproxy mux stream so the Feishu chat can render an interactive card with
 * the question and options, then post the user's pick back through the apiproxy
 * `respond()` RPC. The first answer — Feishu or WebUI — wins because both
 * share the apiproxy's `pendingQuestions` registry.
 *
 * Why mux fan-out and not a `ctx.userQuestions` provider?
 *   `ctx.userQuestions` accepts a single provider and the apiproxy already
 *   installs one at boot; a second registration throws `DUPLICATE_PROVIDER`.
 *   The apiproxy broadcasts every `ask()` to every mux subscriber, so adding
 *   another subscriber IS the documented fan-out path — the WebUI client uses
 *   the same one. This module connects the same way.
 *
 * @module @starxer/dsh-feishu/feishu-questions
 */

import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionItem, AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionOption, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
// Side-effect import: augments `@deepseek-ai/cordis` with `'user-questions/request'`.
import '@deepseek-ai/dsh-user-questions'

// Local module augmentation: dsh-user-questions itself does not extend
// cordis.Events with the waterfall key, so we do it here for type-safe
// `ctx.on('user-questions/request', ...)` access.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'user-questions/request'(this: Context, request: AskUserQuestionRequest, next?: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>
  }
}
import type { HarnessConversationService } from './harness.ts'
import type { ConversationMessage } from './conversation.ts'

/** Minimal logger surface the listener needs; matches ctx.logger's call style. */
interface PluginLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** Source of the current bridge — recreated on every channel reconcile. */
interface BridgeHolder {
  current: HarnessConversationService | undefined
}

/** Per-question state for the card click handler. */
interface PendingCard {
  pendingId: string
  question: AskUserQuestionItem
  sessionId: string
  abortController: AbortController
  /** Resolves when the user picks an option (or the request is aborted). */
  resolve: (answer: AskUserQuestionAnswer | undefined) => void
  /** Message ID of the sent card, used to update it after selection. */
  cardMessageId?: string
}

/**
 * Channel adapter passed into the questions listener. The `currentChannel()`
 * accessor is read on every send so the listener transparently follows the
 * channel after a LarkRuntime reconcile. The `onCardAction()` helper attaches
 * a cardAction listener to whatever channel is currently active and rebinds
 * automatically on reconcile.
 */
export interface FeishuQuestionsChannel {
  /** Send a card or text to the chat. */
  send(to: string, input: { card: object } | { text: string }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCard(messageId: string, card: object): Promise<void>
  /** Subscribe to interactive-card button clicks. The handler is invoked on
   *  every channel that connects for the lifetime of this subscription. */
  onCardAction(handler: (evt: CardActionLike) => void | Promise<void>): () => void
}

/** Subset of CardActionEvent the listener consumes. */
interface CardActionLike {
  messageId?: string
  chatId?: string
  operator?: { openId?: string }
  action?: { value?: unknown; tag?: string; option?: string }
  /** Raw event from Feishu (available when includeRawEvent is true).
   *  Contains action.form_value for form container submissions. */
  raw?: { action?: { value?: unknown; tag?: string; option?: string; form_value?: Record<string, unknown> } }
}

/** Public surface the questions module reads. */
export interface FeishuQuestionsDeps {
  ctx: Context
  channel: FeishuQuestionsChannel
  bridgeHolder: BridgeHolder
  logger: PluginLogger
}

/**
 * Register a `user-questions/request` waterfall listener on the host context.
 * The listener is invoked for every `ask_user_question` call, claims the
 * request by returning an answer (skipping the default tool-ask-user
 * provider), and detaches its cardAction subscription on dispose.
 *
 * @param deps Live references to the host context, the Lark channel, and
 *   the current bridge. The bridge is read lazily because `runtime.reconcile()`
 *   replaces it; re-resolving on every question handles that case naturally.
 * @returns a disposer that detaches the listener and the cardAction handler.
 */
export function startFeishuQuestions(deps: FeishuQuestionsDeps): () => void {
  const { ctx, channel, bridgeHolder, logger } = deps
  const pendingCards = new Map<string, PendingCard>()

  // Build an answer from a card click and resolve the matching pending
  // promise. The listener is what returns the answer to the waterfall; this
  // helper is purely the cardAction → deferred bridge.
  const settlePending = (pending: PendingCard, selected: readonly string[], custom: string | undefined): AskUserQuestionAnswer => {
    pendingCards.delete(pending.pendingId)
    return {
      answers: [{
        id: pending.question.id,
        selected: [...selected],
        ...custom === undefined ? {} : { custom },
      }],
    }
  }

  const onCardAction = async (evt: CardActionLike): Promise<void> => {
    const action = evt.action
    let raw = action?.value
    let parsed: { pendingId?: unknown; questionId?: unknown; selected?: unknown; custom?: unknown; type?: unknown }
    if (typeof raw === 'string') {
      try {
        let result = JSON.parse(raw)
        if (typeof result === 'string') result = JSON.parse(result)
        parsed = result as typeof parsed
      } catch {
        return
      }
    } else if (typeof raw === 'object' && raw !== null) {
      parsed = raw as typeof parsed
    } else {
      return
    }
    const pendingId = typeof parsed.pendingId === 'string' ? parsed.pendingId : ''
    const questionId = typeof parsed.questionId === 'string' ? parsed.questionId : ''
    if (pendingId === '' || questionId === '') return
    const pending = pendingCards.get(pendingId)
    if (pending === undefined) return

    const formValue = (evt.raw?.action?.form_value ?? {}) as Record<string, unknown>

    if (parsed.type === 'skip') {
      const answer = settlePending(pending, [], undefined)
      if (pending.cardMessageId !== undefined) {
        const settledCard = renderSettledQuestionCard(pending.question, ['⏭️ 已跳过'])
        await channel.updateCard(pending.cardMessageId, settledCard).catch((error: unknown) => {
          logger.warn(`dsh-feishu: failed to update question card: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      pending.resolve(answer)
      return
    }

    if (parsed.type === 'custom') {
      const customText = typeof formValue.custom_text === 'string' ? formValue.custom_text.trim() : ''
      if (customText === '') return
      const answer = settlePending(pending, [], customText)
      if (pending.cardMessageId !== undefined) {
        const settledCard = renderSettledQuestionCard(pending.question, [`✏️ ${customText}`])
        await channel.updateCard(pending.cardMessageId, settledCard).catch((error: unknown) => {
          logger.warn(`dsh-feishu: failed to update question card: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      pending.resolve(answer)
      return
    }

    const selected = Array.isArray(parsed.selected)
      ? parsed.selected.filter((item: unknown): item is string => typeof item === 'string')
      : action?.option !== undefined ? [action.option] : []
    const custom = typeof parsed.custom === 'string' && parsed.custom !== '' ? parsed.custom : undefined
    const selectedLabels = selected.length > 0 ? selected : (action?.option !== undefined ? [action.option] : [])
    if (pending.cardMessageId !== undefined && selectedLabels.length > 0) {
      const settledCard = renderSettledQuestionCard(pending.question, selectedLabels)
      await channel.updateCard(pending.cardMessageId, settledCard).catch((error: unknown) => {
        logger.warn(`dsh-feishu: failed to update question card: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    if (selected.length === 0 && custom === undefined) return
    const answer = settlePending(pending, selected, custom)
    pending.resolve(answer)
  }
  const unsubscribeCardAction = channel.onCardAction(onCardAction)

  const handleRequest = async (
    request: AskUserQuestionRequest,
    next?: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> => {
    console.log(`dsh-feishu: [q] handleRequest entered agentDefined=${request.agent !== undefined}`)
    if (request.agent === undefined) {
      console.log('dsh-feishu: [q] no agent, falling to next')
      return next !== undefined ? await next() : Promise.reject(new Error('no user-questions answerer'))
    }
    const sessionId = request.agent.session.id
    const bridge = bridgeHolder.current
    console.log(`dsh-feishu: [q] sessionId=${sessionId} bridge=${bridge !== undefined}`)
    if (bridge === undefined) {
      console.log('dsh-feishu: [q] no bridge, falling to next')
      return next !== undefined ? await next() : Promise.reject(new Error('no bridge'))
    }
    const chat = bridge.resolveChat(sessionId)
    console.log(`dsh-feishu: [q] resolveChat=${chat === undefined ? 'MISSING' : chat.chatId}`)
    if (chat === undefined) {
      console.log('dsh-feishu: [q] session not bound to chat, falling to next')
      return next !== undefined ? await next() : Promise.reject(new Error('session not bound to chat'))
    }

    const abortController = new AbortController()
    request.signal?.addEventListener('abort', () => {
      for (const [pid, pending] of pendingCards.entries()) {
        if (pending.abortController === abortController) {
          pendingCards.delete(pid)
          pending.resolve(undefined)
        }
      }
    })

    return await presentQuestions(chat, channel, pendingCards, request.questions, abortController, logger)
  }
  // Prepended so this answerer runs BEFORE api-remotes' forwarding listener.
  // remotes routes agent-scoped waterfalls (e.g. `user-questions/request`) to
  // the WebUI client with a waterfall listener that BLOCKS waiting for a
  // WebUI answer; a plain (pushed) registration leaves Feishu inner to that
  // chain, so the card never renders here. Prepend makes Feishu claim first,
  // but only for sessions bound to a Feishu chat — unbound sessions fall
  // through to `next()` and back to the WebUI answerer.
  const disposeListener = ctx.on('user-questions/request', handleRequest, { prepend: true })

  return () => {
    disposeListener()
    unsubscribeCardAction()
    for (const pending of pendingCards.values()) {
      pending.resolve(undefined)
      pending.abortController.abort()
    }
    pendingCards.clear()
  }
}

/**
 * Render each question as its own card and present the batch sequentially:
 * one card at a time, awaiting that card's answer before sending the next
 * question. A skipped question still yields an (empty-selection) answer item,
 * so the returned batch always has one item per question unless the request is
 * aborted or a card fails to send. This matches the WebUI's whole-batch answer
 * encoding while keeping Feishu's one-card-at-a-time chat UX.
 */
async function presentQuestions(
  chat: ConversationMessage,
  channel: FeishuQuestionsChannel,
  pendingCards: Map<string, PendingCard>,
  questions: readonly AskUserQuestionItem[],
  abortController: AbortController,
  logger?: PluginLogger,
): Promise<AskUserQuestionAnswer> {
  if (questions.length === 0) {
    return { answers: [] }
  }
  console.log(`dsh-feishu: [q] presenting ${questions.length} question(s) to chat=${chat.chatId} thread=${chat.threadId ?? '-'}`)
  const answers: AskUserQuestionAnswerItem[] = []
  for (const question of questions) {
    const item = await presentOneQuestion(chat, channel, pendingCards, question, abortController, logger)
    if (item === undefined) break
    answers.push(item)
  }
  if (answers.length === 0) {
    return { answers: [] }
  }
  return { answers }
}

/**
 * Render one question card and wait for its answer. Returns the single
 * `{ id, selected, custom }` answer item, or `undefined` when the card could
 * not be sent or the request is aborted (the caller stops the batch).
 */
async function presentOneQuestion(
  chat: ConversationMessage,
  channel: FeishuQuestionsChannel,
  pendingCards: Map<string, PendingCard>,
  question: AskUserQuestionItem,
  abortController: AbortController,
  logger?: PluginLogger,
): Promise<AskUserQuestionAnswerItem | undefined> {
  const pendingId = `feishu-q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const options = question.options ?? []
  const card = renderQuestionCard(question, options, pendingId)
  // The cardAction -> deferred bridge carries the whole `{ answers: [item] }`
  // settle value; extract the single item here so the batch loop can accumulate.
  const deferred = new Promise<AskUserQuestionAnswerItem | undefined>((resolve) => {
    const pending: PendingCard = {
      pendingId,
      question,
      sessionId: '',
      abortController,
      resolve: (answer) => resolve(answer?.answers?.[0]),
    }
    pendingCards.set(pendingId, pending)
  })
  try {
    console.log(`dsh-feishu: [q] sending card to chat=${chat.chatId} thread=${chat.threadId ?? '-'}`)
    const result = await channel.send(chat.chatId, { card }, chat.threadId !== undefined
      ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
      : {})
    const mid = (result as { messageId?: string })?.messageId
    console.log(`dsh-feishu: [q] card sent messageId=${mid ?? 'none'}`)
    const pending = pendingCards.get(pendingId)
    if (pending !== undefined && mid !== undefined) {
      pending.cardMessageId = mid
    }
  } catch (error: unknown) {
    console.log(`dsh-feishu: [q] card send failed: ${error instanceof Error ? error.message : String(error)}`)
    logger?.warn(`dsh-feishu: [q] card send failed: ${error instanceof Error ? error.message : String(error)}`)
    pendingCards.delete(pendingId)
    return undefined
  }
  return await deferred
}

/**
 * Build a settled question card — shows all options with the selected one
 * highlighted, buttons removed. Uses turquoise header to distinguish from
 * the original blue question card.
 */
function renderSettledQuestionCard(
  question: AskUserQuestionItem,
  selected: readonly string[],
): object {
  const options = question.options ?? []
  const selectedSet = new Set(selected)
  const mdParts: string[] = []
  if (question.header !== undefined && question.header !== '') {
    mdParts.push(`**${question.header}**`)
  }
  mdParts.push(question.question)
  mdParts.push('')
  if (options.length > 0) {
    // Check if the answer is a custom text (prefixed with ✏️) or skip (prefixed with ⏭️).
    const customAnswer = selected.find(s => s.startsWith('✏️ '))
    const skipped = selected.some(s => s.startsWith('⏭️ '))
    for (const option of options) {
      if (selectedSet.has(option.label)) {
        mdParts.push(`✅ **${option.label}** — *已选择*`)
      } else {
        mdParts.push(`⬜ ${option.label}`)
      }
    }
    if (customAnswer !== undefined) {
      mdParts.push(`\n✅ **自定义回答：** ${customAnswer.slice(3)}`)
    } else if (skipped) {
      mdParts.push(`\n⏭️ *已跳过*`)
    }
  } else {
    mdParts.push(`✅ **已选择：** ${selected.join(', ')}`)
  }
  // Use Card JSON 2.0 format (schema + body.elements) for the settled card.
  // This is necessary because im.v1.message.patch only supports v2 format.
  // The original question card uses old format (top-level elements) because
  // v2 does not support the 'action' tag (buttons).
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: question.header ?? 'Question' },
      template: 'turquoise',
    },
    body: {
      elements: [{ tag: 'markdown', content: mdParts.join('\n') }],
    },
  }
}

/**
 * Build a Feishu interactive-card payload for a single question. The schema
 * follows the v2 card template (`config/schema`): `header.title`, `body`
 * blocks (markdown + actions), `config`: { wide_screen_mode: true }.
 */
function renderQuestionCard(
  question: AskUserQuestionItem,
  options: readonly AskUserQuestionOption[],
  pendingId: string,
): object {
  const mdParts: string[] = []
  if (question.header !== undefined && question.header !== '') {
    mdParts.push(`**${question.header}**`)
  }
  mdParts.push(question.question)
  if (question.detail !== undefined && question.detail !== '') {
    mdParts.push(question.detail)
  }
  const body: object[] = [{ tag: 'markdown', content: mdParts.join('\n') }]
  const multiSelect = question.multiSelect === true
  // Option buttons go directly in body.elements (outside the form).
  // They trigger card action independently without form submission.
  // In Card JSON 2.0, buttons use behaviors instead of value.
  if (options.length > 0) {
    for (const option of options.slice(0, 6)) {
      body.push({
        tag: 'button',
        text: { tag: 'plain_text', content: option.label },
        type: multiSelect ? 'default' : 'primary',
        behaviors: [{ type: 'callback', value: { pendingId, questionId: question.id, selected: [option.label] } }],
      })
    }
  }
  // Custom input section: form container with input + submit button.
  // The form collects custom_text from the input when submit is clicked.
  // Form buttons use form_action_type + name instead of behaviors.
  body.push({ tag: 'hr' })
  const hint = options.length > 0
    ? '以上选项都不满意？在下方输入你的自定义回答：'
    : '请输入你的回答：'
  body.push({
    tag: 'form',
    name: `custom_form_${pendingId}`,
    elements: [
      { tag: 'markdown', content: hint },
      {
        tag: 'input',
        name: 'custom_text',
        placeholder: { tag: 'plain_text', content: '在此输入...' },
        max_length: 500,
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '✏️ 提交自定义回答' },
        type: 'primary',
        name: 'submit_custom',
        form_action_type: 'submit',
        behaviors: [{ type: 'callback', value: { pendingId, questionId: question.id, type: 'custom' } }],
      },
    ],
  })
  // Skip button at the bottom.
  body.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '⏭️ 跳过本题' },
    type: 'default',
    behaviors: [{ type: 'callback', value: { pendingId, questionId: question.id, selected: [], type: 'skip' } }],
  })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: question.header ?? 'Question' },
      template: options.length > 0 ? 'blue' : 'grey',
    },
    body: {
      elements: body,
    },
  }
}
