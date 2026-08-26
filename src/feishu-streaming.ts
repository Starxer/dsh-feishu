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

  /** Debounce timer for updateStepCard to merge rapid updates. */
  const updateTimers = new Map<SessionStepState, ReturnType<typeof setTimeout>>()

  /** Update the existing step card with current state (debounced). */
  const updateStepCard = (state: SessionStepState): void => {
    if (!state.stepCardSent || state.stepCardMessageId === undefined) return
    // Capture BOTH messageId and card NOW — resetStep may clear state before the timer fires
    const messageIdPromise = state.stepCardMessageId
    const card = buildStepCard(state)
    // Clear previous pending update
    const existing = updateTimers.get(state)
    if (existing !== undefined) clearTimeout(existing)
    // Debounce: merge rapid updates into one (150ms threshold)
    updateTimers.set(state, setTimeout(() => {
      updateTimers.delete(state)
      void messageIdPromise.then((messageId) => {
        if (messageId !== undefined) {
          console.log(`dsh-feishu: [update] updating card ${messageId}`)
          return channel.updateCard(messageId, card)
        }
        console.log('dsh-feishu: [update] messageId is undefined, skipping')
      }).catch((error: unknown) => {
        console.log(`dsh-feishu: [update] failed: ${error instanceof Error ? error.message : String(error)}`)
        logger.warn(`dsh-feishu: step card update failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 150))
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
      for (const timer of updateTimers.values()) clearTimeout(timer)
      updateTimers.clear()
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

      // Always show the tool function name (read, bash, web_search, etc.)
      if (tool.result !== undefined) {
        const icon = tool.result.isError ? '❌' : '✅'
        toolLines.push(`${icon} **${tool.toolName}** — ${tool.result.elapsed >= 1000 ? `${(tool.result.elapsed / 1000).toFixed(1)}s` : `${tool.result.elapsed}ms`}`)
      } else {
        toolLines.push(`⏳ **${tool.toolName}** — running…`)
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
  if (rv?.card === 'web' && rv.kind === 'search') {
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
    if (rv.shape === 'paths') {
      const paths = rv.paths.slice(0, 20)
      const lines = paths.map((p: string) => `- \`${p}\``)
      if (rv.truncated) lines.push(`*(showing ${paths.length} of ${rv.total})*`)
      if (lines.length > 0) {
        elements.push({ tag: 'markdown', content: lines.join('\n') })
      }
    } else if (rv.shape === 'matches') {
      const lines: string[] = []
      for (const file of rv.files.slice(0, 5)) {
        lines.push(`**${file.path}**`)
        for (const m of file.matches.slice(0, 3)) {
          lines.push(`  ${m.lineNumber}: \`${m.line.trim()}\``)
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
  if (rv?.card === 'read') {
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
  if (rv?.card === 'diff') {
    for (const diff of rv.diffs.slice(0, 3)) {
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
  if (rv?.card === 'generic' && rv.content !== undefined) {
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
