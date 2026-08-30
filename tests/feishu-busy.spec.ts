import { describe, expect, it, vi } from 'vitest'
import { renderBusyCard, startFeishuBusy, BUSY_MODES } from '../src/feishu-busy.ts'
import type { BusyMode } from '../src/harness.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')

function buttonsOf(card: any): any[] {
  return card.body.elements.filter((el: any) => el.tag === 'button')
}

function textOf(button: any): string {
  return button?.text?.content ?? ''
}

describe('renderBusyCard', () => {
  it('shows the current mode and marks the active button disabled', () => {
    const card = renderBusyCard('steer', t) as any
    const markdown = card.body.elements.filter((el: any) => el.tag === 'markdown').map((el: any) => el.content).join('\n')
    expect(markdown).toContain('**运行中（busy）的 Enter 行为** `steer` Steer')
    expect(card.header.title.content).toBe('Enter while busy')
    const buttons = buttonsOf(card)
    expect(buttons).toHaveLength(2)
    const active = buttons.find((b: any) => textOf(b).startsWith('✓ '))
    expect(textOf(active)).toContain('Steer')
    expect(active.disabled).toBe(true)
  })

  it('marks the queue option by default value', () => {
    const card = renderBusyCard('queue', t) as any
    const active = buttonsOf(card).find((b: any) => textOf(b).startsWith('✓ '))
    expect(textOf(active)).toContain('Queue')
    expect(active.disabled).toBe(true)
  })
})

describe('startFeishuBusy', () => {
  it('sends the card on open and switches the mode on button click', async () => {
    const setMode = vi.fn()
    const getMode = vi.fn(() => 'steer' as BusyMode)
    const send = vi.fn(async () => ({ messageId: 'om_card' }))
    const updateCard = vi.fn(async () => undefined)
    let actionHandler: ((evt: any) => unknown) | undefined
    const handle = startFeishuBusy({
      channel: { send, updateCard, onCardAction: (h: any) => { actionHandler = h; return () => undefined } },
      getMode,
      setMode,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    const mid = await handle.open({ chatId: 'oc_1', chatType: 'p2p' })
    expect(mid).toBe('om_card')
    expect(send).toHaveBeenCalledTimes(1)
    // Click the "Queue" button.
    const card = ((send.mock.calls as any)[0][1] as any).card
    const queueBtn = buttonsOf(card).find((b: any) => textOf(b).includes('Queue ·'))
    await actionHandler!({ messageId: 'om_card', action: { value: queueBtn.value } })
    expect(setMode).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'oc_1' }), 'queue')
    expect(updateCard).toHaveBeenCalledTimes(1)

    handle.stop()
  })

  it('ignores unrelated card actions and stale cards', async () => {
    const setMode = vi.fn()
    let actionHandler: ((evt: any) => unknown) | undefined
    const handle = startFeishuBusy({
      channel: {
        send: vi.fn(async () => ({ messageId: 'om_card' })),
        updateCard: vi.fn(async () => undefined),
        onCardAction: (h: any) => { actionHandler = h; return () => undefined },
      },
      getMode: () => 'queue' as BusyMode,
      setMode,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)
    // Unrelated card (no p:'busy') must not switch.
    await actionHandler!({ messageId: 'om_card', action: { value: JSON.stringify({ p: 'other', mode: 'steer' }) } })
    // Unknown card id must not switch.
    await actionHandler!({ messageId: 'om_unknown', action: { value: JSON.stringify({ p: 'busy', mode: 'steer' }) } })
    expect(setMode).not.toHaveBeenCalled()
    handle.stop()
  })
})

expect(BUSY_MODES).toEqual(['queue', 'steer'])
