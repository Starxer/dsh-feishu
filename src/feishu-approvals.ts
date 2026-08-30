/**
 * Feishu UI bridge for the `approval/request` waterfall: registers an
 * `approval/request` listener on the host context so the Feishu chat can
 * render an interactive card with Approve / Reject buttons and return the
 * outcome through the listener's resolved promise. Returning from the
 * listener claims the request — the default user-approval provider never
 * sees it.
 *
 * The plugin uses its own `pendingId` (and `approvalId`) to identify a
 * pending approval in card callbacks and slash commands, because the
 * upstream `ApprovalRequest` does not expose one (audit IDs are minted
 * inside the `user-approval` service after the waterfall resolves).
 *
 * @module @starxer/chatterbox4dsh/feishu-approvals
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
// Side-effect import: the package's d.ts augments `@deepseek-ai/cordis` with
// `'approval/request'` on `Events`; the augmentation only loads when the
// d.ts is referenced, so this import is required to make `ctx.on` accept
// the event name.
import '@deepseek-ai/dsh-user-approval'
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

/**
 * Per-approval state tracked in the listener: the rpcId to send back to
 * apiproxy, the audit `approvalId` for the schema, the chat we already
 * notified, and the short user-visible code the user types after
 * `/approve<short>`.
 */
interface PendingApproval {
  pendingId: string
  approvalId: string
  sessionId: string
  chat: ConversationMessage
  toolName: string
  /** Human-readable reason supplied by the asker, rendered on the card. */
  reason?: string
  shortCode: string
  createdAt: number
  /** Resolves with the user's outcome (or 'cancelled' on abort). */
  resolve: (outcome: ApprovalOutcome) => void
  /** Message ID of the approval card, used to update it after settlement. */
  cardMessageId?: string
}

/**
 * Channel adapter. `send` is called once per pending approval to render the
 * card; `onCardAction` re-binds across reconnects so a channel swap does
 * not strand live approvals.
 */
