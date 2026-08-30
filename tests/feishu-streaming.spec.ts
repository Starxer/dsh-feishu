import { describe, expect, it } from 'vitest'
import { deriveToolSummary, renderStepCard } from '../src/feishu-streaming.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')

function codeBlocksOf(card: any): string[] {
  return card.body.elements
    .filter((el: any) => el.tag === 'markdown')
    .map((el: any) => el.content)
    // A fenced block now carries a label line before the fence (e.g. "⚙️ 参数"),
    // so match on the fence presence rather than block start.
    .filter((c: string) => c.includes('```'))
}

function mdOf(card: any): string {
  return card.body.elements
    .filter((el: any) => el.tag === 'markdown')
    .map((el: any) => el.content)
    .join('\n')
}

describe('renderStepCard tool result/args rendering', () => {
  it('falls back to the raw result when a matched card view has no content', () => {
    // bash terminal view without `output` → must still show the raw result.
    const card = renderStepCard(t, undefined, undefined, [{
      toolName: 'bash', callId: 'c1', arguments: '{"command":"ls"}', startedAt: 0,
      result: { isError: false, content: 'out.txt\nin.txt', elapsed: 12 },
      resultView: { card: 'terminal' },
    }]) as any
    const blocks = codeBlocksOf(card)
    expect(blocks.some(b => b.includes('out.txt'))).toBe(true)
  })

  it('renders args in a fenced code block, tolerating backticks', () => {
    const card = renderStepCard(t, undefined, undefined, [{
      toolName: 'bash', callId: 'c1', arguments: '{"command":"echo `x`"}', startedAt: 0,
      result: { isError: false, content: 'ok', elapsed: 5 },
      resultView: { card: 'terminal', output: 'ok' },
    }]) as any
    const blocks = codeBlocksOf(card)
    const argsBlock = blocks.find(b => b.includes('echo'))
    expect(argsBlock).toBeDefined()
    expect(argsBlock).toContain('echo `x`')
    // Each fenced block carries its own label so args and result are distinct.
    expect(argsBlock).toContain('**⚙️ 参数**')
  })

  it('labels both the args and result code blocks', () => {
    const card = renderStepCard(t, undefined, undefined, [{
      toolName: 'bash', callId: 'c1', arguments: '{"command":"ls"}', startedAt: 0,
      result: { isError: false, content: 'out.txt\nin.txt', elapsed: 12 },
      resultView: { card: 'terminal', output: 'out.txt\nin.txt' },
    }]) as any
    const md = mdOf(card)
    expect(md).toContain('**⚙️ 参数**')
    expect(md).toContain('**📤 结果**')
    // Result label appears before the output text.
    expect(md.indexOf('**📤 结果**')).toBeLessThan(md.indexOf('out.txt'))
  })

  it('shows raw content when the tool meta carries no card/shape (the real bash case)', () => {
    // Real tool `meta` is `{ viewport, waitReason, sessionStatus, truncated }`
    // — no `card`, and the raw content is the authoritative display source.
    const card = renderStepCard(t, undefined, undefined, [{
      toolName: 'bash', callId: 'c1', arguments: '{"command":"ls"}', startedAt: 0,
      result: { isError: false, content: 'out.txt\nin.txt', elapsed: 12 },
      resultView: { viewport: { rows: 24 }, waitReason: 'exited', sessionStatus: 0 },
    }]) as any
    const blocks = codeBlocksOf(card)
    expect(blocks.some(b => b.includes('out.txt'))).toBe(true)
  })

  it('renders a read-shaped meta as a line-numbered block', () => {
    const card = renderStepCard(t, undefined, undefined, [{
      toolName: 'read', callId: 'c1', arguments: '{"path":"/a"}', startedAt: 0,
      result: { isError: false, content: '12│ b', elapsed: 1 },
      resultView: { path: '/a', lines: [{ number: 12, text: 'b' }], lang: 'ts' },
    }]) as any
    const blocks = codeBlocksOf(card)
    expect(blocks.some(b => b.includes('12│ b'))).toBe(true)
  })

  it('renders an edit-shaped meta as a before/after diff block', () => {
    const card = renderStepCard(t, undefined, undefined, [{
      toolName: 'edit', callId: 'c1', arguments: '{"file_path":"/a"}', startedAt: 0,
      result: { isError: false, content: 'a -> b', elapsed: 1 },
      resultView: { diffs: [{ path: '/a', oldText: 'foo', newText: 'bar' }] },
    }]) as any
    const md = card.body.elements
      .filter((el: any) => el.tag === 'markdown')
      .map((el: any) => el.content)
      .join('\n')
    expect(md).toContain('- foo')
    expect(md).toContain('+ bar')
  })
})


describe('deriveToolSummary', () => {
  it('bash uses description, falling back to command', () => {
    expect(deriveToolSummary('bash', JSON.stringify({ description: 'List notes', command: 'ls' }))).toBe('List notes')
    expect(deriveToolSummary('bash', JSON.stringify({ command: 'pwd' }))).toBe('pwd')
  })

  it('maps pwsh to the bash summary keys', () => {
    expect(deriveToolSummary('pwsh', JSON.stringify({ command: 'Get-ChildItem' }))).toBe('Get-ChildItem')
  })

  it('search joins multiple queries', () => {
    expect(deriveToolSummary('web_search', JSON.stringify({ queries: ['foo', 'bar'] }))).toBe('foo, bar')
  })

  it('search falls back to a single query', () => {
    expect(deriveToolSummary('grep', JSON.stringify({ query: 'TODO' }))).toBe('TODO')
  })

  it('file tools use the path', () => {
    expect(deriveToolSummary('read', JSON.stringify({ path: 'src/index.ts' }))).toBe('src/index.ts')
    expect(deriveToolSummary('write', JSON.stringify({ file_path: 'a.txt' }))).toBe('a.txt')
    expect(deriveToolSummary('edit', JSON.stringify({ path: 'b.md' }))).toBe('b.md')
  })

  it('code uses description', () => {
    expect(deriveToolSummary('run_code', JSON.stringify({ code: 'console.log(1)', description: 'print one' }))).toBe('print one')
  })

  it('unknown tools prefix the tool name with the first string field', () => {
    expect(deriveToolSummary('my_custom_tool', JSON.stringify({ what: 'do the thing' }))).toBe('my_custom_tool · do the thing')
  })

  it('titled tools (e.g. cordis_run) do not prefix the tool name', () => {
    expect(deriveToolSummary('cordis_run', JSON.stringify({ package: 'pkg' }))).toBe('pkg')
  })

  it('non-JSON args fall back to the first line of the raw string', () => {
    expect(deriveToolSummary('bash', 'not json\nsecond line')).toBe('not json')
  })

  it('todo_write yields task counts instead of raw JSON', () => {
    const args = JSON.stringify({ todos: [
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'in_progress' },
      { content: 'd', status: 'completed' },
    ] })
    expect(deriveToolSummary('todo_write', args)).toBe('待办清单：4 项 · 进行中 2 · 待办 1 · 完成 1')
  })

  it('empty or non-string args fall back to the raw text', () => {
    expect(deriveToolSummary('bash', '')).toBe('')
    expect(deriveToolSummary('bash', '{"a":1}')).toBe('{"a":1}')
  })
})
