/**
 * Convert a caught `unknown` error into a concise, user-facing reason that can
 * be sent back into a Feishu chat. The plugin's default behaviour is to send a
 * unified apology (`errorMessage`) with no detail, which makes the user guess.
 * This extracts the actionable message and, when the error carries one, a
 * numeric error code (e.g. Feishu API business codes like 230021 for a file
 * that is too large), so the message tells the user exactly what went wrong.
 *
 * @module @starxer/chatterbox4dsh/error-text
 */

/**
 * Render a caught error as a short single-line reason for user display.
 *
 * - Uses `error.message` when the error is an `Error`; otherwise `String(error)`.
 * - Appends the error's numeric `code` (or string `code`) as `(code: N)` unless
 *   it already appears inside the message (avoiding "code:230021 (code: 230021)").
 * - Falls back to `fallback` when there is nothing useful to show.
 * - Truncates at 600 chars so the text never approaches the Feishu message cap.
 *
 * @param error the thrown value
 * @param fallback user-facing text used when no reason can be extracted
 * @returns a concise reason, never a stack trace
 */
export function errorText(error: unknown, fallback: string): string {
  let reason: string
  let code: string | undefined

  if (error instanceof Error) {
    reason = error.message.trim()
    const candidate = (error as { code?: unknown }).code
    if (typeof candidate === 'number') code = String(candidate)
    else if (typeof candidate === 'string' && candidate.trim() !== '') code = candidate.trim()
  } else if (error === undefined || error === null) {
    reason = ''
  } else {
    reason = String(error).trim()
  }

  if (code !== undefined && reason.includes(code)) code = undefined

  let detail = reason
  if (code !== undefined) {
    detail = detail === '' ? `error code ${code}` : `${detail} (code: ${code})`
  }
  if (detail === '') return fallback
  return detail.length > 600 ? `${detail.slice(0, 600)}…` : detail
}
