/**
 * Interactive Permission picker card for the `/permission` Feishu command.
 *
 * DSH's Web UI exposes the per-session permission mode through the
 * `permission-presets` picker decorating the `/permission` command. This
 * module renders the Feishu equivalent: a card showing the current mode with
 * one button per preset (Read Only / Workspace Write / Full access). Clicking
 * a button switches the session through DSH's `permissionPresets.set()` write
 * path — it records the `permission/preset` intent and writes BOTH the
 * `sandbox/mode` and `approval/policy` knobs, so the session's effective
 * bundle keeps matching a real preset instead of degrading to "custom" — and
 * updates the card in place so the active mode is re-marked.
 *
 * The cardAction dispatcher is shared via the plugin's `cardChannel` adapter,
 * which rebinds handlers across channel reconnects; button clicks therefore
 * keep working even after a channel swap.
 *
 * @module @starxer/chatterbox4dsh/feishu-permission
 */

import type { ConversationMessage } from './conversation.ts'
import type { Translations } from './i18n.ts'
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

/** Locale-aware label for a sandbox mode (falls back to the mode id). */
function permissionLabel(mode: string, t: Translations): string {
  switch (mode) {
    case 'read-only': return t.permissionReadOnly
    case 'workspace-write': return t.permissionWorkspaceWrite
    case 'danger-full-access': return t.permissionFullAccess
    default: return mode
  }
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

/**
 * Narrow DSH `permissionPresets` service surface. A preset bundles BOTH the
 * sandbox mode and the approval policy; using the service's `set()` write path
 * keeps both knobs (plus the `permission/preset` intent event) consistent so
 * DSH recognizes the mode as a real preset instead of "custom". Without it the
 * picker falls back to appending only the `sandbox/mode` knob, which DSH can
 * never match against a preset.
 */
export interface PermissionPresets {
  /** The effective preset name for the session (`read-only` /
   *  `workspace-write` / `danger-full-access` / `custom`). */
  current(session: PermissionSession): string
  /** Switch the session to a preset, writing every changed knob. */
  set(session: PermissionSession, name: string): void
}

/** Narrow `ctx.sandboxPolicy` surface used to read the effective mode. */
export interface PermissionSandbox {
  resolve?(req: { session?: PermissionSession }): { mode: string; workspaceRoot?: string }
}

export interface FeishuPermissionDeps {
  channel: PermissionCardChannel
  sandbox: PermissionSandbox | undefined
  /** DSH `permissionPresets` service; preferred for both the read and the write
   *  path (it keeps the sandbox + approval bundle in sync). */
  permissionPresets?: PermissionPresets | undefined
  sessionGetter: (id: string) => PermissionSession | undefined
  logger: { warn(message: string): unknown; error(message: string): unknown }
  /** Return the strings for the ACTIVE locale, read at render time. */
  getTranslations: () => Translations
}

export interface FeishuPermissionHandle {
  /** Send the interactive picker card for one chat/session and remember it so
   *  button clicks can switch the session. Returns the sent message id. */
  open(chat: ConversationMessage, sessionId: string): Promise<string | undefined>
  stop(): void
}

/** Render the permission picker card with the active mode marked. */
export function renderPermissionCard(current: string, t: Translations): object {
  const elements: object[] = [
    { tag: 'markdown', content: `${t.permissionCurrent(current)} ${permissionLabel(current, t)} ${MODE_ICON[current] ?? ''}` },
    { tag: 'markdown', content: t.permissionHint },
  ]
  for (const mode of SANDBOX_MODES) {
    const active = mode === current
    // Color language: keep every selectable button clearly clickable. Only
    // "Full access" keeps the red danger tint (a warning); Read Only and
    // Workspace Write share the blue primary so none of them look like the
    // grayed-out (disabled) current-mode button. The current mode is the ONE
    // disabled + gray + ✓ button, so it is never confusable with Read Only.
    const type = mode === 'danger-full-access' ? 'danger' : 'primary'
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `${active ? '✓ ' : ''}${permissionLabel(mode, t)}` },
      type,
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
  const { channel, sandbox, permissionPresets, sessionGetter, logger, getTranslations } = deps
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
    // Switch through DSH's preset write path when available: a preset bundles
    // the sandbox mode AND the approval policy, so writing only the sandbox
    // knob leaves the bundle unmatched and DSH reports it as "custom". Fall
    // back to the single-knob `sandbox/mode` append when the service is absent.
    if (permissionPresets !== undefined) {
      permissionPresets.set(session, parsed.mode)
    } else {
      session.append('sandbox/mode', { mode: parsed.mode })
    }
    const current = permissionPresets?.current(session) ?? sandbox?.resolve?.({ session })?.mode ?? parsed.mode
    await channel.updateCard(messageId, renderPermissionCard(current, getTranslations())).catch((error: unknown) => {
      logger.warn(`dsh-feishu: permission card update failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const unsubscribe = channel.onCardAction(onCardAction)

  const open = async (chat: ConversationMessage, sessionId: string): Promise<string | undefined> => {
    const session = sessionGetter(sessionId)
    if (session === undefined) throw new Error(getTranslations().permissionNoSession)
    const current = permissionPresets?.current(session) ?? sandbox?.resolve?.({ session })?.mode ?? ''
    const opts = chat.threadId !== undefined
      ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
      : {}
    const result = await channel.send(chat.chatId, { card: renderPermissionCard(current, getTranslations()) }, opts)
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
