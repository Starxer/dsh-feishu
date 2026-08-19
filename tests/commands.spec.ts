import { describe, expect, it, vi } from 'vitest'
import { registerLarkCommands, type CommandTranslations } from '../src/commands.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'

const translations: CommandTranslations = {
  modelDescription: 'model desc',
  modelCurrentHeader: 'Current:',
  modelUsage: 'Usage: /model',
  modelListHeader: 'Available:',
  modelListEmpty: 'none',
  modelSearchHeader: (keyword, count) => `Matches for "${keyword}" (${count}):`,
  modelSearchEmpty: keyword => `No models match "${keyword}".`,
  modelSearchItem: (index, provider, model, isCurrent) => `${index}. ${provider}/${model}${isCurrent ? ' <- current' : ''}`,
  modelSwitched: (provider, model) => `switched ${provider}/${model}`,
  modelUnknown: route => `unknown ${route}`,
  compactDescription: 'compact desc',
  compactUsage: 'Usage: /compact',
  compactNoHistory: 'no history',
  compactSucceeded: (count, tokens) => `compacted ${count} (${tokens})`,
  compactBusy: 'busy',
  compactCancelled: 'cancelled',
  compactChanged: 'changed',
  stopDescription: 'stop desc',
  stopUsage: 'Usage: /stop',
  stopCancelled: 'cancelled the turn',
  stopIdle: 'idle',
}

interface Registration { name: string; handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult> }

function fakeContext(): { ctx: Context; registered: Registration[]; dispose: () => void } {
  const registered: Registration[] = []
  const ctx = {
    commands: {
      register: (definition: Registration) => {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    effect: (fn: unknown, _label: string) => {
      // Effects in real cordis run generator functions lazily. This fake
      // simply walks the generator to completion so registration lands
      // synchronously for assertions.
      const iterator = (fn as () => Generator<unknown, void, unknown>)()
      let next = iterator.next()
      while (!next.done) {
        next = iterator.next(undefined)
      }
    },
  } as unknown as Context
  return {
    ctx,
    registered,
    dispose: () => { registered.length = 0 },
  }
}

function fakeAgent() {
  return { session: { id: 'a' }, status: 'idle', cancel: vi.fn() } as unknown as CommandInvocation['agent']
}

function fakeAgentWithStatus(status: 'idle' | 'running') {
  return { session: { id: 'a' }, status, cancel: vi.fn() } as unknown as CommandInvocation['agent']
}

function fakeInvocation(rawInput: string): CommandInvocation {
  return {
    commandId: 'cmd-test' as never,
    agent: fakeAgent(),
    rawInput,
    signal: new AbortController().signal,
  }
}

function fakeDefaultModel(): AgentDefaultModelConfig {
  return {
    currentSelection: () => ({ provider: 'p', model: 'm' }),
    saveSelection: vi.fn(async () => undefined),
  } as unknown as AgentDefaultModelConfig
}

function fakeLlmDirectory(overrides: {
  providers?: ReadonlyArray<{ id: string; name: string }>
  models?: Record<string, ReadonlyArray<{ provider: string; id: string; name: string }>>
  listModelsError?: string
} = {}) {
  const providers = overrides.providers ?? [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }]
  const models = overrides.models ?? { p1: [{ provider: 'p1', id: 'm1', name: 'M1' }], p2: [] }
  return {
    listProviders: () => providers,
    listModels: vi.fn(async (provider: string) => {
      if (overrides.listModelsError !== undefined && provider === overrides.listModelsError) {
        throw new Error('discovery failed')
      }
      return models[provider] ?? []
    }),
  }
}

function fakeCompaction(behavior: {
  result?: { shadowedSeqs: readonly unknown[]; shadowedTokenCount: number; summarySeq: number } | null
  error?: unknown
} = {}): CompactionEngine {
  return {
    compactNow: vi.fn(async () => {
      if (behavior.error !== undefined) throw behavior.error
      return behavior.result ?? null
    }),
  } as unknown as CompactionEngine
}

describe('registerLarkCommands', () => {
  it('registers /model, /compact, and /stop commands on the registry', () => {
    const fake = fakeContext()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), fakeCompaction(), translations)
    expect(fake.registered.map(item => item.name)).toEqual(['model', 'compact', 'stop'])
    fake.dispose()
  })
})