export interface FeishuApprovalsChannel {
  send(to: string, input: { card: object }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCard(messageId: string, card: object): Promise<void>
  onCardAction(handler: (evt: CardActionLike) => void | Promise<void>): () => void
}

interface CardActionLike {
  messageId?: string
  chatId?: string
  operator?: { openId?: string }
  action?: { value?: unknown; tag?: string; option?: string }
}

/** Public surface the approvals module reads. */
export interface FeishuApprovalsDeps {
  ctx: Context
  channel: FeishuApprovalsChannel
  bridgeHolder: BridgeHolder
  logger: PluginLogger
}

/** Outcome kinds accepted by apiproxy's `ApprovalResponsePayload.outcome`. */
type ApprovalOutcomeKind = 'allowed-once' | 'rejected'

/** Stable shape returned to the slash command handlers. */
export interface PendingApprovalView {
  pendingId: string
  approvalId: string
  sessionId: string
  chatId: string
  toolName: string
  shortCode: string
  createdAt: number
}

/**
 * Subscribe to the apiproxy mux stream and forward every `approval/requested`
 * frame to the chat that owns the session. Returns a disposer that closes
 * the SSE subscription and detaches the cardAction listener.
 *
 * @param deps Live references to the apiproxy, the Lark channel, and the
 *   current bridge. The bridge is read lazily because `runtime.reconcile()`
 *   replaces it; re-resolving on every approval handles that case naturally.
 * @returns A disposer plus a getter for the live pending list, which the
 *   `/approvals` slash command reads.
 */
export function startFeishuApprovals(deps: FeishuApprovalsDeps): {
  stop: () => void
  pendingForSession: (sessionId: string) => PendingApprovalView[]
  findPending: (sessionId: string, pendingIdOrShort: string) => PendingApprovalView | undefined
  /** Settle an approval by pendingId — handles both card-click and slash-command
   *  paths.  Updates the approval card to show the final outcome. */
  settle: (pendingId: string, outcome: 'allowed-once' | 'rejected') => Promise<void>
} {
  const { ctx, channel, bridgeHolder, logger } = deps
  const pending = new Map<string, PendingApproval>()

  const settle = async (
    pendingId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<void> => {
    const entry = pending.get(pendingId)
    if (entry === undefined) return
    pending.delete(pendingId)
    entry.resolve(outcome)
    if (entry.cardMessageId !== undefined) {
      const settledCard = renderSettledCard(entry, outcome)
      await channel.updateCard(entry.cardMessageId, settledCard).catch((error: unknown) => {
        logger.warn(`dsh-feishu: failed to update approval card: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  const onCardAction = async (evt: CardActionLike): Promise<void> => {
    const action = evt.action
    let raw = action?.value
    if (typeof raw !== 'string') return
    let parsed: { pendingId?: unknown; outcome?: unknown }
    try {
      let result = JSON.parse(raw)
      if (typeof result === 'string') result = JSON.parse(result)
      parsed = result as typeof parsed
    } catch {
      return
    }
    if (typeof parsed.pendingId !== 'string') return
    const outcome = parsed.outcome === 'rejected' ? 'rejected' : 'allowed-once'
    await settle(parsed.pendingId, outcome)
  }
  const unsubscribeCardAction = channel.onCardAction(onCardAction)

  const handleRequest = async (
    request: ApprovalRequest,
    next?: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    if (request.agent === undefined) {
      return next !== undefined ? await next() : 'unavailable'
    }
    const sessionId = request.agent.session.id
    const bridge = bridgeHolder.current
    if (bridge === undefined) {
      return next !== undefined ? await next() : 'unavailable'
    }
    const chat = bridge.resolveChat(sessionId)
    if (chat === undefined) {
      return next !== undefined ? await next() : 'unavailable'
    }

    const pendingId = `feishu-a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const approvalId = pendingId
    const shortCode = shortCodeFor(pendingId)

    const entry: PendingApproval = {
      pendingId,
      approvalId,
      sessionId,
      chat,
      toolName: request.toolName,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      shortCode,
      createdAt: Date.now(),
      resolve: (_outcome) => undefined,
    }

    const promise = new Promise<ApprovalOutcome>((resolve) => {
      entry.resolve = resolve
    })
    pending.set(pendingId, entry)

    const card = renderApprovalCard(entry)
    try {
      const result = await channel.send(chat.chatId, { card }, chat.threadId !== undefined
        ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
        : {})
      const mid = (result as { messageId?: string })?.messageId
      if (mid !== undefined) entry.cardMessageId = mid
    } catch (error: unknown) {
      pending.delete(pendingId)
      logger.warn(`dsh-feishu: approval card send failed: ${error instanceof Error ? error.message : String(error)}`)
      return next !== undefined ? await next() : 'unavailable'
    }

    // Race the user answer against the request signal. On abort, treat as
    // 'cancelled' and let the next listener try — but ONLY if the user has
    // not already settled (we don't want a stale resolve to override).
    const outcome: ApprovalOutcome = await new Promise<ApprovalOutcome>((resolve) => {
      let settled = false
      const onAbort = () => {
        if (settled) return
        settled = true
        if (pending.has(pendingId)) {
          pending.delete(pendingId)
          resolve('cancelled')
        } else {
          resolve('unavailable')
        }
      }
      if (request.signal?.aborted) {
        onAbort()
        return
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      promise.then((o) => {
        if (settled) return
        settled = true
        request.signal?.removeEventListener('abort', onAbort)
        resolve(o)
      })
    })

    if (outcome === 'cancelled' || outcome === 'unavailable') {
      return next !== undefined ? await next() : outcome
    }
    return outcome
  }
  // Prepended so this answerer runs BEFORE api-remotes' forwarding listener.
  // See feishu-questions.ts for the rationale: remotes' WebUI waterfall
  // listener blocks the chain, so a plain (pushed) registration would leave
  // Feishu inner and the approval card would never render here. Prepend lets
  // Feishu claim first, but only for Feishu-bound sessions — others fall
  // through to `next()` and back to the WebUI answerer.
  const disposeListener = ctx.on('approval/request', handleRequest, { prepend: true })

  const view = (entry: PendingApproval): PendingApprovalView => ({
    pendingId: entry.pendingId,
    approvalId: entry.approvalId,
    sessionId: entry.sessionId,
    chatId: entry.chat.chatId,
    toolName: entry.toolName,
    shortCode: entry.shortCode,
    createdAt: entry.createdAt,
  })

  const findPending = (sessionId: string, pendingIdOrShort: string): PendingApprovalView | undefined => {
    for (const entry of pending.values()) {
      if (entry.sessionId !== sessionId) continue
      if (entry.pendingId === pendingIdOrShort) return view(entry)
      if (entry.shortCode === pendingIdOrShort) return view(entry)
    }
    return undefined
  }

  const pendingForSession = (sessionId: string): PendingApprovalView[] => {
    const out: PendingApprovalView[] = []
    for (const entry of pending.values()) {
      if (entry.sessionId === sessionId) out.push(view(entry))
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  const stop = (): void => {
    disposeListener()
    unsubscribeCardAction()
    for (const entry of pending.values()) entry.resolve('cancelled')
    pending.clear()
  }

  return { stop, pendingForSession, findPending, settle }
}

/** Derive a short, type-friendly code from the apiproxy rpcId. */
function shortCodeFor(rpcId: string): string {
  // Strip the RpcId brand wrapper (the underlying value is the raw UUID).
  const raw = rpcId.replace(/^.*?([0-9a-f]{8})([0-9a-f]{4}).*$/i, '$1$2').slice(-8)
  return raw === '' ? rpcId.slice(0, 6) : raw
}

/**
 * Build a Feishu interactive-card payload for one approval request. Header
 * "Approval needed", body with tool/reason, action row with Reject / Approve.
 */
export function renderApprovalCard(entry: PendingApproval): object {
  const locationHint = entry.chat.threadId !== undefined
    ? `_id \`${entry.shortCode}\` · pending in this thread_`
    : `_id \`${entry.shortCode}\` · pending in this chat_`
  const body: object[] = [
    { tag: 'markdown', content: `**Tool:** \`${entry.toolName}\`\n${locationHint}` },
  ]
  // Render the asker's reason on the card so the user can decide without
  // guessing what the tool is about to do. Omit the line when no reason exists.
  if (entry.reason !== undefined && entry.reason.trim() !== '') {
    body.push({ tag: 'markdown', content: `**Reason:** ${entry.reason}` })
  }
  // Card JSON 2.0: buttons go directly in body.elements (no 'action' wrapper).
  // Confirm-first order: Approve (primary) above Reject (danger).
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Approval needed' },
      template: 'orange',
    },
    body: {
      elements: [
        ...body,
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Approve once' },
          type: 'primary',
          value: JSON.stringify({ pendingId: entry.pendingId }),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Reject' },
          type: 'danger',
          value: JSON.stringify({ pendingId: entry.pendingId, outcome: 'rejected' }),
        },
      ],
    },
  }
}

/**
 * Build a settled (approved/rejected) card to replace the approval card.
 * Buttons are removed; header and body show the final outcome.
 */
function renderSettledCard(entry: PendingApproval, outcome: ApprovalOutcomeKind): object {
  const approved = outcome === 'allowed-once'
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: approved ? '✅ Approved' : '❌ Rejected' },
      template: approved ? 'green' : 'red',
    },
    body: {
      elements: [
        { tag: 'markdown', content: `${approved ? '✅' : '❌'} \`${entry.toolName}\` — ${approved ? 'approved once' : 'rejected'}` },
      ],
    },
  }
}

/**
 * Resolve one pending approval to a final outcome via the slash command
 * path (`/approve` / `/deny [/short]`). Returns `undefined` when nothing
 * matched so the command can surface a translated error.
 */
export async function settleApprovalBySlash(
  settle: (pendingId: string, outcome: 'allowed-once' | 'rejected') => Promise<void>,
  view: PendingApprovalView,
  outcome: 'allowed-once' | 'rejected',
  logger: PluginLogger,
): Promise<boolean> {
  try {
    await settle(view.pendingId, outcome)
    return true
  } catch (error: unknown) {
    logger.warn(`dsh-feishu: failed to deliver ${outcome}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}