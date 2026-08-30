import { describe, expect, it } from 'vitest'
import { deriveToolSummary, renderStepCard } from '../src/feishu-streaming.ts'
import { translationsFor } from '../src/i18n.ts'

const t = translationsFor('zh')

function codeBlocksOf(card: any): string[] {
  return card.body.elements
    .filter((el: any) => el.tag === 'markdown')
    .map((el: any) => el.content)
    .filter((c: string) => c.startsWith('```') && c.endsWith('```'))
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
