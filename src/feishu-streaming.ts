/**
 * Feishu UI bridge for streaming assistant messages: subscribes to the
 * apiproxy mux stream so the Feishu chat can render cards showing the
 * agent's text responses as they are generated (not just tool calls).
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

/** Channel adapter for sending cards. */
export interface FeishuStreamingChannel {
  send(to: string, input: { card: object }, opts?: { replyInThread?: boolean }): Promise<unknown>
}

/** Public deps for the streaming module. */
export interface FeishuStreamingDeps {
  apiProxy: ApiProxy
  channel: FeishuStreamingChannel
  bridgeHolder: BridgeHolder
  logger: PluginLogger
  /** Whether intermediate messages are enabled (checked dynamically). */
  enabled?: () => boolean
}

/** Per-session state for accumulating streaming text. */
interface SessionStreamState {
  /** Accumulated text from assistant/message events in the current turn. */
  text: string
  /** Debounce timer for sending intermediate updates. */
  debounceTimer: ReturnType<typeof setTimeout> | undefined
  /** Whether we already sent a card for this turn. */
  sentForTurn: boolean
}

/**
 * Subscribe to the apiproxy mux stream and render streaming assistant
 * message cards. Returns a disposer.
 */
export function startFeishuStreaming(deps: FeishuStreamingDeps): () => void {
  const { apiProxy, channel, bridgeHolder, logger, enabled } = deps
  const controller = new AbortController()
  const sessionStates = new Map<string, SessionStreamState>()

  const getState = (sessionId: string): SessionStreamState => {
    let state = sessionStates.get(sessionId)
    if (state === undefined) {
      state = { text: '', debounceTimer: undefined, sentForTurn: false }
      sessionStates.set(sessionId, state)
    }
    return state
  }

  const sendCard = (chat: ConversationMessage, sessionId: string, text: string): void => {
    if (text.trim() === '') return
    const card = renderStreamingCard(text)
    void channel.send(
      chat.chatId,
      { card },
      chat.threadId !== undefined ? { replyInThread: true } : {},
    ).then(() => {
      // Only mark intermediate sent AFTER the card is successfully delivered;
      // otherwise the final reply card would be wrongly skipped on send failure.
      bridgeHolder.current?.markIntermediateSent(sessionId)
    }).catch((error: unknown) => {
      logger.warn(`dsh-feishu: streaming card send failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // Diagnostic: log once when the stream starts so operators can confirm the
  // listener is alive. Also count received events to detect wiring issues.
  let totalReceived = 0
  let assistantReceived = 0

  const iterate = async (): Promise<void> => {
    logger.info('dsh-feishu: streaming listener started (mux subscription active)')
    try {
      for await (const envelope of apiProxy.events.mux(
        { rpcId: RpcId(`feishu-streaming-${Date.now()}`), payload: {} },
        controller.signal,
      )) {
        const frame = envelope.payload as MuxFrame
        if (frame.type !== 'session/event') continue
        totalReceived++
        if (enabled !== undefined && !enabled()) continue
        const event = frame.event
        if (event === undefined) continue
        const bridge = bridgeHolder.current
        if (bridge === undefined) continue
        const chat = bridge.resolveChat(frame.sessionId)
        if (chat === undefined) continue
        const state = getState(frame.sessionId)

        if (event.type === 'assistant/message') {
          assistantReceived++
          if (assistantReceived <= 3) {
            logger.info(`dsh-feishu: streaming got assistant/message #${assistantReceived} for session ${frame.sessionId}`)
          }
          const message = event.data?.message
          if (message === undefined || message === null) continue
          const content = message.content
          if (!Array.isArray(content)) continue
          const text = content
            .filter((block: { type: string; text?: string }) => block.type === 'text' && typeof block.text === 'string')
            .map((block: { type: string; text?: string }) => block.text ?? '')
            .join('')
          if (text === '') continue
          // Accumulate text for this turn
          state.text = text
          // Debounce: send after 1 second of no new messages
          if (state.debounceTimer !== undefined) clearTimeout(state.debounceTimer)
          const capturedSessionId = frame.sessionId
          state.debounceTimer = setTimeout(() => {
            state.debounceTimer = undefined
            if (state.text !== '' && !state.sentForTurn) {
              sendCard(chat, capturedSessionId, state.text)
              state.sentForTurn = true
            }
          }, 1000)
        } else if (event.type === 'turn/start') {
          // New turn starting — reset state
          if (state.debounceTimer !== undefined) {
            clearTimeout(state.debounceTimer)
            state.debounceTimer = undefined
          }
          state.text = ''
          state.sentForTurn = false
        } else if (event.type === 'turn/end') {
          // Turn ended — flush any remaining text
          if (state.debounceTimer !== undefined) {
            clearTimeout(state.debounceTimer)
            state.debounceTimer = undefined
          }
          if (state.text !== '' && !state.sentForTurn) {
            sendCard(chat, frame.sessionId, state.text)
          }
          state.text = ''
          state.sentForTurn = false
        }
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return
      logger.warn(`dsh-feishu: streaming message stream interrupted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  void iterate()

  return () => {
    controller.abort()
    for (const state of sessionStates.values()) {
      if (state.debounceTimer !== undefined) clearTimeout(state.debounceTimer)
    }
    sessionStates.clear()
  }
}

/**
 * Render a streaming assistant message as a Feishu card.
 * Shows the message text with a subtle "streaming" indicator.
 */
function renderStreamingCard(text: string): object {
  // Truncate very long messages to avoid hitting Feishu card size limits
  const displayText = text.length > 3000 ? text.slice(0, 3000) + '\n\n…(truncated)' : text
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '💬 Assistant (streaming)' },
      template: 'violet',
    },
    elements: [{ tag: 'markdown', content: displayText }],
  }
}
