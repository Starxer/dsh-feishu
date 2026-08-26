import { describe, expect, it, vi } from 'vitest'
import { registerLarkCommands, type ApprovalControl, type CommandTranslations } from '../src/commands.ts'
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
  modelPersisted: 'persisted',
  modelLiveApplied: 'live applied',
  newDescription: 'new desc',
  newSessionReady: sessionId => `ready ${sessionId}`,
  threadDescription: 'thread desc',
  threadUsage: 'Usage: /thread [N]',
  threadListHeader: 'sessions:',
  threadListEmpty: 'empty',
  threadListEntry: (index, id, title, lastActive) => `${index}. ${title} - ${lastActive} (${id})`,
  threadSwitched: (index, id) => `switched ${index} ${id}`,
  threadInvalidIndex: 'invalid',
  threadArchived: 'archived',
  threadIdle: (id: string) => `(idle:${id})`,
  threadLastActiveJustNow: 'just now',
  threadLastActiveMinutesAgo: n => `${n}m ago`,
  threadLastActiveHoursAgo: n => `${n}h ago`,
  threadLastActiveDaysAgo: n => `${n}d ago`,
  threadLastActiveUnknown: 'unknown',
  helpDescription: 'help desc',
  helpHeader: 'help header:',
  helpUsage: 'help usage',
  helpEntry: (name, description, hint) => hint === undefined
    ? `${name}: ${description}`
    : `${name}: ${description} [${hint}]`,
  helpEmpty: 'help empty',
  approveDescription: 'approve desc',
  approveApproveHint: '[shortCode]',
  approveApprovedNoPending: 'no pending',
  approveApproved: (shortCode, toolName) => `approved ${toolName} ${shortCode}`,
  approveUnknownShort: shortCode => `unknown ${shortCode}`,
  denyDescription: 'deny desc',
  denyHint: '[shortCode]',
  denyDenied: (shortCode, toolName) => `denied ${toolName} ${shortCode}`,
  approveDenyUsage: 'usage',
  approvalsDescription: 'approvals desc',
  approvalsEmpty: 'no pending approvals',
  approvalsHeader: 'pending approvals:',
  approvalsEntry: (index, shortCode, toolName, age) => `${index}. ${shortCode} ${toolName} ${age}`,
  approvalsAgeJustNow: 'just now',
  approvalsAgeSeconds: n => `${n}s`,
  approvalsAgeMinutes: n => `${n}m`,
  approvalsAgeHours: n => `${n}h`,
  statusDescription: 'Show session status',
  statusOutput: (meta) => `Session: ${meta.sessionId} | Title: ${meta.title} | Workspace: ${meta.workspace} | Preset: ${meta.agentPreset} | Model: ${meta.model}`,
  streamDescription: 'Toggle streaming messages',
  stopDescription: 'Stop the running agent',
  reasoningDescription: 'Show or change reasoning effort',
  reasoningUsage: 'Usage: /reasoning [off|low|high|max]',
  reasoningCurrent: (effort: string) => `Current: ${effort}`,
  reasoningCurrentDefault: '(default)',
  reasoningSwitched: (effort: string) => `Switched to ${effort}`,
  reasoningLevels: 'Levels: off, low, high, max',
  reasoningUnknown: (level: string) => `Unknown: ${level}`,
  reasoningShowToggled: (enabled: boolean) => `Reasoning display: ${enabled ? 'on' : 'off'}`,
}

const stubApprovalControl: ApprovalControl = {
  pendingForSession: () => [],
  findPending: () => undefined,
  settle: vi.fn(async () => undefined),
}

