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

/** Per-step usage from assistant/message event. */
interface StepUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number | undefined
  cacheWriteTokens?: number | undefined
}

/** Aggregated turn stats for the Turn Complete card. */
export interface TurnStats {
  turnStartTime: number
  stepCount: number
  toolCallCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  firstStepTtftMs: number | null
  /** Sum of (firstToken → message) across steps — pure LLM decode time for throughput. */
  totalDecodeMs: number
  /** Sum of (stepStart → completed) across steps — includes tool execution. */
  totalStepMs: number
  /** Sum of tool elapsed times. */
  totalToolMs: number
}

/** One tool call tracked within a step. */
interface StepToolCall {
  toolName: string
  callId: string
  arguments?: unknown
  startedAt: number
  /** Set when tool/result arrives. */
  result?: { isError: boolean; content: string; elapsed: number }
  /** Tool presentation view from the mux frame (presentCall/presentResult). */
  callView?: { card?: string; title?: string; description?: string; workdir?: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resultView?: any
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
  // --- Timing fields (event.time from mux stream) ---
  stepStartTime: number
  firstTokenTime: number
  /** Time of assistant/message event (LLM inference complete). */
  messageTime: number
  /** Time of last tool/result or assistant/message (step fully complete). */
  completedTime: number
  usage: StepUsage | undefined
  // --- Turn-level aggregation ---
  turnStats: TurnStats | undefined
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
  flushed: (sessionId: string) => Promise<TurnStats | undefined>
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
        stepStartTime: 0,
        firstTokenTime: 0,
        messageTime: 0,
        completedTime: 0,
        usage: undefined,
        turnStats: undefined,
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
    state.stepStartTime = 0
    state.firstTokenTime = 0
    state.messageTime = 0
    state.completedTime = 0
    state.usage = undefined
  }

  /** Build the unified card content for the current step state. */
  const buildStepCard = (state: SessionStepState): object => {
    const showR = showReasoning?.() !== false && state.reasoning.trim() !== ''
    const reasoning = showR ? state.reasoning.trim() : undefined
    const text = state.text.trim() !== '' ? state.text.trim() : undefined
    const tools = state.toolCalls

    // Use real-time elapsed duration so the card always shows accurate time,
    // even while tools are still running.
    const stepDurationMs = state.stepStartTime > 0
      ? Date.now() - state.stepStartTime
      : undefined

    return renderStepCard(reasoning, text, tools, state.usage, stepDurationMs)
  }

