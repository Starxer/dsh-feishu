/**
 * Feishu UI bridge for intermediate assistant messages: subscribes to the
 * apiproxy mux stream and shows the assistant's text responses that appear
 * between tool calls in a multi-step agent turn.
 *
 * In a multi-step turn the LLM may output text before each tool call (e.g.
 * "Let me search for that"). The WebUI shows these as separate message
 * bubbles. This module does the same for Feishu — it accumulates text-delta
 * chunks and flushes them as a card when a tool/call event arrives.
 *
 * This is NOT a streaming/text-delta renderer. It shows completed
 * intermediate messages at tool-call boundaries, regardless of the
 * /stream toggle.
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

/** Public deps for the intermediate-messages module. */
export interface FeishuStreamingDeps {
  apiProxy: ApiProxy
  channel: FeishuStreamingChannel
  bridgeHolder: BridgeHolder
  logger: PluginLogger
}

/** Per-session state for accumulating text before tool calls. */
interface SessionStreamState {
  /** Accumulated text from text-delta chunks in the current step. */
  text: string
}

/**
 * Subscribe to the apiproxy mux stream and render intermediate assistant
 * message cards in Feishu — the text the LLM outputs between tool calls.
 * Returns a disposer.
 */
export function startFeishuStreaming(deps: FeishuStreamingDeps): () => void {
  const { apiProxy, channel, bridgeHolder, logger } = deps
  console.log('dsh-feishu: startFeishuStreaming (intermediate messages mode)')
  const controller = new AbortController()
  const sessionStates = new Map<string, SessionStreamState>()

  const getState = (sessionId: string): SessionStreamState => {
    let state = sessionStates.get(sessionId)
    if (state === undefined) {
      state = { text: '' }
      sessionStates.set(sessionId, state)
    }
    return state
  }

  const sendIntermediateCard = (chat: ConversationMessage, sessionId: string, text: string): void => {
    if (text.trim() === '') return
    console.log(`dsh-feishu: sending intermediate card for session=${sessionId}, len=${text.length}`)
    const card = renderIntermediateCard(text)
    void channel.send(
      chat.chatId,
      { card },
      chat.threadId !== undefined ? { replyInThread: true } : {},
    ).catch((error: unknown) => {
      logger.warn(`dsh-feishu: intermediate card send failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const iterate = async (): Promise<void> => {
    try {
      for await (const envelope of apiProxy.events.mux(
        { rpcId: RpcId(`feishu-intermediate-${Date.now()}`), payload: {} },
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
          // Accumulate text-delta chunks for the current step.
          const chunk = event.data?.chunk
          if (chunk !== undefined && chunk !== null
            && chunk.type === 'text-delta'
            && typeof chunk.text === 'string') {
            state.text += chunk.text
          }
        } else if (event.type === 'tool/call') {
          // A tool call means the current step's text is done.
          // Flush accumulated text as an intermediate message.
          if (state.text.trim() !== '') {
            sendIntermediateCard(chat, sessionId, state.text)
          }
          state.text = ''
        } else if (event.type === 'turn/start') {
          // New turn — reset.
          state.text = ''
        } else if (event.type === 'turn/end') {
          // Turn ended — don't flush here; the channel's own final-reply
          // card handles the last step's text. Just reset.
          state.text = ''
        }
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return
      console.log(`dsh-feishu: intermediate messages mux error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  void iterate()

  return () => {
    controller.abort()
    sessionStates.clear()
  }
}

/**
 * Render an intermediate assistant message as a Feishu card.
 */
function renderIntermediateCard(text: string): object {
  const displayText = text.length > 3000 ? text.slice(0, 3000) + '\n\n…(truncated)' : text
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '💬 Assistant' },
      template: 'violet',
    },
    body: { elements: [{ tag: 'markdown', content: displayText }] },
  }
}