describe('/model command', () => {
  it('reports the current selection when invoked without arguments', async () => {
    const fake = fakeContext()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation(''))
    expect(result).toEqual({ kind: 'success', text: 'Current:\n• `p/m`' })
  })

  it('lists every available provider/model pair', async () => {
    const fake = fakeContext()
    const llm = fakeLlmDirectory({
      providers: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }],
      models: {
        p1: [{ provider: 'p1', id: 'm1', name: 'M1' }, { provider: 'p1', id: 'm2', name: 'M2' }],
        p2: [{ provider: 'p2', id: 'm3', name: 'M3' }],
      },
    })
    registerLarkCommands(fake.ctx, llm, fakeDefaultModel(), fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('list'))
    expect(result).toMatchObject({ kind: 'success' })
    expect((result as { text: string }).text).toContain('• `p1/m1`')
    expect((result as { text: string }).text).toContain('• `p1/m2`')
    expect((result as { text: string }).text).toContain('• `p2/m3`')
  })

  it('reports an empty catalog when no providers are registered', async () => {
    const fake = fakeContext()
    registerLarkCommands(fake.ctx, fakeLlmDirectory({ providers: [] }), fakeDefaultModel(), fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('list'))
    expect(result).toEqual({ kind: 'success', text: 'none' })
  })

  it('switches the default selection for a known provider/model', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('p1/m1'))
    expect(model.saveSelection).toHaveBeenCalledWith({ provider: 'p1', model: 'm1' })
    expect(result).toEqual({ kind: 'success', text: 'switched p1/m1' })
  })

  it('passes the reasoning-effort suffix through to saveSelection', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    await handler(fakeInvocation('p1/m1:high'))
    expect(model.saveSelection).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'high' })
  })

  it('rejects an unknown provider', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('unknown/x'))
    expect(result).toEqual({ kind: 'error', text: 'unknown unknown/x\nUsage: /model' })
    expect(model.saveSelection).not.toHaveBeenCalled()
  })

  it('rejects a malformed provider/model argument', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('p1/m1/extra'))
    expect(result).toMatchObject({ kind: 'error' })
    expect(model.saveSelection).not.toHaveBeenCalled()
  })

  it('falls back to fuzzy search when the input is a single keyword', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    const llm = fakeLlmDirectory({
      providers: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }],
      models: {
        p1: [{ provider: 'p1', id: 'm1', name: 'Alpha Model' }],
        p2: [{ provider: 'p2', id: 'mx', name: 'Beta Model' }],
      },
    })
    registerLarkCommands(fake.ctx, llm, model, fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('alpha'))
    expect(result).toMatchObject({ kind: 'success' })
    expect((result as { text: string }).text).toContain('p1/m1')
    expect((result as { text: string }).text).not.toContain('p2/mx')
  })

  it('matches models by id case-insensitively', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    const llm = fakeLlmDirectory({
      models: { p1: [{ provider: 'p1', id: 'DeepSeek-V4-Pro', name: 'Pro' }], p2: [] },
    })
    registerLarkCommands(fake.ctx, llm, model, fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('deepseek'))
    expect((result as { text: string }).text).toContain('p1/DeepSeek-V4-Pro')
  })

  it('returns an empty search result with usage guidance when nothing matches', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('nonexistent-keyword'))
    expect(result).toMatchObject({ kind: 'success' })
    expect((result as { text: string }).text).toContain('No models match')
  })

  it('marks the current selection in fuzzy search results', async () => {
    const fake = fakeContext()
    const model = {
      currentSelection: () => ({ provider: 'p1', model: 'm1' }),
      saveSelection: vi.fn(async () => undefined),
    } as unknown as AgentDefaultModelConfig
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('p1'))
    expect((result as { text: string }).text).toContain('current')
  })

  it('skips providers whose model listing fails', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    const llm = fakeLlmDirectory({
      providers: [{ id: 'broken', name: 'Broken' }, { id: 'p1', name: 'P1' }],
      models: { broken: [], p1: [{ provider: 'p1', id: 'm1', name: 'M1' }] },
      listModelsError: 'broken',
    })
    registerLarkCommands(fake.ctx, llm, model, fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('m1'))
    expect((result as { text: string }).text).toContain('p1/m1')
  })
})