  /** Send the initial step card and track its messageId. */
  const sendStepCard = (chat: ConversationMessage, sessionId: string, state: SessionStepState): void => {
    const card = buildStepCard(state)
    state.stepCardSent = true
    state.chat = chat
    // Mark this session as having sent intermediate content so channel.ts
    // can skip the duplicate reply card and only send the footer.
    const hasText = state.text.trim() !== ''
    if (hasText) {
      bridgeHolder.current?.markIntermediateSent(sessionId)
    }
    state.stepCardMessageId = channel.send(
      chat.chatId,
      { card },
      chat.threadId !== undefined ? { replyInThread: true } : {},
    ).then((result) => {
      console.log(`dsh-feishu: [send] step card sent, messageId=${result?.messageId}`)
      return result?.messageId
    }).catch((error: unknown) => {
      console.log(`dsh-feishu: [send] step card send failed: ${error instanceof Error ? error.message : String(error)}`)
      logger.warn(`dsh-feishu: step card send failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })
  }

  /**
   * Pending debounce entries keyed by session state.  Each entry stores the
   * timer handle AND the captured messageIdPromise + card so that both the
   * normal timer callback and a premature flush (turn/end) use the exact same
   * data — the card captured at schedule time, not rebuilt from state that may
   * have been cleared by resetStep.
   */
  const pendingUpdates = new Map<SessionStepState, {
    timer: ReturnType<typeof setTimeout>
    messageIdPromise: Promise<string | undefined>
    card: object
  }>()

  /** Flush promises: resolved by turn/end after the final card update. */
  const flushPromises = new Map<string, { promise: Promise<void>; resolve: () => void }>()

  /** Turn stats per session, stored independently of flush promise timing. */
  const turnStatsMap = new Map<string, TurnStats>()

  /** Execute a card update (shared by debounce timer and flush). */
  const executeCardUpdate = (
    messageIdPromise: Promise<string | undefined>,
    card: object,
  ): Promise<void> => {
    return messageIdPromise.then((messageId) => {
      if (messageId !== undefined) {
        console.log(`dsh-feishu: [update] updating card ${messageId}`)
        return channel.updateCard(messageId, card)
      }
      console.log('dsh-feishu: [update] messageId is undefined, skipping')
    }).catch((error: unknown) => {
      console.log(`dsh-feishu: [update] failed: ${error instanceof Error ? error.message : String(error)}`)
      logger.warn(`dsh-feishu: step card update failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Flush the pending debounce timer for a state, executing the updateCard immediately. */
  const flushPendingUpdate = (state: SessionStepState): Promise<void> => {
    const entry = pendingUpdates.get(state)
    if (entry !== undefined) {
      clearTimeout(entry.timer)
      pendingUpdates.delete(state)
      return executeCardUpdate(entry.messageIdPromise, entry.card)
    }
    return Promise.resolve()
  }

  /** Update the existing step card with current state (debounced). */
  const updateStepCard = (state: SessionStepState): void => {
    if (!state.stepCardSent || state.stepCardMessageId === undefined) return
    // Capture BOTH messageId and card NOW — resetStep may clear state before the timer fires
    const messageIdPromise = state.stepCardMessageId
    const card = buildStepCard(state)
    // Clear previous pending update
    const existing = pendingUpdates.get(state)
    if (existing !== undefined) clearTimeout(existing.timer)
    // Debounce: merge rapid updates into one (150ms threshold)
    pendingUpdates.set(state, {
      messageIdPromise,
      card,
      timer: setTimeout(() => {
        pendingUpdates.delete(state)
        executeCardUpdate(messageIdPromise, card).catch((error: unknown) => {
          console.log(`dsh-feishu: [update] timer callback error: ${error instanceof Error ? error.message : String(error)}`)
        })
      }, 150),
    })
  }

  const iterate = async (): Promise<void> => {
    try {
      for await (const envelope of apiProxy.events.mux(
        { rpcId: RpcId(`feishu-streaming-${Date.now()}`), payload: {} },
        controller.signal,
      )) {
        try {
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
              // Record first token time (TTFT anchor).
              if (state.firstTokenTime === 0) {
                state.firstTokenTime = event.time ?? Date.now()
              }
            }
          }
        } else if (event.type === 'assistant/message') {
          // The assembled message arrived. Record usage and message time.
          state.messageTime = event.time ?? Date.now()
          state.completedTime = state.messageTime  // Will be overwritten by tool/result if tools run
          const usage = event.data?.usage
          if (usage !== undefined && usage !== null) {
            state.usage = {
              inputTokens: (usage.inputTokens as number) ?? 0,
              outputTokens: (usage.outputTokens as number) ?? 0,
              cacheReadTokens: (usage.cacheReadTokens as number | undefined),
              cacheWriteTokens: (usage.cacheWriteTokens as number | undefined),
            }
          }

          // Accumulate turn stats.
          if (state.turnStats !== undefined) {
            const ts = state.turnStats
            ts.stepCount++
            ts.toolCallCount += state.toolCalls.length
            if (state.usage !== undefined) {
              ts.totalInputTokens += state.usage.inputTokens
              ts.totalOutputTokens += state.usage.outputTokens
              ts.totalCacheReadTokens += state.usage.cacheReadTokens ?? 0
              ts.totalCacheWriteTokens += state.usage.cacheWriteTokens ?? 0
            }
            // TTFT: only record from the first step that has one.
            if (ts.firstStepTtftMs === null && state.firstTokenTime > 0 && state.stepStartTime > 0) {
              ts.firstStepTtftMs = state.firstTokenTime - state.stepStartTime
            }
            // Decode time: first token → assistant/message (pure LLM output time, for throughput).
            if (state.firstTokenTime > 0 && state.messageTime > state.firstTokenTime) {
              ts.totalDecodeMs += state.messageTime - state.firstTokenTime
            }
            // Step time: step start → completed (includes tool execution).
            if (state.stepStartTime > 0 && state.completedTime > state.stepStartTime) {
              ts.totalStepMs += state.completedTime - state.stepStartTime
            }
            // Tool time: sum of tool elapsed.
            for (const tc of state.toolCalls) {
              if (tc.result !== undefined) ts.totalToolMs += tc.result.elapsed
            }
          }

          // If there's reasoning or text, send the step card now (before tool calls).
          const hasContent = state.reasoning.trim() !== '' || state.text.trim() !== ''
          if (hasContent) {
            sendStepCard(chat, sessionId, state)
          }
          state.lastStepHadContent = hasContent
        } else if (event.type === 'tool/call') {
          const toolCallId = String(event.data?.callId ?? '')
          const toolName = (event.data?.name as string) ?? 'unknown'
          const args = event.data?.arguments
          console.log(`dsh-feishu: [call] tool=${toolName} callId=${toolCallId} stepCardSent=${state.stepCardSent}`)

          const toolCall: StepToolCall = {
            toolName,
            callId: toolCallId,
            arguments: args,
            startedAt: Date.now(),
          }
          // Read tool presentation view from mux frame
          if (frame.view?.for === 'call' && frame.view.view !== undefined) {
            toolCall.callView = frame.view.view as NonNullable<StepToolCall['callView']>
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
          console.log(`dsh-feishu: [result] callId=${toolCallId} found=${toolCall !== undefined} toolsInState=${state.toolCalls.length} stepCardSent=${state.stepCardSent}`)

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
            // Read tool presentation view from mux frame
            if (frame.view?.for === 'result' && frame.view.view !== undefined) {
              toolCall.resultView = frame.view.view as NonNullable<StepToolCall['resultView']>
            }

            // Update the card with tool result
            if (state.stepCardSent) {
              updateStepCard(state)
            }
            // Update completedTime so step duration includes tool execution.
            state.completedTime = event.time ?? Date.now()
          }
        } else if (event.type === 'step/start') {
          // New step starting — reset for the new step and record start time.
          resetStep(state)
          state.stepStartTime = event.time ?? Date.now()
        } else if (event.type === 'turn/start') {
          // New turn — reset step state and create flush entry for this turn.
          // Don't reset lastStepHadContent here;
          // it's consumed by channel.ts after bridge.reply() returns.
          resetStep(state)
          state.turnStats = {
            turnStartTime: event.time ?? Date.now(),
            stepCount: 0,
            toolCallCount: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
            firstStepTtftMs: null,
            totalDecodeMs: 0,
            totalStepMs: 0,
            totalToolMs: 0,
          }
          // Create the flush entry now so channel.ts's flushed() call can find it
          // even if bridge.reply() resolves before turn/end fires.
          let resolve!: () => void
          const promise = new Promise<void>((r) => { resolve = r })
          flushPromises.set(sessionId, { promise, resolve })
        } else if (event.type === 'turn/end') {
          // Flush any pending debounced updateCard before resetting, so the
          // final card content is committed before channel.ts sends the footer.
          const turnStats = state.turnStats
          // Compute final turn duration.
          if (turnStats !== undefined) {
            const now = event.time ?? Date.now()
            turnStats.totalStepMs = now - turnStats.turnStartTime
            turnStatsMap.set(sessionId, turnStats)
          }
          flushPendingUpdate(state).then(() => {
            const entry = flushPromises.get(sessionId)
            if (entry !== undefined) {
              entry.resolve()
              flushPromises.delete(sessionId)
            }
          }).catch((error: unknown) => {
            console.log(`dsh-feishu: turn/end flush error: ${error instanceof Error ? error.message : String(error)}`)
            const entry = flushPromises.get(sessionId)
            if (entry !== undefined) {
              entry.resolve()
              flushPromises.delete(sessionId)
            }
          })
          resetStep(state)
        }
        } catch (eventError: unknown) {
          // Log per-event errors but keep the mux loop alive.
          console.log(`dsh-feishu: streaming event handler error: ${eventError instanceof Error ? eventError.message : String(eventError)}`)
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

  /** Wait for the final step card update to complete before sending footer. Returns turn stats. */
  const flushed = (sessionId: string): Promise<TurnStats | undefined> => {
    const entry = flushPromises.get(sessionId)
    if (entry !== undefined) {
      // Wait for turn/end to flush, then read turn stats.
      return entry.promise.then(() => turnStatsMap.get(sessionId))
    }
    // No flush entry — turn/end already fired or never started.
    // Return turn stats directly if available.
    return Promise.resolve(turnStatsMap.get(sessionId))
  }

  return {
    stop: () => {
      controller.abort()
      for (const entry of pendingUpdates.values()) clearTimeout(entry.timer)
      pendingUpdates.clear()
      sessionStates.clear()
      turnStatsMap.clear()
      for (const entry of flushPromises.values()) entry.resolve()
      flushPromises.clear()
    },
    consumeReasoning,
    consumeLastStepHadContent,
    flushed,
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

/** Format a token count for display (e.g. 1234 → "1.2K"). */
function formatTokenCount(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}K`
  return `${Math.round(n / 100_000) / 10}M`
}

/**
 * Render a unified per-step card with reasoning, text, and tool calls.
 */
function renderStepCard(
  reasoning: string | undefined,
  text: string | undefined,
  tools: StepToolCall[],
  usage?: StepUsage,
  stepDurationMs?: number,
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
    if (elements.length > 0) {
      elements.push({ tag: 'hr' })
      elements.push({ tag: 'markdown', content: '🔧 **Tool Call**' })
    }
    for (const tool of tools) {
      const toolLines: string[] = []

      // Description BEFORE title (summary from callView.description or callView.title)
      const description = tool.callView?.description ?? tool.callView?.title
      if (description !== undefined) {
        toolLines.push(`> ${description}`)
      }

      // Always show the tool function name (read, bash, web_search, etc.) as inline code
      if (tool.result !== undefined) {
        const icon = tool.result.isError ? '❌' : '✅'
        toolLines.push(`${icon} \`${tool.toolName}\` — ${tool.result.elapsed >= 1000 ? `${(tool.result.elapsed / 1000).toFixed(1)}s` : `${tool.result.elapsed}ms`}`)
      } else {
        toolLines.push(`⏳ \`${tool.toolName}\` — running…`)
      }

      // Args: always show when available (inline code)
      const argsSummary = summarizeValue(tool.arguments, 200)
      if (argsSummary !== '') toolLines.push(`> args: \`${argsSummary}\``)

      elements.push({ tag: 'markdown', content: toolLines.join('\n') })

      // Result preview: dispatch on resultView.card type
      if (tool.result !== undefined) {
        const resultElements = renderResultPreview(tool)
        elements.push(...resultElements)
      }
    }
  }

  // Fallback
  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: '*(empty)*' })
  }

  // Step footer: duration + token counts
  const footerParts: string[] = []
  if (stepDurationMs !== undefined && stepDurationMs > 0) {
    footerParts.push(stepDurationMs >= 1000
      ? `⏱ ${(stepDurationMs / 1000).toFixed(1)}s`
      : `⏱ ${stepDurationMs}ms`)
  }
  if (usage !== undefined) {
    footerParts.push(`📥 ${formatTokenCount(usage.inputTokens)} in`)
    footerParts.push(`📤 ${formatTokenCount(usage.outputTokens)} out`)
  }
  if (footerParts.length > 0) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: footerParts.join(' · '), text_size: 'notation' })
  }

  // Card title and color: determined only by tool status, not thinking content
  const hasTools = tools.length > 0
  const allToolsDone = hasTools && tools.every(t => t.result !== undefined)
  const anyToolError = hasTools && tools.some(t => t.result?.isError === true)

  let title: string
  let template: string
  if (hasTools && allToolsDone && anyToolError) {
    title = 'Tool Error'
    template = 'red'
  } else if (hasTools && allToolsDone) {
    title = 'Tool Done'
    template = 'green'
  } else if (hasTools) {
    title = 'Tool Call'
    template = 'wathet'
  } else {
    title = 'Reply'
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

/**
 * Render result preview elements based on the resultView card type.
 * Mirrors how DSH Web UI dispatches on card type for specialized rendering.
 */
function renderResultPreview(tool: StepToolCall): object[] {
  const rv = tool.resultView
  const elements: object[] = []

  // Terminal card (bash, pwsh): code block with output + exit code
  if (rv?.card === 'terminal') {
    if (rv.output !== undefined && rv.output.trim() !== '') {
      const output = rv.output.length > 500 ? rv.output.slice(0, 500) + '…' : rv.output
      elements.push({ tag: 'markdown', content: `\`\`\`\n${output}\n\`\`\`` })
    }
    return elements
  }

  // Web search card: structured source list
  if (rv?.card === 'web' && rv.kind === 'search' && Array.isArray(rv.sources)) {
    const lines: string[] = []
    if (rv.answer !== undefined && rv.answer.trim() !== '') {
      lines.push(rv.answer.length > 300 ? rv.answer.slice(0, 300) + '…' : rv.answer)
      lines.push('')
    }
    for (let i = 0; i < rv.sources.length; i++) {
      const s = rv.sources[i]
      const title = s.title ?? s.url
      lines.push(`${i + 1}. [${title}](${s.url})`)
      if (s.snippet !== undefined && s.snippet.trim() !== '') {
        lines.push(`   > ${s.snippet.length > 150 ? s.snippet.slice(0, 150) + '…' : s.snippet}`)
      }
    }
    if (rv.truncated) lines.push('*(truncated)*')
    if (lines.length > 0) {
      elements.push({ tag: 'markdown', content: lines.join('\n') })
    }
    return elements
  }

  // Web fetch card: URL + status
  if (rv?.card === 'web' && rv.kind === 'fetch') {
    const status = rv.statusCode >= 200 && rv.statusCode < 300 ? '✅' : '⚠️'
    elements.push({ tag: 'markdown', content: `${status} \`${rv.url}\` — HTTP ${rv.statusCode}${rv.truncated ? ' (truncated)' : ''}` })
    return elements
  }

  // Search card (grep/glob): file matches or paths
  if (rv?.card === 'search') {
    if (rv.shape === 'paths' && Array.isArray(rv.paths)) {
      const paths = rv.paths.slice(0, 20)
      const lines = paths.map((p: string) => `- \`${p}\``)
      if (rv.truncated) lines.push(`*(showing ${paths.length} of ${rv.total})*`)
      if (lines.length > 0) {
        elements.push({ tag: 'markdown', content: lines.join('\n') })
      }
    } else if (rv.shape === 'matches' && Array.isArray(rv.files)) {
      const lines: string[] = []
      for (const file of rv.files.slice(0, 5)) {
        lines.push(`**${file.path}**`)
        if (Array.isArray(file.matches)) {
          for (const m of file.matches.slice(0, 3)) {
            lines.push(`  ${m.lineNumber}: \`${m.line.trim()}\``)
          }
        }
      }
      if (rv.truncated) lines.push(`*(showing ${rv.files.length} files of ${rv.total} matches)*`)
      if (lines.length > 0) {
        elements.push({ tag: 'markdown', content: lines.join('\n') })
      }
    }
    return elements
  }

  // Read card: file content with line numbers
  if (rv?.card === 'read' && Array.isArray(rv.lines)) {
    if (rv.lines.length > 0) {
      const content = rv.lines
        .map((l: any) => `${String(l.number).padStart(4)}│ ${l.text}`)
        .slice(0, 30)
        .join('\n')
      const lang = rv.lang !== undefined ? rv.lang : ''
      elements.push({ tag: 'markdown', content: `\`\`\`${lang}\n${content}\n\`\`\`` })
    }
    return elements
  }

  // Diff card: show diff hunks
  if (rv?.card === 'diff' && Array.isArray(rv.diffs)) {
    for (const diff of rv.diffs.slice(0, 3)) {
      if (!Array.isArray(diff.hunks)) continue
      const lines = diff.hunks
        .flatMap((h: any) => h.lines.map((l: any) => {
          if (l.type === 'add') return `+ ${l.text}`
          if (l.type === 'remove') return `- ${l.text}`
          return `  ${l.text}`
        }))
        .slice(0, 20)
      if (lines.length > 0) {
        elements.push({ tag: 'markdown', content: `**${diff.path}**\n\`\`\`diff\n${lines.join('\n')}\n\`\`\`` })
      }
    }
    return elements
  }

  // Generic card or fallback: use content blocks or raw result
  if (rv?.card === 'generic' && Array.isArray(rv.content)) {
    const text = rv.content
      .filter((b: any) => b.type === 'text' && b.text !== undefined)
      .map((b: any) => b.text ?? '')
      .join('\n')
    if (text.trim() !== '') {
      const output = text.length > 500 ? text.slice(0, 500) + '…' : text
      elements.push({ tag: 'markdown', content: `\`\`\`\n${output}\n\`\`\`` })
    }
    return elements
  }

  // Last resort: use raw result content from the tool result
  if (tool.result !== undefined && tool.result.content !== '') {
    const output = tool.result.content.length > 500 ? tool.result.content.slice(0, 500) + '…' : tool.result.content
    elements.push({ tag: 'markdown', content: `\`\`\`\n${output}\n\`\`\`` })
  }

  return elements
}
