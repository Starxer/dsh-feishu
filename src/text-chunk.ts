/**
 * Split long text into card-sized chunks. Feishu interactive cards truncate
 * content that overflows, so callers partition the model output into multiple
 * cards when it exceeds a per-card length budget.
 *
 * The splitter packs whole paragraphs into a chunk up to `maxLen`, breaking on
 * blank lines so markdown (and fenced code blocks, which are paragraphs of
 * their own) is never split mid-block unless a single paragraph is itself
 * longer than the budget. Content is preserved across chunks (no dropped
 * characters); only a cap on the number of chunks can collapse the tail into a
 * "... (continued)" marker.
 *
 * @module @starxer/chatterbox4dsh/text-chunk
 */

/**
 * Split `text` into up to `maxChunks` chunks each `contentLength` <= `maxLen`.
 * Returns `[]` for empty/whitespace text.
 *
 * @param text      The content to partition (already trimmed).
 * @param maxLen    Maximum characters per chunk (soft — a single paragraph
 *                  longer than `maxLen` is emitted alone).
 * @param maxChunks Hard cap on chunks; overflow collapses into a final
 *                  "... (continued)" marker so total cards stay bounded.
 */
export function chunkText(text: string, maxLen: number, maxChunks = 30): string[] {
  if (text.trim() === '') return []
  // Keep blank lines so paragraph boundaries survive the partition; a blank
  // line is its own paragraph but merges into the preceding one so that the
  // original `\n\n` separation is reproducible.
  const paragraphs = text.split('\n\n').flatMap(p => (p.trim() === '' ? [] : [p]))
  if (paragraphs.length === 0) return [text]

  const chunks: string[] = []
  let current: string[] = []
  let currentLen = 0

  const flush = (): void => {
    if (current.length === 0) return
    chunks.push(current.join('\n\n'))
    current = []
    currentLen = 0
  }

  for (const para of paragraphs) {
    const paraLen = para.length + 2 // `\n\n` joiners
    // If the paragraph alone exceeds the budget, flush current and hard-split
    // the paragraph on newlines so no single chunk blows the budget too far.
    if (para.length > maxLen) {
      flush()
      const lines = para.split('\n')
      let lineBuf: string[] = []
      let lineLen = 0
      for (const line of lines) {
        if (lineLen + line.length + 1 > maxLen && lineBuf.length > 0) {
          chunks.push(lineBuf.join('\n'))
          lineBuf = []
          lineLen = 0
        }
        lineBuf.push(line)
        lineLen += line.length + 1
      }
      if (lineBuf.length > 0) chunks.push(lineBuf.join('\n'))
      continue
    }
    if (currentLen + paraLen > maxLen) flush()
    current.push(para)
    currentLen += paraLen
  }
  flush()

  // Collapse overflow so the number of cards stays bounded.
  if (chunks.length > maxChunks) {
    const kept = chunks.slice(0, maxChunks)
    const overflowChars = chunks.slice(maxChunks).reduce((n, c) => n + c.length, 0)
    kept.push(`... (continued, ${overflowChars} more chars)`)
    return kept
  }
  return chunks
}

/**
 * Apply a hard per-card cap to a chunked list: truncate any chunk longer than
 * `maxLen` with an ellipsis (used when a single unbreakable token exceeds the
 * budget).
 */
export function capChunks(chunks: string[], maxLen: number): string[] {
  return chunks.map(c => (c.length > maxLen ? c.slice(0, maxLen) + '…' : c))
}

/** Default per-card character budget for Feishu markdown content. */
export const CARD_TEXT_MAX = 4000
