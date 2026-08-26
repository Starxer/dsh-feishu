/**
 * Feishu UI bridge for per-step assistant cards: subscribes to the apiproxy
 * mux stream and renders ONE card per agent step, containing reasoning, text,
 * tool calls, and tool results.
 *
 * Architecture: one mux subscriber handles all event types for a unified
 * per-step card. No race conditions between separate subscribers.
 *
 * Event flow per step:
 *   assistant/chunk (reasoning-delta, text-delta)  → accumulate
 *   assistant/message                              → send card with reasoning + text
 *   tool/call                                      → update card: append tool info
 *   tool/result                                    → update card: append tool result
 *
 * @module @starxer/dsh-feishu/feishu-streaming
 */

import type { ApiProxy, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { HarnessConversationService } from './harness.ts'
import type { ConversationMessage } from './conversation.ts'

/** Minimal logger surface. */
interface PluginLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** Source of the current bridge. */
interface BridgeHolder {
  current: HarnessConversationService | undefined
}

/** Channel adapter for sending and updating cards. */
export interface FeishuStreamingChannel {
  send(to: string, input: { card: object }, opts?: { replyInThread?: boolean }): Promise<{ messageId?: string }>
  updateCard(messageId: string, card: object): Promise<void>
}

/** Public deps for the unified per-step module. */
export interface FeishuStreamingDeps {
  apiProxy: ApiProxy
  channel: FeishuStreamingChannel
  bridgeHolder: BridgeHolder
  logger: PluginLogger
  /** Whether to show reasoning content. */
  showReasoning?: () => boolean
}

/** One tool call tracked within a step. */
interface StepToolCall {
  toolName: string
  callId: string
  arguments?: unknown
  startedAt: number
  /** Set when tool/result arrives. */
  result?: { isError: boolean; content: string; elapsed: number }
}

/** Per-session state for accumulating a step's content. */
interface SessionStepState {
  /** Accumulated reasoning from reasoning-delta chunks. */
  reasoning: string
  /** Accumulated text from text-delta chunks. */
  text: string
  /** Tool calls in the current step (ordered). */
  toolCalls: StepToolCall[]
  /** Whether a step card has been sent for the current step. */
  stepCardSent: boolean
  /** Message ID of the sent step card (for in-place updates). */
  stepCardMessageId: Promise<string | undefined> | undefined
  /** Chat info for the current step. */
  chat: ConversationMessage | undefined
  /** Whether the last assistant/message sent a step card with content. */
  lastStepHadContent: boolean
}

/**
 * Subscribe to the apiproxy mux stream and render per-step assistant cards
 * in Feishu — one card per step containing reasoning, text, and tool calls.
 *
 * Returns a disposer, consumeReasoning, and consumeLastStepHadContent.
 */
export function startFeishuStreaming(deps: FeishuStreamingDeps): {
  stop: () => void
  consumeReasoning: (sessionId: string) => string | undefined
  consumeLastStepHadContent: (sessionId: string) => boolean
} {
  const { apiProxy, channel, bridgeHolder, logger, showReasoning } = deps
  console.log('dsh-feishu: startFeishuStreaming (unified per-step cards)')
  const controller = new AbortController()
  const sessionStates = new Map<string, SessionStepState>()

  const getState = (sessionId: string): SessionStepState => {
    let state = sessionStates.get(sessionId)
    if (state === undefined) {
      state = {
        reasoning: '',
        text: '',
        toolCalls: [],
        stepCardSent: false,
        stepCardMessageId: undefined,
        chat: undefined,
        lastStepHadContent: false,
      }
      sessionStates.set(sessionId, state)
    }
    return state
  }

  const resetStep = (state: SessionStepState): void => {
    state.reasoning = ''
    state.text = ''
    state.toolCalls = []
    state.stepCardSent = false
    state.stepCardMessageId = undefined
    state.chat = undefined
  }

  /** Build the unified card content for the current step state. */
  const buildStepCard = (state: SessionStepState): object => {
    const showR = showReasoning?.() !== false && state.reasoning.trim() !== ''
    const reasoning = showR ? state.reasoning.trim() : undefined
    const text = state.text.trim() !== '' ? state.text.trim() : undefined
    const tools = state.toolCalls

    return renderStepCard(reasoning, text, tools)
  }

  /** Send the initial step card and track its messageId. */
  const sendStepCard = (chat: ConversationMessage, sessionId: string, state: SessionStepState): void => {
    const card = buildStepCard(state)
    state.stepCardSent = true
    state.chat = chat
    state.stepCardMessageId = channel.send(
      chat.chatId,
      { card },
      chat.threadId !== undefined ? { replyInThread: true } : {},
    ).then((result) => result?.messageId).catch((error: unknown) => {
      logger.warn(`dsh-feishu: step card send failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })
  }

  /** Update the existing step card with current state. */
  const updateStepCard = (state: SessionStepState): void => {
    if (!state.stepCardSent || state.stepCardMessageId === undefined) return
    const card = buildStepCard(state)
    void state.stepCardMessageId.then((messageId) => {
      if (messageId !== undefined) {
        return channel.updateCard(messageId, card)
      }
    }).catch((error: unknown) => {
      logger.warn(`dsh-feishu: step card update failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const iterate = async (): Promise<void> => {
    try {
      for await (const envelope of apiProxy.events.mux(
        { rpcId: RpcId(`feishu-streaming-${Date.now()}`), payload: {} },
        controller.signal,
      )) {
        const frame = envelope.payload as MuxFrame
        if (frame.type !== 'session/event') continue

        const event = frame.event
        if (event === undefined) continue
        const sessionId = frame.sessionId
        const bridge = bridgeHolder.current
        if (bridge === undefined) continue
        const chat = bridge.resolveChat(sessionId)
        if (chat === undefined) continue

        const state = getState(sessionId)

        if (event.type === 'assistant/chunk') {
          // Accumulate reasoning-delta and text-delta chunks.
          const chunk = event.data?.chunk
          if (chunk !== undefined && chunk !== null) {
            if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
              state.reasoning += chunk.text
            } else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              state.text += chunk.text
            }
          }
        } else if (event.type === 'assistant/message') {
          // The assembled message arrived. If there's reasoning or text,
          // send the step card now (before tool calls).
          const hasContent = state.reasoning.trim() !== '' || state.text.trim() !== ''
          if (hasContent) {
            sendStepCard(chat, sessionId, state)
          }
          state.lastStepHadContent = hasContent
        } else if (event.type === 'tool/call') {
          const toolCallId = String(event.data?.callId ?? '')
          const toolName = (event.data?.name as string) ?? 'unknown'
          const args = event.data?.arguments

          const toolCall: StepToolCall = {
            toolName,
            callId: toolCallId,
            arguments: args,
            startedAt: Date.now(),
          }
          state.toolCalls.push(toolCall)

          if (state.stepCardSent) {
            // Update existing card to append tool info
            updateStepCard(state)
          } else {
            // No step card yet (no reasoning/text) — send one now with just tool info
            sendStepCard(chat, sessionId, state)
          }
        } else if (event.type === 'tool/result') {
          const toolCallId = String(event.data?.message?.source?.callId ?? '')
          const toolCall = state.toolCalls.find(t => t.callId === toolCallId)

          if (toolCall !== undefined) {
            const isError = event.data?.error !== undefined || event.data?.message?.content?.[0]?.isError === true
            const resultContent = event.data?.message?.content
            const result = Array.isArray(resultContent)
              ? resultContent.map((b: { type: string; text?: string }) => b.type === 'text' ? b.text ?? '' : '').filter(Boolean).join('\n')
              : resultContent
            const elapsed = Date.now() - toolCall.startedAt

            toolCall.result = {
              isError,
              content: summarizeValue(result, 300) || '',
              elapsed,
            }

            // Update the card with tool result
            if (state.stepCardSent) {
              updateStepCard(state)
            }
          }
        } else if (event.type === 'step/start') {
          // New step starting — reset for the new step.
          resetStep(state)
        } else if (event.type === 'turn/start') {
          // New turn — reset step state. Don't reset lastStepHadContent here;
          // it's consumed by channel.ts after bridge.reply() returns.
          resetStep(state)
        } else if (event.type === 'turn/end') {
          // Turn ended — reset.
          resetStep(state)
        }
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return
      console.log(`dsh-feishu: streaming mux error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  void iterate()

  /** Consume accumulated reasoning for a session (used by channel.ts for the final reply card). */
  const consumeReasoning = (sessionId: string): string | undefined => {
    const state = sessionStates.get(sessionId)
    if (state === undefined || state.reasoning.trim() === '') return undefined
    const reasoning = state.reasoning.trim()
    state.reasoning = ''
    return reasoning
  }

  /** Check and consume whether the last step sent a card with content. */
  const consumeLastStepHadContent = (sessionId: string): boolean => {
    const state = sessionStates.get(sessionId)
    if (state === undefined) return false
    const had = state.lastStepHadContent
    state.lastStepHadContent = false
    return had
  }

  return {
    stop: () => {
      controller.abort()
      sessionStates.clear()
    },
    consumeReasoning,
    consumeLastStepHadContent,
  }
}

/**
 * Truncate a value to a readable summary for card display.
 */
function summarizeValue(value: unknown, maxLen: number = 200): string {
  if (value === undefined || value === null) return ''
  const str = typeof value === 'string' ? value : JSON.stringify(value)
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '…'
}

/**
 * Render a unified per-step card with reasoning, text, and tool calls.
 */
function renderStepCard(
  reasoning: string | undefined,
  text: string | undefined,
  tools: StepToolCall[],
): object {
  const elements: object[] = []

  // Reasoning section
  if (reasoning !== undefined && reasoning !== '') {
    const displayReasoning = reasoning.length > 3000 ? reasoning.slice(0, 3000) + '\n…(truncated)' : reasoning
    elements.push({
      tag: 'markdown',
      content: `🧠 **Reasoning**\n\`\`\`\n${displayReasoning}\n\`\`\``,
    })
  }

  // Text section
  if (text !== undefined && text !== '') {
    const displayText = text.length > 3000 ? text.slice(0, 3000) + '\n…(truncated)' : text
    if (elements.length > 0) elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: displayText })
  }

  // Tool calls section
  if (tools.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' })
    for (const tool of tools) {
      const toolLines: string[] = []
      if (tool.result !== undefined) {
        const icon = tool.result.isError ? '❌' : '✅'
        toolLines.push(`${icon} **\`${tool.toolName}\`** — ${tool.result.elapsed >= 1000 ? `${(tool.result.elapsed / 1000).toFixed(1)}s` : `${tool.result.elapsed}ms`}`)
      } else {
        toolLines.push(`⏳ **\`${tool.toolName}\`** — running…`)
      }
      const argsSummary = summarizeValue(tool.arguments, 200)
      if (argsSummary !== '') toolLines.push(`> args: \`${argsSummary}\``)
      if (tool.result !== undefined && tool.result.content !== '') {
        toolLines.push(`> ${tool.result.content}`)
      }
      elements.push({ tag: 'markdown', content: toolLines.join('\n') })
    }
  }

  // Fallback
  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: '*(empty)*' })
  }

  // Card title and color
  const hasReasoning = reasoning !== undefined && reasoning !== ''
  const hasText = text !== undefined && text !== ''
  const hasTools = tools.length > 0

  let title: string
  let template: string
  if (hasTools && (hasReasoning || hasText)) {
    title = 'Thinking → Tools'
    template = 'violet'
  } else if (hasTools) {
    title = 'Tool Call'
    template = 'wathet'
  } else if (hasReasoning) {
    title = 'Thinking'
    template = 'violet'
  } else {
    title = 'Response'
    template = 'blue'
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template,
    },
    body: { elements },
  }
}
