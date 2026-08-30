/**
 * Shared decoding of a Feishu card button's `action.value`.
 *
 * Feishu delivers a button `value` that itself is a JSON string, so the
 * `action.value` we receive is typically DOUBLE-encoded: the real payload is
 * `JSON.stringify`'d, then wrapped again as a JSON string. A single
 * `JSON.parse` therefore yields a string, not the object, and a naive
 * `parsed.p === 'busy'` check silently fails (the button appears to do
 * nothing). This helper unwraps repeatedly (up to a small depth) and returns
 * the innermost object, or `undefined` when the value is not JSON-decodable.
 *
 * @module @starxer/chatterbox4dsh/card-action
 */

/** Unpack a card button's `action.value` to a plain object. */
export function decodeCardValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string') return undefined
  try {
    let result: unknown = JSON.parse(value)
    let depth = 0
    while (typeof result === 'string' && depth < 4) {
      try {
        result = JSON.parse(result)
      } catch {
        return undefined
      }
      depth++
    }
    return typeof result === 'object' && result !== null ? result as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}
