import { describe, expect, it, vi } from 'vitest'
import {
  renderSessionPanelCard, renderSessionListCard, renderSessionConfirmCard,
  startFeishuSession, type SessionEntry,
} from '../src/feishu-session.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')

const SESSIONS: SessionEntry[] = [
  { id: 's1', updatedAt: Date.now(), title: 'Fix the bug', ownedBy: 'chat:a', agentPreset: 'PTC 模式' },
  { id: 's2', updatedAt: Date.now() - 60000, title: 'Write docs' },
  { id: 's3', updatedAt: Date.now() - 120000, title: '', agentPreset: 'Creator 模式' },
]

function markdownOf(card: any): string {
  return card.body.elements
    .filter((el: any) => el.tag === 'markdown')
    .map((el: any) => el.content)
    .join('\n')
}

function buildChannel(harness: any) {
  const unsubFns: Array<() => void> = []
  return {
    channel: {
      send: vi.fn(async (to: string, input: any) => {
        if (input.card !== undefined) harness.sentCards.push({ to, card: input.card, input })
        return { messageId: 'om_card' }
      }),
      updateCard: vi.fn(async () => undefined),
      onCardAction: (handler: (evt: unknown) => void | Promise<void>) => {
        harness.cardActionHandler = handler
        const u = () => { harness.cardActionHandler = undefined }
        unsubFns.push(u)
        return u
      },
    },
    cleanup: () => { for (const u of unsubFns) u() },
  }
}

describe('renderSessionPanelCard', () => {
  it('renders a session dropdown and all five op buttons', () => {
    const card = renderSessionPanelCard(SESSIONS, 'chat:z', t) as any
    expect(markdownOf(card)).toContain('共 3 个会话')
    expect(markdownOf(card)).toContain('1 个被占用')
    const forms = card.body.elements.filter((el: any) => el.tag === 'form')
    expect(forms).toHaveLength(1)
    const selects = forms[0].elements.filter((el: any) => el.tag === 'select_static')
    expect(selects).toHaveLength(1)
    expect(selects[0].options).toHaveLength(3)
    const opButtons = forms[0].elements.filter((el: any) => el.tag === 'button')
    const labels = opButtons.map((b: any) => b.text?.content)
    expect(labels).toEqual(expect.arrayContaining(['🔀 切换', '🔓 Detach', '🗄️ 归档', '🍴 派生', '✏️ 改名']))
  })

  it('renders an empty state when there are no sessions', () => {
    const card = renderSessionPanelCard([], 'chat:a', t) as any
    expect(markdownOf(card)).toContain('共 0 个会话')
  })
})

describe('renderSessionListCard', () => {
  it('renders a markdown table of sessions', () => {
    const card = renderSessionListCard(SESSIONS, t) as any
    const md = markdownOf(card)
    expect(md).toContain('| 会话 | ID | 预设 | 占用 | 最近活跃 |')
    expect(md).toContain('Fix the bug')
    expect(md).toContain('🔒') // owned by another chat
    // Agent preset column: shows the display name, and '-' when unknown.
    expect(md).toContain('PTC 模式')
    expect(md).toContain('Creator 模式')
    expect(md).toMatch(/\| Write docs.*\| - \|/)
  })
})

describe('renderSessionConfirmCard', () => {
  it('renders the op detail with confirm/cancel buttons', () => {
    const card = renderSessionConfirmCard({
      token: 't1', chat: { chatId: 'oc_x', chatType: 'p2p' }, op: 'rename',
      sessionId: 's1', sessionLabel: 'Fix the bug',
    }, t) as any
    expect(markdownOf(card)).toContain('将把会话')
    expect(markdownOf(card)).toContain('Fix the bug')
  })
})

