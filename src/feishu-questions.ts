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

import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { ApiProxy, ClientResponse, MuxFrame, QuestionResponsePayload } from '@deepseek-ai/dsh-host-apiproxy'
import type { AskUserQuestionItem, AskUserQuestionOption } from '@deepseek-ai/dsh-user-questions/types'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
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
  rpcId: string
  question: AskUserQuestionItem
  sessionId: string
  abortController: AbortController
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
  /** Send a card to the chat. Resolves to `undefined` when no channel is
   *  connected (the listener drops the frame instead of awaiting forever). */
  send(to: string, input: { card: object }, opts?: { replyInThread?: boolean }): Promise<{ messageId?: string }>
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
}

/** Public surface the questions module reads. */
export interface FeishuQuestionsDeps {
  apiProxy: ApiProxy
  channel: FeishuQuestionsChannel
  bridgeHolder: BridgeHolder
  logger: PluginLogger
}

/**
 * Subscribe to the apiproxy mux stream and forward every `question/requested`
 * frame to the chat that owns the session. Returns a disposer that cancels
 * the SSE subscription; safe to call multiple times.
 *
 * @param deps Live references to the apiproxy, the Lark channel, and the
 *   current bridge. The bridge is read lazily because `runtime.reconcile()`
 *   replaces it; re-resolving on every question handles that case naturally.
 * @returns a disposer that closes the SSE stream and detaches the cardAction listener.
 */
