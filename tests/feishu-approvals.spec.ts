import { describe, expect, it } from 'vitest'
import { renderApprovalCard } from '../src/feishu-approvals.ts'

function entry(overrides: Record<string, unknown> = {}) {
  return {
    pendingId: 'feishu-a-abc123',
    approvalId: 'feishu-a-abc123',
    sessionId: 'session-1',
    chat: { chatId: 'oc_1', chatType: 'p2p' as const },
    toolName: 'bash',
    shortCode: 'abc123',
    createdAt: Date.now(),
    resolve: () => undefined,
    ...overrides,
  } as any
}

function elementsOf(card: any): any[] {
  return card.body.elements
}

function buttonTexts(elements: any[]): string[] {
  return elements.filter(el => el.tag === 'button').map(el => el.text.content)
}

describe('renderApprovalCard', () => {
  it('shows the asker-provided reason on the card', () => {
    const card = renderApprovalCard(entry({ reason: 'Run npm build in the workspace' }))
    const content = elementsOf(card)
      .filter(el => el.tag === 'markdown')
      .map(el => el.content)
      .join('\n')
    expect(content).toContain('**Reason:** Run npm build in the workspace')
  })

  it('omits the reason line when none is provided', () => {
    const card = renderApprovalCard(entry())
    const content = elementsOf(card)
      .filter(el => el.tag === 'markdown')
      .map(el => el.content)
      .join('\n')
    expect(content).not.toContain('**Reason:**')
    expect(content).toContain('**Tool:** `bash`')
  })

  it('orders Approve (primary) above Reject (danger)', () => {
    const card = renderApprovalCard(entry())
    const buttons = elementsOf(card).filter(el => el.tag === 'button')
    expect(buttons[0].text.content).toBe('Approve once')
    expect(buttons[0].type).toBe('primary')
    expect(buttons[1].text.content).toBe('Reject')
    expect(buttons[1].type).toBe('danger')
    expect(buttonTexts(elementsOf(card))).toEqual(['Approve once', 'Reject'])
  })
})
