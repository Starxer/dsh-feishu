/**
 * Feishu UI bridge for tool call visualization: subscribes to the apiproxy
 * mux stream so the Feishu chat can render cards showing tool invocations
 * and their results as they happen.
 *
 * @module @starxer/dsh-feishu/feishu-toolcalls
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
export interface FeishuToolCallsChannel {
  send(to: string, input: { card: object }, opts?: { replyInThread?: boolean }): Promise<unknown>
}

/** Public deps for the tool-calls module. */
export interface FeishuToolCallsDeps {
  apiProxy: ApiProxy
  channel: FeishuToolCallsChannel
  bridgeHolder: BridgeHolder
  logger: PluginLogger
}

/** Per-session state for batching tool calls. */
interface SessionToolState {
  /** Pending tool call cards keyed by toolCallId. */
  pending: Map<string, PendingToolCall>
  /** Debounce timer for sending batched updates. */
  batchTimer: ReturnType<typeof setTimeout> | undefined
  /** Queued cards to send. */
  batchQueue: Array<{ chat: ConversationMessage; card: object }>
}

interface PendingToolCall {
  toolName: string
  toolCallId: string
  arguments?: unknown
  startedAt: number
}

/**
 * Subscribe to the apiproxy mux stream and render tool call/result cards.
 * Returns a disposer.
 */
export function startFeishuToolCalls(deps: FeishuToolCallsDeps): () => void {
  const { apiProxy, channel, bridgeHolder, logger } = deps
  const controller = new AbortController()
  const sessionStates = new Map<string, SessionToolState>()

  const getState = (sessionId: string): SessionToolState => {
    let state = sessionStates.get(sessionId)
    if (state === undefined) {
      state = { pending: new Map(), batchTimer: undefined, batchQueue: [] }
      sessionStates.set(sessionId, state)
    }
    return state
  }

  const flushBatch = (state: SessionToolState): void => {
    if (state.batchTimer !== undefined) {
      clearTimeout(state.batchTimer)
      state.batchTimer = undefined
    }
    const queue = state.batchQueue.splice(0)
    for (const item of queue) {
      void channel.send(
        item.chat.chatId,
        { card: item.card },
        item.chat.threadId !== undefined ? { replyInThread: true } : {},
      ).catch((error: unknown) => {
        logger.warn(`dsh-feishu: tool-call card send failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  const scheduleBatch = (state: SessionToolState, chat: ConversationMessage, card: object): void => {
    state.batchQueue.push({ chat, card })
    if (state.batchTimer === undefined) {
      state.batchTimer = setTimeout(() => flushBatch(state), 200)
    }
  }

  const iterate = async (): Promise<void> => {
    try {
      for await (const envelope of apiProxy.events.mux(
        { rpcId: RpcId(`feishu-toolcalls-${Date.now()}`), payload: {} },
        controller.signal,
      )) {
        const frame = envelope.payload as MuxFrame
        if (frame.type !== 'session/event') continue
        const event = frame.event
        if (event === undefined) continue
        const bridge = bridgeHolder.current
        if (bridge === undefined) continue
        const chat = bridge.resolveChat(frame.sessionId)
        if (chat === undefined) continue
        const state = getState(frame.sessionId)

        if (event.type === 'tool/call') {
          const toolCallId = String(event.data?.callId ?? '')
          const toolName = (event.data?.name as string) ?? 'unknown'
          const args = event.data?.arguments
          state.pending.set(toolCallId, { toolName, toolCallId, arguments: args, startedAt: Date.now() })
          const card = renderToolCallCard(toolName, args)
          scheduleBatch(state, chat, card)
        } else if (event.type === 'tool/result') {
          const toolCallId = String(event.data?.message?.source?.callId ?? '')
          const pending = state.pending.get(toolCallId)
          state.pending.delete(toolCallId)
          const toolName = pending?.toolName ?? 'unknown'
          const isError = event.data?.error !== undefined || event.data?.message?.content?.[0]?.isError === true
          const resultContent = event.data?.message?.content
          const result = Array.isArray(resultContent)
            ? resultContent.map((b: { type: string; text?: string }) => b.type === 'text' ? b.text ?? '' : '').filter(Boolean).join('\n')
            : resultContent
          const elapsed = pending !== undefined ? Date.now() - pending.startedAt : undefined
          const card = renderToolResultCard(toolName, isError, result, elapsed)
          scheduleBatch(state, chat, card)
        }
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return
      logger.warn(`dsh-feishu: tool-call stream interrupted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  void iterate()

  return () => {
    controller.abort()
    for (const state of sessionStates.values()) {
      if (state.batchTimer !== undefined) clearTimeout(state.batchTimer)
    }
    sessionStates.clear()
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
 * Render a tool-call card showing the tool name and arguments.
 */
function renderToolCallCard(toolName: string, args: unknown): object {
  const body: object[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `**Tool:** \`${toolName}\`` },
    },
  ]
  const argsSummary = summarizeValue(args, 300)
  if (argsSummary !== '') {
    body.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**Args:**\n\`\`\`\n${argsSummary}\n\`\`\`` },
    })
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔧 Tool Call' },
      template: 'wathet',
    },
    elements: body,
  }
}

/**
 * Render a tool-result card showing the result or error.
 */
function renderToolResultCard(toolName: string, isError: boolean, result: unknown, elapsed: number | undefined): object {
  const body: object[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `**Tool:** \`${toolName}\`` },
    },
  ]
  if (elapsed !== undefined) {
    body.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**Time:** ${elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`}` },
    })
  }
  const resultSummary = summarizeValue(result, 300)
  if (resultSummary !== '') {
    body.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**Result:**\n\`\`\`\n${resultSummary}\n\`\`\`` },
    })
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: isError ? '❌ Tool Error' : '✅ Tool Done' },
      template: isError ? 'red' : 'green',
    },
    elements: body,
  }
}
