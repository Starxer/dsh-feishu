import { describe, expect, it, vi } from 'vitest'
import { registerLarkCommands, type CommandTranslations } from '../src/commands.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'

const translations: CommandTranslations = {
  modelDescription: 'model desc',
  modelCurrentHeader: 'Current:',
  modelUsage: 'Usage: /model',
  modelListHeader: 'Available:',
  modelListEmpty: 'none',
  modelSwitched: (provider, model) => `switched ${provider}/${model}`,
  modelUnknown: route => `unknown ${route}`,
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
} = {}) {
  const providers = overrides.providers ?? [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }]
  const models = overrides.models ?? { p1: [{ provider: 'p1', id: 'm1', name: 'M1' }], p2: [] }
  return {
    listProviders: () => providers,
    listModels: vi.fn(async (provider: string) => models[provider] ?? []),
  }
}

describe('registerLarkCommands', () => {
  it('registers the /model command on the registry', () => {
    const fake = fakeContext()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), translations)
    expect(fake.registered.map(item => item.name)).toEqual(['model'])
    fake.dispose()
  })
})

describe('/model command', () => {
  it('reports the current selection when invoked without arguments', async () => {
    const fake = fakeContext()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), translations)
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
    registerLarkCommands(fake.ctx, llm, fakeDefaultModel(), translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('list'))
    expect(result).toMatchObject({ kind: 'success' })
    expect((result as { text: string }).text).toContain('• `p1/m1`')
    expect((result as { text: string }).text).toContain('• `p1/m2`')
    expect((result as { text: string }).text).toContain('• `p2/m3`')
  })

  it('reports an empty catalog when no providers are registered', async () => {
    const fake = fakeContext()
    registerLarkCommands(fake.ctx, fakeLlmDirectory({ providers: [] }), fakeDefaultModel(), translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('list'))
    expect(result).toEqual({ kind: 'success', text: 'none' })
  })

  it('switches the default selection for a known provider/model', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('p1/m1'))
    expect(model.saveSelection).toHaveBeenCalledWith({ provider: 'p1', model: 'm1' })
    expect(result).toEqual({ kind: 'success', text: 'switched p1/m1' })
  })

  it('passes the reasoning-effort suffix through to saveSelection', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    await handler(fakeInvocation('p1/m1:high'))
    expect(model.saveSelection).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'high' })
  })

  it('rejects an unknown provider', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('unknown/x'))
    expect(result).toEqual({ kind: 'error', text: 'unknown unknown/x\nUsage: /model' })
    expect(model.saveSelection).not.toHaveBeenCalled()
  })

  it('rejects a malformed provider/model argument', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, translations)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('p1/m1/extra'))
    expect(result).toMatchObject({ kind: 'error' })
    expect(model.saveSelection).not.toHaveBeenCalled()
  })
})