const stubShowReasoning = {
  get: () => true,
  toggle: () => { /* noop */ },
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

function fakeBridge(overrides?: {
  setCurrentSelection?: ReturnType<typeof vi.fn>
  startNewSession?: ReturnType<typeof vi.fn>
  switchToSession?: ReturnType<typeof vi.fn>
  listSessions?: ReturnType<typeof vi.fn>
  getSessionMeta?: ReturnType<typeof vi.fn>
}) {
  const setCurrentSelection = overrides?.setCurrentSelection ?? vi.fn(() => undefined)
  const startNewSession = overrides?.startNewSession ?? vi.fn(() => 'new-session-id')
  const switchToSession = overrides?.switchToSession ?? vi.fn(() => true)
  const listSessions = overrides?.listSessions ?? vi.fn(async () => [])
  const getSessionMeta = overrides?.getSessionMeta ?? vi.fn(async () => ({ sessionId: 'test-session', workspace: '/test/ws', agentPreset: 'default', model: 'openai/gpt-4o', title: 'Test Session', turns: 5, steps: 8, toolCalls: 3, inputTokens: 1200, outputTokens: 450, contextWindow: 128000, lastInputTokens: 800 }))
  return {
    bridge: {
      setCurrentSelection,
      currentSelectionFor: vi.fn(() => undefined),
      startNewSession,
      switchToSession,
      listSessions,
      getSessionMeta,
    },
    setCurrentSelection,
    startNewSession,
    switchToSession,
    listSessions,
    getSessionMeta,
    chatMessageFor: () => ({ chatId: 'oc_1', chatType: 'p2p' as const }),
  }
}

function fakeInvocation(rawInput: string): CommandInvocation {
  // The published `^0.1.0-rc.7` ABI does not carry an `attachments` slot on
  // `CommandInvocation`; later dsh versions added it. The fake stays
  // compatible with both by avoiding the field entirely.
  return {
    commandId: 'cmd-test' as never,
    agent: fakeAgent(),
    rawInput,
    signal: new AbortController().signal,
  } as unknown as CommandInvocation
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

function fakeCommands(descriptors: ReadonlyArray<{ name: string; description: string; input?: { hint: string } }> = []) {
  return {
    list: vi.fn(() => descriptors),
  }
}

describe('registerLarkCommands', () => {
  it('registers the /model, /new, /thread, and /help commands on the registry', () => {
    const fake = fakeContext()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), fakeBridge().bridge, fakeBridge().chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
    expect(fake.registered.map(item => item.name)).toEqual(['model', 'new', 'thread', 'help', 'approve', 'deny', 'approvals', 'status', 'stream', 'reasoning'])
    fake.dispose()
  })
})

describe('/model command', () => {
  it('reports the current selection when invoked without arguments', async () => {
    const fake = fakeContext()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), fakeBridge().bridge, fakeBridge().chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
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
    registerLarkCommands(fake.ctx, llm, fakeDefaultModel(), fakeBridge().bridge, fakeBridge().chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('list'))
    expect(result).toMatchObject({ kind: 'success' })
    expect((result as { text: string }).text).toContain('• `p1/m1`')
    expect((result as { text: string }).text).toContain('• `p1/m2`')
    expect((result as { text: string }).text).toContain('• `p2/m3`')
  })

  it('reports an empty catalog when no providers are registered', async () => {
    const fake = fakeContext()
    registerLarkCommands(fake.ctx, fakeLlmDirectory({ providers: [] }), fakeDefaultModel(), fakeBridge().bridge, fakeBridge().chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('list'))
    expect(result).toEqual({ kind: 'success', text: 'none' })
  })

  it('switches the default selection for a known provider/model', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, fakeBridge().bridge, fakeBridge().chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('p1/m1'))
    expect(model.saveSelection).toHaveBeenCalledWith({ provider: 'p1', model: 'm1' })
    expect((result as { text: string }).text).toContain('switched p1/m1')
  })

  it('passes the reasoning-effort suffix through to saveSelection', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, fakeBridge().bridge, fakeBridge().chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    await handler(fakeInvocation('p1/m1:high'))
    expect(model.saveSelection).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'high' })
  })

  it('mutates the chat selection through the bridge on a successful switch', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    // Returning a non-undefined "previous" simulates the chat having a cached
    // selection ref; the handler then reports the change as live-applied.
    const setCurrentSelection = vi.fn(() => ({ provider: 'old', model: 'old' }))
    const { bridge, chatMessageFor } = fakeBridge({ setCurrentSelection })
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, bridge, chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('p1/m1'))
    expect(setCurrentSelection).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'oc_1' }),
      { provider: 'p1', model: 'm1' },
    )
    expect((result as { text: string }).text).toContain('switched p1/m1')
    expect((result as { text: string }).text).toContain('live applied')
  })

  it('does not call setCurrentSelection when the route is rejected', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    const setCurrentSelection = vi.fn(() => undefined)
    const { bridge, chatMessageFor } = fakeBridge({ setCurrentSelection })
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, bridge, chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    await handler(fakeInvocation('unknown/x'))
    expect(setCurrentSelection).not.toHaveBeenCalled()
  })

  it('rejects an unknown provider', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, fakeBridge().bridge, fakeBridge().chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('unknown/x'))
    expect(result).toEqual({ kind: 'error', text: 'unknown unknown/x\nUsage: /model' })
    expect(model.saveSelection).not.toHaveBeenCalled()
  })

  it('rejects a malformed provider/model argument', async () => {
    const fake = fakeContext()
    const model = fakeDefaultModel()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), model, fakeBridge().bridge, fakeBridge().chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'model')!.handler
    const result = await handler(fakeInvocation('p1/m1/extra'))
    expect(result).toMatchObject({ kind: 'error' })
    expect(model.saveSelection).not.toHaveBeenCalled()
  })
})

