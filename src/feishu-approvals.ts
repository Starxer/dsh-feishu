/**
 * Feishu UI bridge for the `approval/request` waterfall: subscribes to the
 * apiproxy mux stream so the Feishu chat can render an interactive card with
 * Approve / Reject buttons, then post the user's pick back through the
 * apiproxy `respond()` RPC. The first answer — Feishu or WebUI — wins
 * because both share the apiproxy `pendingApprovals` registry.
 *
 * Why mux fan-out and not a `ctx.approval` provider?
 *   `ctx.approval` accepts a single request handler and the apiproxy is
 *   already attached to it as `ctx.on('approval/request', ...)`. Adding a
 *   second listener would either duplicate the audit-pair lookup or race
 *   for the same approvalId. The apiproxy broadcasts every ask to every mux
 *   subscriber, so adding another subscriber is the documented fan-out
 *   path — the WebUI client uses the same one.
 *
 * @module @starxer/dsh-feishu/feishu-approvals
 */

import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type {
  ApiProxy,
  ApprovalResponsePayload,
  ClientResponse,
  MuxFrame,
} from '@deepseek-ai/dsh-host-apiproxy'
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

/**
 * Per-approval state tracked in the listener: the rpcId to send back to
 * apiproxy, the audit `approvalId` for the schema, the chat we already
 * notified, and the short user-visible code the user types after
 * `/approve<short>`.
 */
interface PendingApproval {
  rpcId: string
  approvalId: string
  sessionId: string
  chat: ConversationMessage
  toolName: string
  shortCode: string
  createdAt: number
}

/**
 * Channel adapter. `send` is called once per pending approval to render the
 * card; `onCardAction` re-binds across reconnects so a channel swap does
 * not strand live approvals.
 */
export interface FeishuApprovalsChannel {
  send(to: string, input: { card: object }, opts?: { replyInThread?: boolean }): Promise<unknown>
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
  apiProxy: ApiProxy
  channel: FeishuApprovalsChannel
  bridgeHolder: BridgeHolder
  logger: PluginLogger
}

/** Outcome kinds accepted by apiproxy's `ApprovalResponsePayload.outcome`. */
type ApprovalOutcomeKind = 'allowed-once' | 'rejected'

