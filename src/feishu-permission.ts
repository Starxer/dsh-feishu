/**
 * Interactive Permission picker card for the `/permission` Feishu command.
 *
 * DSH's Web UI exposes the per-session permission (sandbox) mode through the
 * `ui-permission-presets` picker decorating the `/permission` command. This
 * module renders the Feishu equivalent: a card showing the current mode with
 * one button per preset (Read Only / Workspace Write / Full access). Clicking
 * a button switches the session by appending the log-only `sandbox/mode`
 * event (the `dsh-sandbox-policy` `setSandboxMode` write path) and updates the
 * card in place so the active mode is re-marked.
 *
 * The cardAction dispatcher is shared via the plugin's `cardChannel` adapter,
 * which rebinds handlers across channel reconnects; button clicks therefore
 * keep working even after a channel swap.
 *
 * @module @starxer/dsh-feishu/feishu-permission
 */

import type { ConversationMessage } from './conversation.ts'
import { decodeCardValue } from './card-action.ts'

/** DSH file-sandbox / permission preset vocabulary (mirrors `dsh-sandbox-policy`). */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** User-facing labels matching the DSH WebUI `ui-permission-presets` plugin. */
export const PERMISSION_LABELS: Record<string, string> = {
  'read-only': 'Read Only',
  'workspace-write': 'Workspace Write',
  'danger-full-access': 'Full access',
}

const MODE_ICON: Record<string, string> = {
  'read-only': '📖',
  'workspace-write': '✍️',
  'danger-full-access': '🔓',
}

/** Narrow card-action event surface the picker consumes. */
export interface PermissionCardEvent {
  messageId?: string
  chatId?: string
  action?: { value?: unknown }
}

/** The shared cardChannel's minimal surface (send / update / subscribe). */
export interface PermissionCardChannel {
  send(to: string, input: { card: object }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCard(messageId: string, card: object): Promise<void>
  onCardAction(handler: (evt: PermissionCardEvent) => void | Promise<void>): () => void
}

/** Narrow live-session surface the picker switches on. */
export interface PermissionSession {
  append(type: string, data: object): void
}

/** Narrow `ctx.sandboxPolicy` surface used to read the effective mode. */
export interface PermissionSandbox {
  resolve?(req: { session?: PermissionSession }): { mode: string; workspaceRoot?: string }
}

export interface FeishuPermissionDeps {
  channel: PermissionCardChannel
  sandbox: PermissionSandbox | undefined
  sessionGetter: (id: string) => PermissionSession | undefined
  logger: { warn(message: string): unknown; error(message: string): unknown }
}

export interface FeishuPermissionHandle {
  /** Send the interactive picker card for one chat/session and remember it so
   *  button clicks can switch the session. Returns the sent message id. */
  open(chat: ConversationMessage, sessionId: string): Promise<string | undefined>
  stop(): void
}

/** Render the permission picker card with the active mode marked. */
export function renderPermissionCard(current: string): object {
  const elements: object[] = [
    { tag: 'markdown', content: `**当前权限模式：** \`${current}\` ${PERMISSION_LABELS[current] ?? current} ${MODE_ICON[current] ?? ''}` },
    { tag: 'markdown', content: '_点击下方按钮切换本会话的权限（沙箱）模式。切换写入会话日志，下一次受限调用（bash / 文件系统）即生效。_' },
  ]
  for (const mode of SANDBOX_MODES) {
    const active = mode === current
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `${active ? '✓ ' : ''}${PERMISSION_LABELS[mode] ?? mode}` },
      type: mode === 'danger-full-access' ? 'danger' : mode === 'workspace-write' ? 'primary' : 'default',
      value: JSON.stringify({ p: 'permission', mode }),
      ...(active ? { disabled: true } : {}),
    })
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Permission' }, template: 'turquoise' },
    body: { elements },
  }
}

/** Start the permission picker: send cards on demand and handle button clicks. */
export function startFeishuPermission(deps: FeishuPermissionDeps): FeishuPermissionHandle {
  const { channel, sandbox, sessionGetter, logger } = deps
  const byCard = new Map<string, { sessionId: string }>()

  const onCardAction = async (evt: PermissionCardEvent): Promise<void> => {
    const messageId = evt.messageId
    if (messageId === undefined) return
    const rec = byCard.get(messageId)
    if (rec === undefined) return
    // `action.value` is double-encoded (see card-action.ts); unwrap it.
    const parsed = decodeCardValue(evt.action?.value)
    if (parsed === undefined) return
    if (parsed.p !== 'permission' || typeof parsed.mode !== 'string') return
    if (!(SANDBOX_MODES as readonly string[]).includes(parsed.mode)) return
    const session = sessionGetter(rec.sessionId)
    if (session === undefined) return
    // setSandboxMode(session, mode) — append the log-only switch event.
    session.append('sandbox/mode', { mode: parsed.mode })
    const current = sandbox?.resolve?.({ session })?.mode ?? parsed.mode
    await channel.updateCard(messageId, renderPermissionCard(current)).catch((error: unknown) => {
      logger.warn(`dsh-feishu: permission card update failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const unsubscribe = channel.onCardAction(onCardAction)

  const open = async (chat: ConversationMessage, sessionId: string): Promise<string | undefined> => {
    const session = sessionGetter(sessionId)
    if (session === undefined) throw new Error('当前 chat 还没有会话，请先发一条消息再执行 /permission')
    const current = sandbox?.resolve?.({ session })?.mode ?? ''
    const opts = chat.threadId !== undefined
      ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
      : {}
    const result = await channel.send(chat.chatId, { card: renderPermissionCard(current) }, opts)
    const messageId = (result as { messageId?: string })?.messageId
    if (messageId !== undefined) byCard.set(messageId, { sessionId })
    return messageId
  }

  const stop = (): void => {
    unsubscribe()
    byCard.clear()
  }

  return { open, stop }
}
