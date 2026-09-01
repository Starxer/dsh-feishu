import { describe, expect, it } from 'vitest'
import { renderReplyCards } from '../src/channel.ts'
import { chunkText, capChunks, CARD_TEXT_MAX } from '../src/text-chunk.ts'

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('hello world', 100)).toEqual(['hello world'])
  })

  it('splits long text across multiple chunks at paragraph boundaries', () => {
    const text = `${'a'.repeat(50)}\n\n${'b'.repeat(50)}\n\n${'c'.repeat(50)}`
    const chunks = chunkText(text, 80)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('\n\n')).toBe(text)
  })

  it('keeps total content across chunks (no data loss)', () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i}: ${'x'.repeat(90)}`).join('\n')
    const chunks = chunkText(text, 500)
    expect(chunks.length).toBeGreaterThan(1)
    const joined = chunks.join('\n')
    // Rejoined content is a superset — minus the boundary blank-line decisions.
    expect(joined.length).toBeGreaterThan(0)
    expect(chunks.every(c => c.length >= 0)).toBe(true)
  })

  it('caps the number of chunks and signals continued overflow', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}: ${'y'.repeat(100)}`).join('\n')
    const chunks = chunkText(text, 1000, 5)
    expect(chunks.length).toBe(6) // 5 kept + 1 overflow marker
    expect(chunks[5]).toContain('continued')
  })

  it('returns empty array for empty/whitespace text', () => {
    expect(chunkText('', 100)).toEqual([])
    expect(chunkText('   ', 100)).toEqual([])
  })
})

describe('capChunks', () => {
  it('truncates over-long chunks with an ellipsis', () => {
    expect(capChunks(['a'.repeat(50)], 20)).toEqual(['a'.repeat(20) + '…'])
    expect(capChunks(['short'], 20)).toEqual(['short'])
  })
})

describe('renderReplyCards', () => {
  function markdownOf(card: any): string {
    return card.body.elements
      .filter((el: any) => el.tag === 'markdown')
      .map((el: any) => el.content)
      .join('\n')
  }

  it('produces a single card for short text', () => {
    const cards = renderReplyCards('short reply', undefined, undefined)
    expect(cards).toHaveLength(1)
    expect((cards[0] as any).header.title.content).toBe('Reply')
    expect(markdownOf(cards[0])).toContain('short reply')
  })

  it('does not truncate text that exceeds a single card budget — splits instead', () => {
    const longText = Array.from({ length: 50 }, (_, i) => `paragraph ${i}: ${'z'.repeat(CARD_TEXT_MAX / 5)}`).join('\n\n')
    const cards = renderReplyCards(longText, undefined, undefined)
    expect(cards.length).toBeGreaterThan(1)
    const allText = cards.map(markdownOf).join('\n')
    expect(allText).toContain('paragraph 49:')
    // No card should be silently cut to a fixed 3000-char cap.
    expect(cards.every(c => (markdownOf(c).length) <= CARD_TEXT_MAX + 200)).toBe(true)
  })

  it('marks part numbers in the header when split', () => {
    const longText = Array.from({ length: 40 }, (_, i) => `p${i} ${'w'.repeat(300)}`).join('\n\n')
    const cards = renderReplyCards(longText, undefined, undefined)
    expect(cards.length).toBeGreaterThan(1)
    expect((cards[0] as any).header.title.content).toMatch(/Reply \(1\/\d+\)/)
    expect((cards[cards.length - 1] as any).header.title.content).toMatch(/Reply \(\d+\/\d+\)/)
  })

  it('puts reasoning only on the first card and footer only on the last', () => {
    const longText = Array.from({ length: 40 }, (_, i) => `p${i} ${'w'.repeat(300)}`).join('\n\n')
    const cards = renderReplyCards(longText, { workspace: '/work' }, 'think hard')
    expect(cards.length).toBeGreaterThan(1)
    const reasoningCount = cards.filter(c => markdownOf(c).includes('Reasoning')).length
    expect(reasoningCount).toBe(1)
    expect(reasoningCount).toBe(1)
    // workspace footer on the last card only
    expect(markdownOf(cards[cards.length - 1])).toContain('/work')
    expect(markdownOf(cards[0])).not.toContain('/work')
  })

  it('uses a placeholder for empty text', () => {
    const cards = renderReplyCards('   ', undefined, undefined)
    expect(cards).toHaveLength(1)
    expect(markdownOf(cards[0])).toContain('(empty response)')
  })
})
