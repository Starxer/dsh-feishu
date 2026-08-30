import { describe, expect, it } from 'vitest'
import { decodeCardValue } from '../src/card-action.ts'

describe('decodeCardValue', () => {
  it('decodes a plain object value', () => {
    expect(decodeCardValue({ p: 'busy', mode: 'steer' })).toEqual({ p: 'busy', mode: 'steer' })
  })

  it('decodes a single-encoded string value', () => {
    expect(decodeCardValue(JSON.stringify({ p: 'busy', mode: 'queue' }))).toEqual({ p: 'busy', mode: 'queue' })
  })

  it('unwraps a double-encoded value (what Feishu actually delivers)', () => {
    const inner = JSON.stringify({ p: 'busy', mode: 'steer' })          // {"p":"busy","mode":"steer"}
    const delivered = JSON.stringify(inner)                             // "{\"p\":\"busy\",\"mode\":\"steer\"}"
    expect(decodeCardValue(delivered)).toEqual({ p: 'busy', mode: 'steer' })
  })

  it('unwraps deeper nesting up to the depth cap', () => {
    let v: unknown = { p: 'permission', mode: 'read-only' }
    for (let i = 0; i < 3; i++) v = JSON.stringify(v)
    expect(decodeCardValue(v)).toEqual({ p: 'permission', mode: 'read-only' })
  })

  it('returns undefined for non-JSON values', () => {
    expect(decodeCardValue('not json')).toBeUndefined()
    expect(decodeCardValue(undefined)).toBeUndefined()
    expect(decodeCardValue(123)).toBeUndefined()
    expect(decodeCardValue('{}')).toEqual({})
  })
})