describe('/new command', () => {
  it('starts a new session for the current chat', async () => {
    const fake = fakeContext()
    const startNewSession = vi.fn(() => 'new-session-id')
    const { bridge, chatMessageFor } = fakeBridge({ startNewSession })
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), bridge, chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'new')!.handler
    const result = await handler(fakeInvocation(''))
    expect(startNewSession).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'oc_1' }), expect.any(String))
    expect(result).toEqual({ kind: 'success', text: 'ready new-session-id' })
  })
})

describe('/thread command', () => {
  it('lists persisted sessions when invoked without an argument', async () => {
    vi.useFakeTimers()
    try {
      const now = Date.now()
      vi.setSystemTime(now)
      const fake = fakeContext()
      const listSessions = vi.fn(async () => [
        { id: 'session-A', updatedAt: now - 30 * 60_000, title: 'First chat' },
        { id: 'session-B', updatedAt: now - 3 * 3_600_000, title: 'Second chat' },
      ])
      const { bridge, chatMessageFor } = fakeBridge({ listSessions })
      registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), bridge, chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
      const handler = fake.registered.find(item => item.name === 'thread')!.handler
      const result = await handler(fakeInvocation(''))
      expect(listSessions).toHaveBeenCalled()
      const text = (result as { text: string }).text
      expect(text).toContain('1. First chat - 30m ago (session-A)')
      expect(text).toContain('2. Second chat - 3h ago (session-B)')
      expect(text).toContain('Usage: /thread [N]')
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to (untitled) when a session has no title', async () => {
    vi.useFakeTimers()
    try {
      const now = Date.now()
      vi.setSystemTime(now)
      const fake = fakeContext()
      const listSessions = vi.fn(async () => [
        { id: 'session-A', updatedAt: now, title: '' },
      ])
      const { bridge, chatMessageFor } = fakeBridge({ listSessions })
      registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), bridge, chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
      const handler = fake.registered.find(item => item.name === 'thread')!.handler
      const result = await handler(fakeInvocation(''))
      expect((result as { text: string }).text).toContain('1. (idle:session-A) - just now (session-A)')
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses coarse time buckets: minutes, hours, days', async () => {
    vi.useFakeTimers()
    try {
      const now = Date.now()
      vi.setSystemTime(now)
      const fake = fakeContext()
      const listSessions = vi.fn(async () => [
        { id: 's-m', updatedAt: now - 5 * 60_000, title: 'm' },
        { id: 's-h', updatedAt: now - 2 * 3_600_000, title: 'h' },
        { id: 's-d', updatedAt: now - 2 * 86_400_000, title: 'd' },
        { id: 's-?', updatedAt: 0, title: '?' },
      ])
      const { bridge, chatMessageFor } = fakeBridge({ listSessions })
      registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), bridge, chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
      const handler = fake.registered.find(item => item.name === 'thread')!.handler
      const result = await handler(fakeInvocation(''))
      const text = (result as { text: string }).text
      expect(text).toContain('m - 5m ago')
      expect(text).toContain('h - 2h ago')
      expect(text).toContain('d - 2d ago')
      expect(text).toContain('? - unknown')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports an empty catalog when no persisted sessions exist', async () => {
    const fake = fakeContext()
    const { bridge, chatMessageFor } = fakeBridge({ listSessions: vi.fn(async () => []) })
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), bridge, chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'thread')!.handler
    const result = await handler(fakeInvocation(''))
    expect(result).toEqual({ kind: 'success', text: 'empty' })
  })

  it('switches the chat to the session selected by index', async () => {
    const fake = fakeContext()
    const sessions = [
      { id: 'session-A', updatedAt: 2, title: 'first' },
      { id: 'session-B', updatedAt: 5, title: 'second' },
    ]
    const switchToSession = vi.fn(() => true)
    const { bridge, chatMessageFor } = fakeBridge({ listSessions: vi.fn(async () => sessions), switchToSession })
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), bridge, chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'thread')!.handler
    const result = await handler(fakeInvocation('2'))
    expect(switchToSession).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'oc_1' }), 'session-B')
    expect(result).toEqual({ kind: 'success', text: 'switched 2 session-B' })
  })

  it('reports the bridge rejection when the target session is archived', async () => {
    const fake = fakeContext()
    const switchToSession = vi.fn(() => false)
    const { bridge, chatMessageFor } = fakeBridge({
      listSessions: vi.fn(async () => [{ id: 'session-A', updatedAt: 1, title: 'a' }]),
      switchToSession,
    })
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), bridge, chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'thread')!.handler
    const result = await handler(fakeInvocation('1'))
    expect(switchToSession).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'oc_1' }), 'session-A')
    expect(result).toEqual({ kind: 'error', text: 'archived' })
  })

  it('rejects an out-of-range index', async () => {
    const fake = fakeContext()
    const switchToSession = vi.fn(() => true)
    const { bridge, chatMessageFor } = fakeBridge({
      listSessions: vi.fn(async () => [{ id: 'session-A', updatedAt: 1, title: 'a' }]),
      switchToSession,
    })
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), bridge, chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'thread')!.handler
    const result = await handler(fakeInvocation('9'))
    expect(result).toMatchObject({ kind: 'error' })
    expect(switchToSession).not.toHaveBeenCalled()
  })

  it('rejects a non-numeric argument', async () => {
    const fake = fakeContext()
    const switchToSession = vi.fn(() => true)
    const { bridge, chatMessageFor } = fakeBridge({
      listSessions: vi.fn(async () => [{ id: 'session-A', updatedAt: 1, title: 'a' }]),
      switchToSession,
    })
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), bridge, chatMessageFor, translations, fakeCommands(), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'thread')!.handler
    const result = await handler(fakeInvocation('abc'))
    expect(result).toMatchObject({ kind: 'error' })
    expect(switchToSession).not.toHaveBeenCalled()
  })
})