/** Stable shape returned to the slash command handlers. */
export interface PendingApprovalView {
  rpcId: string
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
  findPending: (sessionId: string, rpcIdOrShort: string) => PendingApprovalView | undefined
} {
  const { apiProxy, channel, bridgeHolder, logger } = deps
  const controller = new AbortController()
  // rpcId -> pending (card-click lookup). Short codes are derived from the
  // rpcId so the slash command and the card share the same identifier
  // surface; see `shortCodeFor`.
  const pending = new Map<string, PendingApproval>()

  const respondForApproval = async (
    rpcId: string,
    payload: ApprovalResponsePayload,
  ): Promise<void> => {
    const response: ClientResponse = {
      type: 'client-response',
      rpcId: RpcId(rpcId),
      result: { ok: true, value: payload },
    }
    try {
      const receipt = await apiProxy.respond(response)
      if (!receipt.accepted) {
        logger.warn(`dsh-lark: approval response rejected by apiproxy: ${receipt.reason}`)
      }
    } catch (error: unknown) {
      logger.warn(`dsh-lark: failed to deliver approval answer: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const settle = async (
    rpcId: string,
    outcome: ApprovalOutcomeKind,
  ): Promise<void> => {
    const entry = pending.get(rpcId)
    if (entry === undefined) return
    pending.delete(rpcId)
    await respondForApproval(rpcId, {
      sessionId: entry.sessionId as never,
      approvalId: entry.approvalId as never,
      outcome,
    })
  }

  const onCardAction = async (evt: CardActionLike): Promise<void> => {
    const action = evt.action
    const raw = action?.value
    if (typeof raw !== 'string') return
    let parsed: { rpcId?: unknown; outcome?: unknown }
    try {
      parsed = JSON.parse(raw) as typeof parsed
    } catch {
      return
    }
    if (typeof parsed.rpcId !== 'string') return
    const outcome = parsed.outcome === 'rejected' ? 'rejected' : 'allowed-once'
    await settle(parsed.rpcId, outcome)
  }
  const unsubscribeCardAction = channel.onCardAction(onCardAction)

  const iterate = async (): Promise<void> => {
    try {
      for await (const envelope of apiProxy.events.mux(
        { rpcId: RpcId(`feishu-approvals-${Date.now()}`), payload: {} },
        controller.signal,
      )) {
        const frame = envelope.payload as MuxFrame
        if (frame.type !== 'approval/requested') continue
        const bridge = bridgeHolder.current
        if (bridge === undefined) continue
        const chat = bridge.resolveChat(frame.sessionId)
        if (chat === undefined) continue
        const shortCode = shortCodeFor(envelope.rpcId as unknown as string)
        const entry: PendingApproval = {
          rpcId: envelope.rpcId as unknown as string,
          approvalId: frame.approvalId as unknown as string,
          sessionId: frame.sessionId,
          chat,
          toolName: frame.toolName,
          shortCode,
          createdAt: Date.now(),
        }
        pending.set(entry.rpcId, entry)
        const card = renderApprovalCard(entry)
        try {
          await channel.send(chat.chatId, { card }, chat.threadId !== undefined ? { replyInThread: true } : {})
        } catch (error: unknown) {
          // Sending failed; abandon so the agent isn't blocked on a user
          // who never sees the prompt.
          pending.delete(entry.rpcId)
          logger.warn(`dsh-lark: approval card send failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return
      logger.warn(`dsh-lark: approval stream interrupted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  void iterate()

  const stop = (): void => {
    controller.abort()
    unsubscribeCardAction()
    pending.clear()
  }

  const view = (entry: PendingApproval): PendingApprovalView => ({
    rpcId: entry.rpcId,
    approvalId: entry.approvalId,
    sessionId: entry.sessionId,
    chatId: entry.chat.chatId,
    toolName: entry.toolName,
    shortCode: entry.shortCode,
    createdAt: entry.createdAt,
  })

  // Resolve by full rpcId first, then by short code (4-char prefix). The
  // short code is unique within the listener's lifetime because rpcIds
  // minted by apiproxy are random UUIDs.
  const findPending = (sessionId: string, rpcIdOrShort: string): PendingApprovalView | undefined => {
    for (const entry of pending.values()) {
      if (entry.sessionId !== sessionId) continue
      if (entry.rpcId === rpcIdOrShort) return view(entry)
      if (entry.shortCode === rpcIdOrShort) return view(entry)
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

  return { stop, pendingForSession, findPending }
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
function renderApprovalCard(entry: PendingApproval): object {
  const body: object[] = []
  body.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**Tool:** \`${entry.toolName}\`` },
  })
  if (entry.chat.threadId !== undefined) {
    body.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `_id \`${entry.shortCode}\` · pending in this thread_` },
    })
  } else {
    body.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `_id \`${entry.shortCode}\` · pending in this chat_` },
    })
  }
  const value = JSON.stringify({ rpcId: entry.rpcId })
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Approval needed' },
      template: 'orange',
    },
    body: {
      elements: [
        ...body,
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Reject' },
              type: 'danger',
              value: JSON.stringify({ rpcId: entry.rpcId, outcome: 'rejected' }),
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Approve once' },
              type: 'primary',
              value,
            },
          ],
        },
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
  apiProxy: ApiProxy,
  view: PendingApprovalView,
  outcome: ApprovalOutcomeKind,
  logger: PluginLogger,
): Promise<void> {
  const response: ClientResponse = {
    type: 'client-response',
    rpcId: RpcId(view.rpcId),
    result: {
      ok: true,
      value: {
        sessionId: view.sessionId as never,
        approvalId: view.approvalId as never,
        outcome,
      } satisfies ApprovalResponsePayload,
    },
  }
  try {
    const receipt = await apiProxy.respond(response)
    if (!receipt.accepted) {
      logger.warn(`dsh-lark: ${outcome} response rejected by apiproxy: ${receipt.reason}`)
    }
  } catch (error: unknown) {
    logger.warn(`dsh-lark: failed to deliver ${outcome}: ${error instanceof Error ? error.message : String(error)}`)
  }
}