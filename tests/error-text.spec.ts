import { describe, expect, it } from 'vitest'
import { errorText } from '../src/error-text.ts'

describe('errorText', () => {
  it('returns the Error message verbatim', () => {
    expect(errorText(new Error('File is 33934848 bytes, over Feishu limit'), 'fallback'))
      .toBe('File is 33934848 bytes, over Feishu limit')
  })

  it('appends a numeric error code when present', () => {
    const err = new Error('file is too large')
    ;(err as { code?: unknown }).code = 230021
    expect(errorText(err, 'fallback')).toBe('file is too large (code: 230021)')
  })

  it('appends a string error code when present', () => {
    const err = new Error('rate limited')
    ;(err as { code?: unknown }).code = '429'
    expect(errorText(err, 'fallback')).toBe('rate limited (code: 429)')
  })

  it('does not duplicate a code already inside the message', () => {
    const err = new Error('upstream reject code:230021')
    ;(err as { code?: unknown }).code = 230021
    expect(errorText(err, 'fallback')).toBe('upstream reject code:230021')
  })

  it('falls back when the error yields no detail', () => {
    expect(errorText(new Error('   '), '抱歉，处理这条消息时遇到了问题。')).toBe('抱歉，处理这条消息时遇到了问题。')
    expect(errorText(undefined, 'fallback')).toBe('fallback')
  })

  it('stringifies non-Error values', () => {
    expect(errorText('boom', 'fallback')).toBe('boom')
  })

  it('truncates very long messages to 600 chars', () => {
    const long = errorText(new Error('x'.repeat(1200)), 'fallback')
    expect(long).toHaveLength(601)
    expect(long.endsWith('…')).toBe(true)
  })
})