describe('startFeishuSession', () => {
  it('open sends the panel and a free switch still asks for confirm first', async () => {
    const harness: any = { sentCards: [], cardActionHandler: undefined }
    const attachSession = vi.fn(() => 'ok' as const)
    const bridge = {
      listSessions: vi.fn(async () => SESSIONS),
      attachSession,
      detachSession: vi.fn(() => ({ kind: 'free' as const })),
      describeChatKey: vi.fn((k: string) => k),
    }
    const { channel, cleanup } = buildChannel(harness)
    const handle = startFeishuSession({
      channel: channel as any,
      bridge: () => bridge as any,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    })
    try {
      await handle.open({ chatId: 'oc_x', chatType: 'p2p' })
      expect(harness.sentCards).toHaveLength(1)
      // Simulate: pick session s2 (free) and click 切换 → must confirm first.
      await harness.cardActionHandler!({
        messageId: 'om_card',
        action: { value: { action: 'switch' } },
        raw: { action: { form_value: { session: 's2' } } },
      })
      // No direct attach yet: a confirm card is sent instead.
      expect(attachSession).not.toHaveBeenCalled()
      // Card actions resolve fire-and-forget; let the confirm card land.
      await new Promise((resolve) => setImmediate(resolve))
      const confirmCard = harness.sentCards[1].card
      expect(confirmCard.header.title.content).toContain('切换')
      // Confirm the takeover → attach happens (the channel mock returns 'om_card' for every card).
      await harness.cardActionHandler!({
        messageId: 'om_card',
        action: { value: { action: 'confirm-ok' } },
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(attachSession).toHaveBeenCalledWith({ chatId: 'oc_x', chatType: 'p2p' }, 's2')
      const last = harness.sentCards[harness.sentCards.length - 1]
      expect(last.card.header.title.content).toBe('✅ 已切换')
    } finally {
      handle.stop()
      cleanup()
    }
  })

  it('an occupied switch asks for a takeover confirm first', async () => {
    const harness: any = { sentCards: [], cardActionHandler: undefined }
    const attachSession = vi.fn(() => 'ok' as const)
    const bridge = {
      listSessions: vi.fn(async () => SESSIONS),
      attachSession,
      detachSession: vi.fn(() => ({ kind: 'free' as const })),
      describeChatKey: vi.fn((k: string) => k),
    }
    const { channel, cleanup } = buildChannel(harness)
    const handle = startFeishuSession({
      channel: channel as any,
      bridge: () => bridge as any,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    })
    try {
      await handle.open({ chatId: 'oc_x', chatType: 'p2p' })
      await harness.cardActionHandler!({
        messageId: 'om_card',
        action: { value: { action: 'switch' } },
        raw: { action: { form_value: { session: 's1' } } }, // s1 owned by chat:a
      })
      // Card actions resolve fire-and-forget; let the confirm card land.
      await new Promise((resolve) => setImmediate(resolve))
      // No direct attach; a confirm card was sent.
      expect(attachSession).not.toHaveBeenCalled()
      const confirmCard = harness.sentCards[1].card
      expect(confirmCard.header.title.content).toBe('确认切换？')
      // Confirm the takeover.
      await harness.cardActionHandler!({
        messageId: 'om_card',
        action: { value: { action: 'confirm-ok' } },
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(attachSession).toHaveBeenCalled()
    } finally {
      handle.stop()
      cleanup()
    }
  })

  it('rename pops a dedicated rename card and confirms with the typed title', async () => {
    const harness: any = { sentCards: [], cardActionHandler: undefined }
    const bridge = {
      listSessions: vi.fn(async () => SESSIONS),
      attachSession: vi.fn(() => 'ok' as const),
      detachSession: vi.fn(() => ({ kind: 'free' as const })),
      describeChatKey: vi.fn((k: string) => k),
    }
    const rename = vi.fn(async () => undefined)
    const { channel, cleanup } = buildChannel(harness)
    const handle = startFeishuSession({
      channel: channel as any,
      bridge: () => bridge as any,
      sessionController: { rename, fork: vi.fn() },
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    })
    try {
      await handle.open({ chatId: 'oc_x', chatType: 'p2p' })
      await harness.cardActionHandler!({
        messageId: 'om_card',
        action: { value: { action: 'rename' } },
        raw: { action: { form_value: { session: 's2' } } },
      })
      await new Promise((resolve) => setImmediate(resolve))
      // A dedicated rename card (header '✏️ 重命名会话') was sent, not a confirm card.
      const renameCard = harness.sentCards[1].card
      expect(renameCard.header.title.content).toBe('✏️ 重命名会话')
      expect(rename).not.toHaveBeenCalled()
      // Submit the typed title through the rename form.
      await harness.cardActionHandler!({
        messageId: 'om_card',
        action: { value: { action: 'rename-confirm' } },
        raw: { action: { form_value: { new_title: 'A better name' } } },
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(rename).toHaveBeenCalledWith({ sessionId: 's2', title: 'A better name' })
    } finally {
      handle.stop()
      cleanup()
    }
  })
})
