/**
 * Feishu `/session` management panel.
 *
 * A single interactive card lets the user pick a session (by name) and run one
 * of five operations: switch (rebind this chat to the session — the plugin's
 * chat→session ownership), detach (plugin), rename / archive / fork (DSH
 * built-ins via `sessionController` / `workspaceRegistry`). Destructive ops
 * (switch-while-occupied, detach, archive, fork) ask for a confirm/cancel card
 * first; the outcome is a green result card.
 *
 * Blends the established Feishu card patterns: `select_static` + form submit
 * (like `feishu-model-select.ts`) to read the picked session and the rename
 * title, and the shared `cardChannel.onCardAction` dispatcher for every
 * callback — so buttons keep working across channel reconnects.
 *
 * @module @starxer/dsh-feishu/feishu-session
 */

import type { ConversationMessage } from './conversation.ts'
import { conversationKey } from './conversation.ts'
import type { HarnessConversationService } from './harness.ts'
import { decodeCardValue } from './card-action.ts'

/** One session entry surfaced by the panel (bridge.listSessions shape). */
export interface SessionEntry {
  id: string
  updatedAt: number
  title: string
  ownedBy?: string
}

/** Narrow bridge surface the panel consumes. */
export interface SessionBridge {
  listSessions(): Promise<SessionEntry[]>
  attachSession(message: ConversationMessage, sessionId: string): 'ok' | 'archived'
  detachSession(sessionId: string): { kind: 'released'; ownerLabel: string } | { kind: 'free' }
  describeChatKey(key: string): string
}

/** DSH session rename/fork (optional — degrade gracefully when absent). */
export interface SessionControllerLike {
  rename?(request: { sessionId: string; title: string }): Promise<unknown>
  fork?(request: { sessionId: string; atSeq?: number }): Promise<unknown>
}

/** DSH archive (optional). */
export interface WorkspaceRegistryLike {
  archiveSession?(sessionId: string): Promise<unknown>
}

/** Narrow card channel surface. */
export interface SessionCardChannel {
  send(to: string, input: { card: object } | { text: string }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCard(messageId: string, card: object): Promise<void>
  onCardAction(handler: (evt: SessionCardEvent) => void | Promise<void>): () => void
}

interface SessionCardEvent {
  messageId?: string
  chatId?: string
  action?: { value?: unknown; tag?: string; option?: string }
  raw?: { action?: { value?: unknown; form_value?: Record<string, unknown> } }
}

export interface FeishuSessionDeps {
  channel: SessionCardChannel
  bridge: () => HarnessConversationService | undefined
  sessionController?: SessionControllerLike
  workspaceRegistry?: WorkspaceRegistryLike
  logger: { warn(message: string): unknown; error(message: string): unknown }
}

export interface FeishuSessionHandle {
  /** Send the management panel card for one chat. */
  open(chat: ConversationMessage): Promise<string | undefined>
  stop(): void
}

type Op = 'switch' | 'detach' | 'rename' | 'archive' | 'fork'

interface OpenState {
  chat: ConversationMessage
}

interface ConfirmState {
  token: string
  chat: ConversationMessage
  op: Op
  sessionId: string
  sessionLabel: string
}

/** State for an in-flight rename card (name input + confirm). */
interface RenameState {
  chat: ConversationMessage
  sessionId: string
  sessionLabel: string
}

const OP_LABEL: Record<Op, string> = {
  switch: '切换', detach: 'detach', rename: '改名', archive: '归档', fork: 'fork',
}

/** Short display name for a session entry. */
function sessionLabel(entry: SessionEntry): string {
  const title = entry.title === '' ? entry.id.slice(-12) : entry.title.replace(/\s+/g, ' ').slice(0, 60)
  return title
}

/** Build the session dropdown options (name → id). */
function sessionOptions(sessions: readonly SessionEntry[]): Array<{ text: object; value: string }> {
  return sessions.map(entry => ({
    text: { tag: 'plain_text', content: sessionLabel(entry) },
    value: entry.id,
  }))
}

/** Render the management panel card. */
export function renderSessionPanelCard(
  sessions: readonly SessionEntry[],
  currentChatKey: string,
): object {
  const options = sessionOptions(sessions)
  const formElements: object[] = [
    { tag: 'markdown', content: '**选择会话**' },
    {
      tag: 'select_static',
      name: 'session',
      placeholder: { tag: 'plain_text', content: options.length > 0 ? '选择会话...' : '暂无会话' },
      options,
    },
    { tag: 'hr' },
    { tag: 'markdown', content: '**执行操作**' },
    ...buildOpButtons(),
  ]
  const locked = sessions.filter(s => s.ownedBy !== undefined && s.ownedBy !== currentChatKey).length
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🧭 会话管理' },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `共 ${sessions.length} 个会话${locked > 0 ? ` · ${locked} 个被占用` : ''}\n_选择会话后点下方按钮执行对应操作。_`,
        },
        { tag: 'hr' },
        { tag: 'form', name: 'session_panel', elements: formElements },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '📋 列表' },
          type: 'default',
          behaviors: [{ type: 'callback', value: { action: 'list' } }],
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🔄 刷新' },
          type: 'default',
          behaviors: [{ type: 'callback', value: { action: 'refresh' } }],
        },
      ],
    },
  }
}

