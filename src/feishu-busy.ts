/**
 * Interactive "Enter behavior while busy" picker card for the `/busy` Feishu
 * command.
 *
 * DSH's WebUI names this setting "Enter behavior while busy" (options Queue /
 * Steer: how a message sent while the agent is running is handled). This module
 * renders the Feishu equivalent: a card showing the current per-chat mode with
 * one button per option. Clicking a button switches the mode (persisted by the
 * bridge) and updates the card in place so the active mode is re-marked.
 *
 * The cardAction dispatcher is shared via the plugin's `cardChannel` adapter,
 * which rebinds handlers across channel reconnects; button clicks therefore
 * keep working even after a channel swap.
 *
 * @module @starxer/dsh-feishu/feishu-busy
 */

import type { ConversationMessage } from './conversation.ts'
import type { BusyMode } from './harness.ts'

/** Union of selectable busy behaviors (also the persisted values). */
export const BUSY_MODES: readonly BusyMode[] = ['queue', 'steer']

const BUSY_LABEL: Record<BusyMode, string> = { queue: 'Queue', steer: 'Steer' }
const BUSY_ICON: Record<BusyMode, string> = { queue: '📥', steer: '🎯' }
const BUSY_DESC: Record<BusyMode, string> = {
  queue: '当前轮结束后作为新轮运行（默认）',
  steer: '注入当前运行轮立即响应',
}

/** Narrow card-action event surface the picker consumes. */
export interface BusyCardEvent {
  messageId?: string
  chatId?: string
  action?: { value?: unknown }
}

/** The shared cardChannel's minimal surface (send / update / subscribe). */
export interface BusyCardChannel {
  send(to: string, input: { card: object }, opts?: { replyInThread?: boolean; replyTo?: string }): Promise<{ messageId?: string }>
  updateCard(messageId: string, card: object): Promise<void>
  onCardAction(handler: (evt: BusyCardEvent) => void | Promise<void>): () => void
}

export interface FeishuBusyDeps {
  channel: BusyCardChannel
  /** Read the current per-chat busy mode (topics are keyed the same way). */
  getMode: (chat: ConversationMessage) => BusyMode
  /** Persist a new per-chat busy mode. */
  setMode: (chat: ConversationMessage, mode: BusyMode) => void
  logger: { warn(message: string): unknown; error(message: string): unknown }
}

export interface FeishuBusyHandle {
  /** Send the interactive picker card for one chat and remember it so button
   *  clicks can switch the mode. Returns the sent message id. */
  open(chat: ConversationMessage): Promise<string | undefined>
  stop(): void
}

/** Render the busy picker card with the active mode marked. */
export function renderBusyCard(current: BusyMode): object {
  const elements: object[] = [
    { tag: 'markdown', content: `**运行中（busy）的 Enter 行为：** \`${current}\` ${BUSY_LABEL[current]} ${BUSY_ICON[current]}` },
    { tag: 'markdown', content: '_点击下方按钮切换本聊天在 agent 运行中收到消息时的处理方式（对齐 WebUI「Enter behavior while busy」）。已持久化，重启后保留。_' },
  ]
  for (const mode of BUSY_MODES) {
    const active = mode === current
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `${active ? '✓ ' : ''}${BUSY_LABEL[mode]} · ${BUSY_DESC[mode]}` },
      type: mode === 'steer' ? 'primary' : 'default',
      value: JSON.stringify({ p: 'busy', mode }),
      ...(active ? { disabled: true } : {}),
    })
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Enter while busy' }, template: 'turquoise' },
    body: { elements },
  }
}

/** Start the busy picker: send cards on demand and handle button clicks. */
export function startFeishuBusy(deps: FeishuBusyDeps): FeishuBusyHandle {
  const { channel, getMode, setMode, logger } = deps
  const byCard = new Map<string, ConversationMessage>()

  const onCardAction = async (evt: BusyCardEvent): Promise<void> => {
    const messageId = evt.messageId
    if (messageId === undefined) return
    const chat = byCard.get(messageId)
    if (chat === undefined) return
    let parsed: { p?: unknown; mode?: unknown }
    try {
      parsed = JSON.parse(String(evt.action?.value ?? ''))
    } catch {
      return
    }
    if (parsed.p !== 'busy') return
    if (parsed.mode !== 'queue' && parsed.mode !== 'steer') return
    setMode(chat, parsed.mode)
    await channel.updateCard(messageId, renderBusyCard(parsed.mode)).catch((error: unknown) => {
      logger.warn(`dsh-feishu: busy card update failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const unsubscribe = channel.onCardAction(onCardAction)

  const open = async (chat: ConversationMessage): Promise<string | undefined> => {
    const current = getMode(chat)
    const opts = chat.threadId !== undefined
      ? { replyInThread: true, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
      : {}
    const result = await channel.send(chat.chatId, { card: renderBusyCard(current) }, opts)
    const messageId = result.messageId
    if (messageId !== undefined) byCard.set(messageId, chat)
    return messageId
  }

  const stop = (): void => {
    unsubscribe()
    byCard.clear()
  }

  return { open, stop }
}