export function startFeishuQuestions(deps: FeishuQuestionsDeps): () => void {
  const { apiProxy, channel, bridgeHolder, logger } = deps
  const controller = new AbortController()
  const pendingCards = new Map<string, PendingCard>()

  const respondForQuestion = async (
    rpcId: string,
    sessionId: string,
    question: AskUserQuestionItem,
    selected: readonly string[],
    custom: string | undefined,
  ): Promise<void> => {
    const payload: QuestionResponsePayload = {
      sessionId: sessionId as never,
      answer: {
        answers: [{
          id: question.id,
          selected: [...selected],
          ...custom === undefined ? {} : { custom },
        }],
      },
    }
    const response: ClientResponse = {
      type: 'client-response',
      rpcId: RpcId(rpcId),
      result: { ok: true, value: payload },
    }
    try {
      const receipt = await apiProxy.respond(response)
      if (!receipt.accepted) {
        logger.warn(`dsh-feishu: question response rejected by apiproxy: ${receipt.reason}`)
      }
    } catch (error: unknown) {
      logger.warn(`dsh-feishu: failed to deliver question answer to apiproxy: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // The Feishu card action payload the Feishu interactive-card callback sends
  // includes the button's `value` JSON verbatim. We pack the rpcId + question
  // id + chosen label into that value so a single click fully resolves the
  // question without a follow-up message roundtrip.
  const onCardAction = async (evt: CardActionLike): Promise<void> => {
    const action = evt.action
    let raw = action?.value
    if (typeof raw !== 'string') return
    let parsed: { rpcId?: unknown; questionId?: unknown; selected?: unknown; custom?: unknown }
    try {
      let result = JSON.parse(raw)
      // Feishu may double-encode the value (JSON string containing JSON)
      if (typeof result === 'string') result = JSON.parse(result)
      parsed = result as typeof parsed
    } catch {
      return
    }
    const rpcId = typeof parsed.rpcId === 'string' ? parsed.rpcId : ''
    const questionId = typeof parsed.questionId === 'string' ? parsed.questionId : ''
    const selected = Array.isArray(parsed.selected)
      ? parsed.selected.filter((item: unknown): item is string => typeof item === 'string')
      : action?.option !== undefined ? [action.option] : []
    const custom = typeof parsed.custom === 'string' && parsed.custom !== '' ? parsed.custom : undefined
    if (rpcId === '' || questionId === '') return
    const pending = pendingCards.get(rpcId)
    if (pending === undefined) return
    pendingCards.delete(rpcId)
    // Update the card to show the selected option and remove interactive elements.
    if (pending.cardMessageId !== undefined) {
      const selectedLabels = selected.length > 0 ? selected : (action?.option !== undefined ? [action.option] : [])
      const settledCard = renderSettledQuestionCard(pending.question, selectedLabels)
      await channel.updateCard(pending.cardMessageId, settledCard).catch(() => undefined)
    }
    if (selected.length === 0 && custom === undefined) return
    await respondForQuestion(rpcId, pending.sessionId, pending.question, selected, custom)
  }
  const unsubscribeCardAction = channel.onCardAction(onCardAction)

  const iterate = async (): Promise<void> => {
    try {
      // The mux iterator never resolves on its own — it stays open until the
      // signal aborts. We tear it down via `controller.abort()` when the
      // caller disposes the listener or the bridge is replaced.
      for await (const envelope of apiProxy.events.mux(
        { rpcId: RpcId(`feishu-${Date.now()}`), payload: {} },
        controller.signal,
      )) {
        const frame = envelope.payload as MuxFrame
        if (frame.type !== 'question/requested') continue
        const bridge = bridgeHolder.current
        if (bridge === undefined) continue
        const chat = bridge.resolveChat(frame.sessionId)
        if (chat === undefined) continue
        await presentQuestions(chat, channel, pendingCards, envelope.rpcId, frame.sessionId, frame.questions)
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return
      logger.warn(`dsh-feishu: question stream interrupted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  void iterate()

  return () => {
    controller.abort()
    unsubscribeCardAction()
    for (const pending of pendingCards.values()) pending.abortController.abort()
    pendingCards.clear()
  }
}

/**
 * Render each question as its own card (one card per question, single question
 * per `ask_user_question` call by default). The card has the question text,
 * the optional detail block, and a row of buttons — one per option. Multi-
 * select prompts ask for a single "Confirm" press after multiple selections.
 */
async function presentQuestions(
  chat: ConversationMessage,
  channel: FeishuQuestionsChannel,
  pendingCards: Map<string, PendingCard>,
  rpcId: string,
  sessionId: string,
  questions: readonly AskUserQuestionItem[],
): Promise<void> {
  for (const question of questions) {
    const options = question.options ?? []
    const card = renderQuestionCard(question, options, rpcId, sessionId)
    try {
      const result = await channel.send(chat.chatId, { card }, chat.threadId !== undefined ? { replyInThread: true } : {})
      const mid = (result as { messageId?: string })?.messageId
      pendingCards.set(rpcId, {
        rpcId,
        sessionId,
        question,
        abortController: new AbortController(),
        ...(mid !== undefined ? { cardMessageId: mid } : {}),
      })
    } catch (error: unknown) {
      // Sending failed; abandon the prompt so the agent isn't blocked on a
      // user who never sees the question.
      return
    }
  }
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
    for (const option of options) {
      if (selectedSet.has(option.label)) {
        mdParts.push(`✅ ~~${option.label}~~ — *已选择*`)
      } else {
        mdParts.push(`⬜ ${option.label}`)
      }
    }
  } else {
    mdParts.push(`✅ **已选择：** ${selected.join(', ')}`)
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: question.header ?? 'Question' },
      template: 'turquoise',
    },
    body: { elements: [{ tag: 'markdown', content: mdParts.join('\n') }] },
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
  rpcId: string,
  _sessionId: string,
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
  const elements: object[] = []
  if (options.length > 0) {
    const buttons = options.slice(0, 6).map((option) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: option.label },
      type: multiSelect ? 'default' : 'primary',
      value: JSON.stringify({
        rpcId,
        questionId: question.id,
        selected: [option.label],
      }),
    }))
    elements.push({ tag: 'action', actions: buttons })
  }
  body.push(...elements)
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: question.header ?? 'Question' },
      template: options.length > 0 ? 'blue' : 'grey',
    },
    elements: body,
  }
}