describe('/compact command', () => {
  it('reports no history when compaction returns null', async () => {
    const fake = fakeContext()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), fakeCompaction({ result: null }), translations)
    const handler = fake.registered.find(item => item.name === 'compact')!.handler
    const result = await handler(fakeInvocation(''))
    expect(result).toEqual({ kind: 'success', text: 'no history' })
  })

  it('reports the compacted span when compaction succeeds', async () => {
    const fake = fakeContext()
    const compaction = fakeCompaction({ result: { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 150, summarySeq: 7 } })
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), compaction, translations)
    const handler = fake.registered.find(item => item.name === 'compact')!.handler
    const result = await handler(fakeInvocation(''))
    expect(result).toEqual({ kind: 'success', text: 'compacted 3 (150)', sourceEventSeq: 7 })
  })

  it('rejects extra arguments', async () => {
    const fake = fakeContext()
    const compaction = fakeCompaction()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), compaction, translations)
    const handler = fake.registered.find(item => item.name === 'compact')!.handler
    const result = await handler(fakeInvocation('extra'))
    expect(result).toEqual({ kind: 'error', text: 'Usage: /compact' })
  })

  it('maps a busy failure to the busy message', async () => {
    const fake = fakeContext()
    const compaction = fakeCompaction({ error: new Error('busy: another compaction is in flight') })
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), compaction, translations)
    const handler = fake.registered.find(item => item.name === 'compact')!.handler
    const result = await handler(fakeInvocation(''))
    expect(result).toEqual({ kind: 'error', text: 'busy' })
  })

  it('maps a changed-selection failure to the changed message', async () => {
    const fake = fakeContext()
    const compaction = fakeCompaction({ error: new Error('changed: history shifted') })
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), compaction, translations)
    const handler = fake.registered.find(item => item.name === 'compact')!.handler
    const result = await handler(fakeInvocation(''))
    expect(result).toEqual({ kind: 'error', text: 'changed' })
  })

  it('maps an aborted signal to the cancelled message', async () => {
    const fake = fakeContext()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'compact')!.handler
    const controller = new AbortController()
    controller.abort()
    const invocation = { commandId: 'cmd-test' as never, agent: fakeAgent(), rawInput: '', signal: controller.signal } as CommandInvocation
    const result = await handler(invocation)
    expect(result).toEqual({ kind: 'error', text: 'cancelled' })
  })
})

describe('/stop command', () => {
  it('cancels a running agent turn with a user cause', async () => {
    const fake = fakeContext()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'stop')!.handler
    const agent = fakeAgentWithStatus('running')
    const invocation = { commandId: 'cmd-test' as never, agent, rawInput: '', signal: new AbortController().signal } as CommandInvocation
    const result = await handler(invocation)
    expect((agent.cancel as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ kind: 'user' })
    expect(result).toEqual({ kind: 'success', text: 'cancelled the turn' })
  })

  it('reports idle when no turn is running', async () => {
    const fake = fakeContext()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'stop')!.handler
    const agent = fakeAgentWithStatus('idle')
    const invocation = { commandId: 'cmd-test' as never, agent, rawInput: '', signal: new AbortController().signal } as CommandInvocation
    const result = await handler(invocation)
    expect((agent.cancel as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect(result).toEqual({ kind: 'success', text: 'idle' })
  })

  it('rejects extra arguments', async () => {
    const fake = fakeContext()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), fakeCompaction(), translations)
    const handler = fake.registered.find(item => item.name === 'stop')!.handler
    const result = await handler(fakeInvocation('extra'))
    expect(result).toEqual({ kind: 'error', text: 'Usage: /stop' })
  })
})