/** Build the operation submit buttons (each carries its op). */
function buildOpButtons(): object[] {
  const ops: Array<{ op: Op; label: string; type?: 'primary' | 'danger' }> = [
    { op: 'switch', label: '🔀 切换', type: 'primary' },
    { op: 'detach', label: '🔓 detach' },
    { op: 'archive', label: '🗄️ 归档' },
    { op: 'fork', label: '🍴 fork' },
    { op: 'rename', label: '✏️ 改名' },
  ]
  return ops.map(({ op, label, type }) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: type ?? 'default',
    name: `op_${op}`,
    form_action_type: 'submit',
    behaviors: [{ type: 'callback', value: { action: op } }],
  }))
}

/** Render a confirm/cancel card for a destructive op. */
export function renderSessionConfirmCard(state: ConfirmState): object {
  const detail: Record<Op, string> = {
    switch: `将把这个对话切换到会话 \`${state.sessionLabel}\`，若它被其它对话占用会先接管。`,
    detach: `将释放会话 \`${state.sessionLabel}\` 的占用（原持有者重置为新会话）。`,
    archive: `将归档会话 \`${state.sessionLabel}\`。`,
    fork: `将从会话 \`${state.sessionLabel}\` fork 出一个新会话（保留到当前事件的对话）。`,
    rename: `将把会话 \`${state.sessionLabel}\` 改成新的标题。`,
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `确认${OP_LABEL[state.op]}？` },
      template: 'orange',
    },
    body: {
      elements: [
        { tag: 'markdown', content: detail[state.op] },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ 确认' },
          type: 'primary',
          behaviors: [{ type: 'callback', value: { action: 'confirm-ok', token: state.token } }],
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '❌ 取消' },
          type: 'default',
          behaviors: [{ type: 'callback', value: { action: 'confirm-cancel', token: state.token } }],
        },
      ],
    },
  }
}

/** Render a green result card. */
export function renderSessionResultCard(title: string, lines: readonly string[]): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'green' },
    body: { elements: [{ tag: 'markdown', content: lines.join('\n') }] },
  }
}

/** Render a rename card: text input + confirm submit (self-contained). */
export function renderSessionRenameCard(sessionLabel: string): object {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '✏️ 改名' }, template: 'blue' },
    body: {
      elements: [
        { tag: 'markdown', content: `为会话 \`${sessionLabel}\` 输入新标题：` },
        {
          tag: 'form',
          name: 'rename_form',
          elements: [
            { tag: 'input', name: 'new_title', placeholder: { tag: 'plain_text', content: '输入新的会话标题...' }, max_length: 200 },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 确认改名' },
              type: 'primary',
              name: 'confirm_rename',
              form_action_type: 'submit',
              behaviors: [{ type: 'callback', value: { action: 'rename-confirm' } }],
            },
          ],
        },
      ],
    },
  }
}

/** Render the `/session list` table card. */
export function renderSessionListCard(sessions: readonly SessionEntry[]): object {
  const rows = sessions.map(entry => {
    const owned = entry.ownedBy === undefined ? '-' : '🔒'
    return `| ${sessionLabel(entry)} | \`${entry.id.slice(-12)}\` | ${owned} | ${formatRelative(entry.updatedAt)} |`
  })
  const body = rows.length > 0
    ? `| 会话 | ID | 占用 | 最近活跃 |\n|---|---|---|---|\n${rows.join('\n')}`
    : '暂无会话。'
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '📋 会话列表' }, template: 'blue' },
    body: { elements: [{ tag: 'markdown', content: body }] },
  }
}

function formatRelative(updatedAt: number): string {
  const diff = Date.now() - updatedAt
  const m = Math.round(diff / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}m 前`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h 前`
  return `${Math.round(h / 24)}d 前`
}

