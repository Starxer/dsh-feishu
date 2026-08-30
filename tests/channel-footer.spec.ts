import { describe, expect, it } from 'vitest'
import { renderFooterCard } from '../src/channel.ts'

function markdownOf(card: any): string {
  return card.body.elements
    .filter((el: any) => el.tag === 'markdown')
    .map((el: any) => el.content)
    .join('\n')
}

const turnStats = {
  turnStartTime: 0,
  stepCount: 3,
  toolCallCount: 2,
  totalInputTokens: 10,
  totalOutputTokens: 20,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  firstStepTtftMs: 100,
  totalDecodeMs: 500,
  totalStepMs: 600,
  totalToolMs: 300,
  totalTurnMs: 900,
}

describe('renderFooterCard (Turn Complete)', () => {
  it('shows the busy mode (queue) in the footer', () => {
    const card = renderFooterCard({ busyMode: 'queue' }, turnStats) as any
    expect(card.header.title.content).toBe('Turn Complete')
    expect(markdownOf(card)).toContain('**Enter while busy:** `queue` Queue 📥')
  })

  it('shows the busy mode (steer) in the footer', () => {
    const card = renderFooterCard({ busyMode: 'steer' }, turnStats) as any
    expect(markdownOf(card)).toContain('**Enter while busy:** `steer` Steer 🎯')
  })

  it('omits the busy line when busyMode is not provided', () => {
    const card = renderFooterCard({ model: 'm' }, turnStats) as any
    expect(markdownOf(card)).not.toContain('Enter while busy')
  })

  it('returns undefined when there is nothing to render', () => {
    expect(renderFooterCard(undefined, undefined)).toBeUndefined()
    expect(renderFooterCard({}, undefined)).toBeUndefined()
  })
})