describe('/help command', () => {
  it('lists every command returned by the command runtime', async () => {
    const fake = fakeContext()
    const descriptors = [
      { name: 'compact', description: 'Compact older conversation history' },
      { name: 'export', description: 'Download this Session log as a ZIP archive' },
      { name: 'model', description: 'Show, list, or switch the active model' },
    ]
    const cmds = fakeCommands(descriptors)
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), fakeBridge().bridge, fakeBridge().chatMessageFor, translations, cmds, stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'help')!.handler
    const result = await handler(fakeInvocation(''))
    expect(cmds.list).toHaveBeenCalledWith(expect.objectContaining({ session: { id: 'a' } }))
    const text = (result as { text: string }).text
    expect(text).toContain('help header:')
    expect(text).toContain('compact: Compact older conversation history')
    expect(text).toContain('export: Download this Session log as a ZIP archive')
    expect(text).toContain('model: Show, list, or switch the active model')
    expect(text).toContain('help usage')
  })

  it('renders the input hint in [brackets] when the descriptor declares one', async () => {
    const fake = fakeContext()
    const descriptors = [
      {
        name: 'goal',
        description: 'set or view the goal for a long-running task',
        input: { hint: '[<objective>|clear|edit <objective>|pause|resume]' },
      },
    ]
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), fakeBridge().bridge, fakeBridge().chatMessageFor, translations, fakeCommands(descriptors), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'help')!.handler
    const result = await handler(fakeInvocation(''))
    const text = (result as { text: string }).text
    expect(text).toContain('goal: set or view the goal for a long-running task [[<objective>|clear|edit <objective>|pause|resume]]')
  })

  it('reports an empty list when no descriptors are returned', async () => {
    const fake = fakeContext()
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), fakeBridge().bridge, fakeBridge().chatMessageFor, translations, fakeCommands([]), stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'help')!.handler
    const result = await handler(fakeInvocation(''))
    expect(result).toEqual({ kind: 'success', text: 'help empty' })
  })

  it('ignores extra raw input', async () => {
    const fake = fakeContext()
    const cmds = fakeCommands([{ name: 'compact', description: 'Compact older conversation history' }])
    registerLarkCommands(fake.ctx, fakeLlmDirectory(), fakeDefaultModel(), fakeBridge().bridge, fakeBridge().chatMessageFor, translations, cmds, stubApprovalControl, stubShowReasoning)
    const handler = fake.registered.find(item => item.name === 'help')!.handler
    const result = await handler(fakeInvocation('anything here'))
    expect(result).toMatchObject({ kind: 'success' })
    expect(cmds.list).toHaveBeenCalledTimes(1)
  })
})
