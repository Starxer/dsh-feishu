import { describe, expect, it, vi } from 'vitest'
import { renderPermissionCard, startFeishuPermission, PERMISSION_LABELS, SANDBOX_MODES } from '../src/feishu-permission.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('en')

function buttonsOf(card: any): any[] {
  return card.body.elements.filter((el: any) => el.tag === 'button')
}

describe('renderPermissionCard', () => {
  it('shows the current mode and marks the active button disabled', () => {
    const card = renderPermissionCard('workspace-write', t) as any
    const markdown = card.body.elements.filter((el: any) => el.tag === 'markdown').map((el: any) => el.content).join('\n')
    expect(markdown).toContain('**Current permission mode:** `workspace-write` Workspace Write')
    const buttons = buttonsOf(card)
    expect(buttons).toHaveLength(3)
    const active = buttons.find((b: any) => textOf(b).startsWith('✓ '))
    expect(textOf(active)).toBe('✓ Workspace Write')
    expect(active.disabled).toBe(true)
  })

  it('renders Full access as danger and Read Only as default', () => {
    const card = renderPermissionCard('read-only', t) as any
    const buttons = buttonsOf(card)
    const full = buttons.find((b: any) => textOf(b).includes('Full access'))
    const readOnly = buttons.find((b: any) => textOf(b).includes('Read Only'))
    expect(full.type).toBe('danger')
    expect(readOnly.type).toBe('default')
  })
})

describe('startFeishuPermission', () => {
  it('sends the card on open and switches on button click', async () => {
    const append = vi.fn()
    const session = { append }
    const send = vi.fn(async () => ({ messageId: 'om_card' }))
    const updateCard = vi.fn(async () => undefined)
    let actionHandler: ((evt: any) => unknown) | undefined
    const resolve = vi.fn(({ session }: any) => ({ mode: (session as any).events?.first ?? 'workspace-write' }))
    const sandbox = { resolve }
    const handle = startFeishuPermission({
      channel: { send, updateCard, onCardAction: (h: any) => { actionHandler = h; return () => undefined } },
      sandbox,
      sessionGetter: () => session,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)

    const mid = await handle.open({ chatId: 'oc_1', chatType: 'p2p' }, 'session-1')
    expect(mid).toBe('om_card')
    expect(send).toHaveBeenCalledTimes(1)
    // Click the "Full access" button.
    const card = ((send.mock.calls as any)[0][1] as any).card
    const full = buttonsOf(card).find((b: any) => textOf(b).includes('Full access'))
    await actionHandler!({ messageId: 'om_card', action: { value: full.value } })
    expect(append).toHaveBeenCalledWith('sandbox/mode', { mode: 'danger-full-access' })
    expect(updateCard).toHaveBeenCalledTimes(1)

    handle.stop()
  })

  it('ignores unrelated card actions and stale cards', async () => {
    const append = vi.fn()
    const session = { append }
    let actionHandler: ((evt: any) => unknown) | undefined
    const handle = startFeishuPermission({
      channel: {
        send: vi.fn(async () => ({ messageId: 'om_card' })),
        updateCard: vi.fn(async () => undefined),
        onCardAction: (h: any) => { actionHandler = h; return () => undefined },
      },
      sandbox: { resolve: () => ({ mode: 'workspace-write' }) },
      sessionGetter: () => session,
      logger: { warn: vi.fn(), error: vi.fn() },
      getTranslations: () => t,
    } as any)
    // Unrelated card (no p:'permission') must not switch.
    await actionHandler!({ messageId: 'om_card', action: { value: JSON.stringify({ p: 'other', mode: 'x' }) } })
    // Unknown card id must not switch.
    await actionHandler!({ messageId: 'om_unknown', action: { value: JSON.stringify({ p: 'permission', mode: 'read-only' }) } })
    expect(append).not.toHaveBeenCalled()
    handle.stop()
  })
})

function textOf(button: any): string {
  return button?.text?.content ?? ''
}

// Keep SANDBOX_MODES / PERMISSION_LABELS referenced so tree-shaking keeps the
// alignment with the plugin's imported symbols obvious in this spec.
expect(SANDBOX_MODES).toContain('danger-full-access')
expect(PERMISSION_LABELS['danger-full-access']).toBe('Full access')