/** Start the session panel: handle the panel + confirm card callbacks. */
export function startFeishuSession(deps: FeishuSessionDeps): FeishuSessionHandle {
  const { channel, bridge, sessionController, workspaceRegistry, logger } = deps
  const openCards = new Map<string, OpenState>()
  const confirmCards = new Map<string, ConfirmState>()
  const renameCards = new Map<string, RenameState>()

  const onCardAction = async (evt: SessionCardEvent): Promise<void> => {
    const messageId = evt.messageId
    if (messageId === undefined) return
    // Priority: a rename card overrides a confirm card overrides a panel card.
    const rename = renameCards.get(messageId)
    if (rename !== undefined) return void handleRename(evt, rename)
    const confirm = confirmCards.get(messageId)
    if (confirm !== undefined) return void handleConfirm(evt, confirm)
    const openState = openCards.get(messageId)
    if (openState !== undefined) return void handlePanel(evt, openState)
  }

  const handlePanel = async (evt: SessionCardEvent, state: OpenState): Promise<void> => {
    const brid = bridge()
    if (brid === undefined) return
    const parsed = decodeCardValue(evt.action?.value) ?? {}
    const action = typeof parsed.action === 'string' ? parsed.action : ''
    const formValue = (evt.raw?.action?.form_value ?? {}) as Record<string, unknown>
    const sessionId = typeof formValue.session === 'string' ? formValue.session : ''

    if (action === 'list') {
      const sessions = await brid.listSessions()
      await channel.send(state.chat.chatId, { card: renderSessionListCard(sessions) }, replyOpts(state.chat)).catch(() => undefined)
      return
    }
    if (action === 'refresh') {
      const sessions = await brid.listSessions()
      const key = conversationKey(state.chat)
      await channel.updateCard(evt.messageId!, renderSessionPanelCard(sessions, key)).catch((e: unknown) => {
        logger.warn(`dsh-feishu: session panel refresh failed: ${e instanceof Error ? e.message : String(e)}`)
      })
      return
    }
    if (sessionId === '') return
    const sessions = await brid.listSessions()
    const entry = sessions.find(s => s.id === sessionId)
    const label = entry === undefined ? sessionId.slice(-12) : sessionLabel(entry)
    const op = action as Op
    if (op !== 'switch' && op !== 'detach' && op !== 'rename' && op !== 'fork' && op !== 'archive') return

    if (op === 'rename') {
      // Rename pops its own dedicated input card instead of a confirm card.
      await openRename(state.chat, { sessionId, sessionLabel: label })
      return
    }
    if (op === 'switch') {
      // Free → attach directly. Occupied by another chat → confirm takeover.
      const key = conversationKey(state.chat)
      if (entry !== undefined && entry.ownedBy !== undefined && entry.ownedBy !== key) {
        await openConfirm(state.chat, { op: 'switch', sessionId, sessionLabel: label })
        return
      }
      await execOp(state.chat, { op: 'switch', sessionId, sessionLabel: label })
      return
    }
    await openConfirm(state.chat, { op, sessionId, sessionLabel: label })
  }

  const openRename = async (chat: ConversationMessage, state: Omit<RenameState, 'chat'>): Promise<void> => {
    const result = await channel.send(chat.chatId, { card: renderSessionRenameCard(state.sessionLabel) }, replyOpts(chat))
    const mid = result?.messageId
    if (mid !== undefined) renameCards.set(mid, { chat, ...state })
  }

  const handleRename = async (evt: SessionCardEvent, state: RenameState): Promise<void> => {
    renameCards.delete(evt.messageId!)
    const formValue = (evt.raw?.action?.form_value ?? {}) as Record<string, unknown>
    const title = typeof formValue.new_title === 'string' ? formValue.new_title.trim() : ''
    if (title === '') {
      await channel.updateCard(evt.messageId!, renderSessionResultCard('⚠️ 标题为空', ['请输入新的会话标题后再确认。'])).catch((e: unknown) => {
        logger.warn(`dsh-feishu: session rename title empty: ${e instanceof Error ? e.message : String(e)}`)
      })
      return
    }
    if (sessionController?.rename === undefined) {
      await channel.send(state.chat.chatId, { card: renderSessionResultCard('⚠️ 暂不可用', ['本部署未启用「改名」能力。']) }, replyOpts(state.chat)).catch(() => undefined)
      return
    }
    try {
      await sessionController.rename({ sessionId: state.sessionId, title })
      await channel.send(state.chat.chatId, { card: renderSessionResultCard('✅ 已改名', [`会话 \`${state.sessionLabel}\` 已改名为：\n\`\`\`\n${title}\n\`\`\``]) }, replyOpts(state.chat)).catch(() => undefined)
    } catch (e: unknown) {
      logger.error(`dsh-feishu: session rename failed: ${e instanceof Error ? e.message : String(e)}`)
      await channel.send(state.chat.chatId, { card: renderSessionResultCard('❌ 改名失败', [String(e instanceof Error ? e.message : e)]) }, replyOpts(state.chat)).catch(() => undefined)
    }
  }

  const openConfirm = async (chat: ConversationMessage, state: Omit<ConfirmState, 'token' | 'chat'>): Promise<void> => {
    const token = `session-c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const st: ConfirmState = { token, chat, ...state }
    const result = await channel.send(chat.chatId, { card: renderSessionConfirmCard(st) }, replyOpts(chat))
    const mid = result?.messageId
    if (mid !== undefined) confirmCards.set(mid, st)
  }

  const handleConfirm = async (evt: SessionCardEvent, state: ConfirmState): Promise<void> => {
    const parsed = decodeCardValue(evt.action?.value) ?? {}
    const confirm = parsed.action === 'confirm-ok'
    if (!confirm) {
      confirmCards.delete(evt.messageId!)
      await channel.updateCard(evt.messageId!, renderSessionResultCard('已取消', ['本次操作已取消。'])).catch((e: unknown) => {
        logger.warn(`dsh-feishu: session cancel update failed: ${e instanceof Error ? e.message : String(e)}`)
      })
      return
    }
    confirmCards.delete(evt.messageId!)
    await execOp(state.chat, { op: state.op, sessionId: state.sessionId, sessionLabel: state.sessionLabel })
  }

  const execOp = async (chat: ConversationMessage, st: { op: Op; sessionId: string; sessionLabel: string }): Promise<void> => {
    const brid = bridge()
    if (brid === undefined) return
    try {
      if (st.op === 'switch') {
        const outcome = brid.attachSession(chat, st.sessionId)
        if (outcome === 'archived') {
          await channel.send(chat.chatId, { card: renderSessionResultCard('⚠️ 已归档', [`会话 \`${st.sessionLabel}\` 已归档，无法切换。`]) }, replyOpts(chat)).catch(() => undefined)
          return
        }
        await channel.send(chat.chatId, { card: renderSessionResultCard('✅ 已切换', [`这个对话已切换到会话 \`${st.sessionLabel}\`。下一轮对话将使用它。`]) }, replyOpts(chat)).catch(() => undefined)
        return
      }
      if (st.op === 'detach') {
        const outcome = brid.detachSession(st.sessionId)
        const line = outcome.kind === 'free'
          ? `会话 \`${st.sessionLabel}\` 本就空闲。`
          : `已释放会话 \`${st.sessionLabel}\`（原持有者：${outcome.ownerLabel}）。`
        await channel.send(chat.chatId, { card: renderSessionResultCard('🔓 已 detach', [line]) }, replyOpts(chat)).catch(() => undefined)
        return
      }
      if (st.op === 'archive') {
        if (workspaceRegistry?.archiveSession === undefined) { await unsupported(chat, '归档'); return }
        await workspaceRegistry.archiveSession(st.sessionId)
        await channel.send(chat.chatId, { card: renderSessionResultCard('🗄️ 已归档', [`会话 \`${st.sessionLabel}\` 已归档。`]) }, replyOpts(chat)).catch(() => undefined)
        return
      }
      if (st.op === 'fork') {
        if (sessionController?.fork === undefined) { await unsupported(chat, 'fork'); return }
        const res = await sessionController.fork({ sessionId: st.sessionId }) as { sessionId?: string } | undefined
        await channel.send(chat.chatId, { card: renderSessionResultCard('🍴 已 fork', [`已从 \`${st.sessionLabel}\` fork 出新会话${res?.sessionId !== undefined ? ` \`${res.sessionId}\`` : ''}。可用「/new」或并在本面板中切换。`]) }, replyOpts(chat)).catch(() => undefined)
        return
      }
    } catch (e: unknown) {
      logger.error(`dsh-feishu: session op ${st.op} failed: ${e instanceof Error ? e.message : String(e)}`)
      await channel.send(chat.chatId, { card: renderSessionResultCard('❌ 操作失败', [String(e instanceof Error ? e.message : e)]) }, replyOpts(chat)).catch(() => undefined)
    }
  }

  const unsupported = async (chat: ConversationMessage, name: string): Promise<void> => {
    await channel.send(chat.chatId, { card: renderSessionResultCard('⚠️ 暂不可用', [`本部署未启用「${name}」能力。`]) }, replyOpts(chat)).catch(() => undefined)
  }

  const unsubscribe = channel.onCardAction(onCardAction)
  const open = async (chat: ConversationMessage): Promise<string | undefined> => {
    const brid = bridge()
    if (brid === undefined) return undefined
    const sessions = await brid.listSessions()
    const key = conversationKey(chat)
    const result = await channel.send(chat.chatId, { card: renderSessionPanelCard(sessions, key) }, replyOpts(chat))
    const mid = result?.messageId
    if (mid !== undefined) openCards.set(mid, { chat })
    return mid
  }
  const stop = (): void => {
    unsubscribe()
    openCards.clear()
    confirmCards.clear()
  }
  return { open, stop }
}

/** Reply options for a chat (topic-aware). */
function replyOpts(chat: ConversationMessage): { replyInThread?: boolean; replyTo?: string } {
  return chat.threadId !== undefined
    ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
    : {}
}
