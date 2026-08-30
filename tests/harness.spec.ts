import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HarnessConversationService } from '../src/harness.ts'

function fixture() {
  let seq = 0
  const agents = new Map<string, any>()
  const createHandle = async (sessionId: string) => {
    const events: any[] = []
    const ctx = { on: vi.fn(() => () => undefined) } as any
    const agent = {
      ctx,
      session: { id: sessionId, get seq() { return seq }, events },
      whenIdle: vi.fn(async () => undefined),
      followup: vi.fn((message: any) => {
        events.push({ seq: seq++, type: 'turn/start', data: {} })
        // Strip the `[Feishu] ` prefix so existing tests that compare against
        // raw text values keep working. Newer tests assert the prefix on the
        // captured user message directly.
        const echoed = String(message.content[0]?.text ?? '').replace(/^\[Feishu\] /, '')
        events.push({ seq: seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer:${echoed}` }] } } })
        events.push({ seq: seq++, type: 'turn/end', data: { reason: { kind: 'completed' } } })
      }),
      steer: vi.fn((message: any) => {
        events.push({ seq: seq++, type: 'turn/start', data: {} })
        const echoed = String(message.content[0]?.text ?? '').replace(/^\[Feishu\] /, '')
        events.push({ seq: seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer:${echoed}` }] } } })
        events.push({ seq: seq++, type: 'turn/end', data: { reason: { kind: 'completed' } } })
      }),
      cancel: vi.fn(() => undefined),
      status: 'idle' as const,
    }
    agents.set(String(sessionId), agent)
    return { agent, dispose: vi.fn(async () => undefined) }
  }
  const create = vi.fn(async ({ sessionId }: { sessionId: string }) => createHandle(sessionId))
  const resume = vi.fn(async ({ resumeSessionId }: { resumeSessionId: string }) => createHandle(resumeSessionId))
  const flush = vi.fn(async () => true)
  const workspace = { path: '/first-workspace', attachSession: vi.fn(async () => undefined) }
  const mount = vi.fn(async () => undefined)
  const resolve = vi.fn(async (id?: string) => ({ id: id ?? 'default-preset' }))
  return { create, resume, flush, agents, workspace, mount, resolve }
}

function dependencies(f: ReturnType<typeof fixture>) {
  return {
    agents: { create: f.create, resume: f.resume, get: (id: string) => f.agents.get(id) },
    sessions: { flush: f.flush },
    sessionPersistence: { list: vi.fn(async () => []), readFrom: vi.fn() },
    selection: () => ({ provider: 'p', model: 'm' }),
    agentPresets: { resolve: f.resolve, mount: f.mount },
    workspaceRegistry: { list: () => [f.workspace], resolveByPath: vi.fn(async () => undefined), archivedSessionIds: [] },
  } as any
}

describe('HarnessConversationService', () => {
  it('lazily creates and reuses one agent for the same conversation', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    await expect(service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'one' })).resolves.toBe('answer:one')
    await expect(service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'two' })).resolves.toBe('answer:two')
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.flush).toHaveBeenCalledTimes(2)
  })

  it('resumes a persisted conversation instead of creating its session again', async () => {
    const f = fixture()
    const deps = dependencies(f)
    const sessionId = 'lark-v2-427e3361f60f3bd896c74f6acd7d065d2e0198db'
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    const service = new HarnessConversationService(deps, { domain: 'lark' })

    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'again' })).resolves.toBe('answer:again')

    expect(f.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: sessionId }))
    expect(f.create).not.toHaveBeenCalled()
  })

  it('resolves a live agent without re-creating the session', async () => {
    const f = fixture()
    const sessionId = 'lark-v2-427e3361f60f3bd896c74f6acd7d065d2e0198db'
    const liveHandle = await f.create({ sessionId })
    f.create.mockClear()
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    const service = new HarnessConversationService(deps, { domain: 'lark' })
    const agent = await service.resolveAgentOrResume({ chatId: 'a', chatType: 'p2p' })
    expect(agent).toBeDefined()
    expect(f.create).not.toHaveBeenCalled()
    expect(liveHandle.agent).toBe(agent)
  })

  it('resolveAgentOrResume rehydrates a cold persisted session (commands work after restart)', async () => {
    const f = fixture()
    const sessionId = 'lark-v2-427e3361f60f3bd896c74f6acd7d065d2e0198db'
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    const service = new HarnessConversationService(deps, { domain: 'lark' })
    const agent = await service.resolveAgentOrResume({ chatId: 'a', chatType: 'p2p' })
    expect(agent).toBeDefined()
    // Cold session → resumed (not freshly created).
    expect(f.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: sessionId }))
    expect(f.create).not.toHaveBeenCalled()
  })

  it('resolveAgentOrResume returns undefined when no conversation exists at all', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [])
    const service = new HarnessConversationService(deps, { domain: 'lark' })
    const agent = await service.resolveAgentOrResume({ chatId: 'never', chatType: 'p2p' })
    expect(agent).toBeUndefined()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.resume).not.toHaveBeenCalled()
  })

  it('reuses a live agent without trying to resume the same session', async () => {
    const f = fixture()
    const sessionId = 'lark-v2-427e3361f60f3bd896c74f6acd7d065d2e0198db'
    const liveHandle = await f.create({ sessionId })
    f.create.mockClear()
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    const service = new HarnessConversationService(deps, { domain: 'lark' })

    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'live' })).resolves.toBe('answer:live')
    await service.dispose()

    expect(f.resume).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
    expect(liveHandle.dispose).not.toHaveBeenCalled()
  })

  it('steers into a running turn instead of queueing a new one', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'warmup' })
    const agent = [...f.agents.values()][0] as any
    agent.status = 'running'
    agent.followup.mockClear()
    agent.steer.mockClear()
    await service.steer({ chatId: 'oc_1', chatType: 'p2p', content: 'inject me' })
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.steer).toHaveBeenCalledTimes(1)
    const msg = agent.steer.mock.calls[0]![0]
    expect(msg.content).toEqual([{ type: 'text', text: '[Feishu] inject me' }])
    expect(msg.source).toEqual({ kind: 'user' })
  })

  it('rejects steer when no agent exists or it is not running', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    // No conversation started yet.
    await expect(service.steer({ chatId: 'oc_2', chatType: 'p2p', content: 'x' })).rejects.toThrow(/尚未开始会话/)
    // Agent exists but idle.
    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'warmup' })
    await expect(service.steer({ chatId: 'oc_1', chatType: 'p2p', content: 'x' })).rejects.toThrow(/没有运行中的 turn/)
  })

  it('persists a per-chat busy mode and reads it back (default queue)', () => {
    const f = fixture()
    const statePath = join(tmpdir(), `dsh-feishu-busy-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', statePath })
    expect(service.busyMode({ chatId: 'oc_1', chatType: 'p2p' })).toBe('queue')
    service.setBusyMode({ chatId: 'oc_1', chatType: 'p2p' }, 'steer')
    expect(service.busyMode({ chatId: 'oc_1', chatType: 'p2p' })).toBe('steer')
    expect(service.busyMode({ chatId: 'oc_2', chatType: 'p2p' })).toBe('queue')
    // Reload from disk: the choice survives a restart.
    const service2 = new HarnessConversationService(dependencies(f), { domain: 'feishu', statePath })
    expect(service2.busyMode({ chatId: 'oc_1', chatType: 'p2p' })).toBe('steer')
    expect(service2.busyMode({ chatId: 'oc_2', chatType: 'p2p' })).toBe('queue')
  })

  it('steer-mode reply injects into a running turn instead of queueing', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    service.setBusyMode({ chatId: 'oc_1', chatType: 'p2p' }, 'steer')
    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'warmup' })
    const agent = [...f.agents.values()][0] as any
    agent.followup.mockClear()
    agent.steer.mockClear()
    agent.status = 'running'
    const out = await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'inject' })
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(agent.followup).not.toHaveBeenCalled()
    expect(out).toBe('answer:inject')
  })

  it('forceQueue overrides steer mode for one reply (/queue)', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    service.setBusyMode({ chatId: 'oc_1', chatType: 'p2p' }, 'steer')
    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'warmup' })
    const agent = [...f.agents.values()][0] as any
    agent.followup.mockClear()
    agent.steer.mockClear()
    agent.status = 'running'
    // Even in steer mode, forceQueue routes to the queue path (followup), never steer.
    const out = await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'queued' }, { forceQueue: true })
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.steer).not.toHaveBeenCalled()
    const msg = agent.followup.mock.calls[0]![0]
    expect(msg.content).toEqual([{ type: 'text', text: '[Feishu] queued' }])
    expect(out).toBe('answer:queued')
  })

  it('queue-mode reply drops (TurnDroppedError) when the session is stopped while waiting', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'warmup' })
    const agent = [...f.agents.values()][0] as any
    // Simulate a `/stop` racing in during the queued message's idle wait.
    let stopped = false
    agent.whenIdle = vi.fn(async () => {
      if (!stopped) {
        stopped = true
        service.stopSession({ chatId: 'oc_1', chatType: 'p2p' })
      }
    })
    await expect(service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'queued' }))
      .rejects.toThrow(/session stopped while it was queued/)
  })

  it('stopSession cancels the live agent with keepInbox:false', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'warmup' })
    const agent = [...f.agents.values()][0] as any
    agent.cancel.mockClear()
    expect(service.stopSession({ chatId: 'oc_1', chatType: 'p2p' })).toBe(true)
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
  })

  // NOTE: /model selection mutation now goes through the session controller's
  // `selectModel` host API; the plugin no longer maintains a per-chat `selections`
  // map or installs `installModelSelection` against the agent ctx. That logic
  // moved upstream to `packages/api/session-controller`.

  it('isolates different chats and honors an explicit model route', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.selection = () => ({ provider: 'default', model: 'default' })
    const service = new HarnessConversationService(deps, { domain: 'lark', workspace: '/work', provider: 'custom', model: 'model' })
    await service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })
    await service.reply({ chatId: 'b', chatType: 'p2p', content: 'two' })
    expect(f.create).toHaveBeenCalledTimes(2)
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ agentOptions: { provider: 'custom', model: 'model' }, meta: { cwd: '/work', agentPreset: 'default-preset' } }))
  })

  it('uses the first registered workspace and mounts the default agent preset', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    await service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })
    const options = f.create.mock.calls[0]![0] as any
    expect(options.meta).toEqual({ cwd: '/first-workspace', agentPreset: 'default-preset' })
    const agentCtx = { on: vi.fn(() => () => undefined) } as any
    await options.setup(agentCtx)
    expect(f.resolve).toHaveBeenCalledWith(undefined)
    expect(f.mount).toHaveBeenCalledWith(agentCtx, 'default-preset')
    expect(f.workspace.attachSession).toHaveBeenCalledWith(options.sessionId)
  })

  it('uses and mounts an explicitly configured workspace and preset', async () => {
    const f = fixture()
    const explicit = { path: '/configured', attachSession: vi.fn(async () => undefined) }
    const deps = dependencies(f)
    deps.workspaceRegistry.resolveByPath = vi.fn(async () => explicit)
    const service = new HarnessConversationService(deps, { domain: 'feishu', workspace: '/configured', agentPreset: 'coding' })
    await service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })
    const options = f.create.mock.calls[0]![0] as any
    await options.setup({ on: vi.fn(() => () => undefined) } as any)
    expect(f.resolve).toHaveBeenCalledWith('coding')
    expect(explicit.attachSession).toHaveBeenCalledWith(options.sessionId)
  })

  it('disposes a newly created agent when workspace attachment fails', async () => {
    const f = fixture()
    f.workspace.attachSession.mockRejectedValueOnce(new Error('attach failed'))
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })).rejects.toThrow('attach failed')
    const handle = await f.create.mock.results[0]!.value
    expect(handle.dispose).toHaveBeenCalledOnce()
  })

  it('rejects a turn that commits no successful assistant answer', async () => {
    const create = vi.fn(async ({ sessionId }: any) => ({ agent: { session: { id: sessionId, seq: 0, events: [{ seq: 0, type: 'turn/end', data: { reason: { kind: 'error' } } }] }, whenIdle: async () => undefined, followup() {}, steer() {}, cancel() {}, status: 'idle' as const }, dispose: async () => undefined }))
    const service = new HarnessConversationService({ agents: { create, resume: vi.fn(), get: () => undefined }, sessions: { flush: async () => true }, sessionPersistence: { list: async () => [] }, selection: () => ({ provider: 'p', model: 'm' }), agentPresets: { resolve: async () => ({ id: 'default' }), mount: async () => undefined }, workspaceRegistry: { list: () => [], resolveByPath: async () => undefined, archivedSessionIds: [] } }, { domain: 'feishu', workspace: '/work' })
    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })).rejects.toThrow(/successful assistant response/)
  })

  it('listSessions filters out the workspace archive set', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [
      { id: 'kept-1' },
      { id: 'gone-1' },
      { id: 'kept-2' },
    ])
    deps.workspaceRegistry = { ...deps.workspaceRegistry, archivedSessionIds: ['gone-1'] }
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const sessions = await service.listSessions()
    expect(sessions.map(s => s.id)).toEqual(['kept-1', 'kept-2'])
  })

  it('listSessions filters out live blank sessions (no turn/start)', async () => {
    const f = fixture()
    const sessionId = 'lark-v2-test-blank'
    const blankHandle = await f.create({ sessionId: sessionId as never })
    blankHandle.agent.session.events.push(
      { seq: 0, type: 'session', data: {} },
      { seq: 1, type: 'session/end-seed', data: {} },
    )
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const sessions = await service.listSessions()
    expect(sessions.map(s => s.id)).toEqual([])
  })

  it('switchToSession refuses to redirect a chat to an archived session', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.workspaceRegistry = { ...deps.workspaceRegistry, archivedSessionIds: ['gone-1'] }
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const chatMessage = { chatId: 'a', chatType: 'p2p' as const }
    expect(service.switchToSession(chatMessage, 'gone-1')).toBe('archived')
    expect(service.switchToSession(chatMessage, 'kept-1')).toBe('ok')
  })

  it('refuses to switch onto a session owned by another chat key', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    // Topic A runs /new, binding session-new to topic key thread:a:t1
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    const newId = service.startNewSession(topicA, 's1')
    // The main chat of the same group cannot /thread onto it
    const main = { chatId: 'a', chatType: 'p2p' as const }
    expect(service.sessionOwnerKey(newId)).toBe('thread:a:t1')
    expect(service.switchToSession(main, newId)).toBe('occupied')
    // But switching the owning topic back to its own session is fine
    expect(service.switchToSession(topicA, newId)).toBe('ok')
  })

  it('derives default-derived session ownership (no explicit /new)', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    // Resolving the session id records the key in seenChatKeys
    const defaultId = service.resolveSessionIdFor(topicA)
    const main = { chatId: 'a', chatType: 'p2p' as const }
    expect(service.sessionOwnerKey(defaultId)).toBe('thread:a:t1')
    expect(service.switchToSession(main, defaultId)).toBe('occupied')
  })

  it('persists and restores seenChatKeys across restarts', async () => {
    const statePath = join(tmpdir(), `lark-map-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', statePath })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    const newId = service.startNewSession(topicA, 's1')
    expect(service.sessionOwnerKey(newId)).toBe('thread:a:t1')
    // New service instance reads the same file back
    const service2 = new HarnessConversationService(dependencies(f), { domain: 'feishu', statePath })
    expect(service2.sessionOwnerKey(newId)).toBe('thread:a:t1')
  })

  it('records chat keys on first resolve so default ownership survives restarts', async () => {
    const statePath = join(tmpdir(), `lark-map-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', statePath })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    // Resolving without /new persists the key
    const defaultId = service.resolveSessionIdFor(topicA)
    const service2 = new HarnessConversationService(dependencies(f), { domain: 'feishu', statePath })
    expect(service2.sessionOwnerKey(defaultId)).toBe('thread:a:t1')
  })

  it('detachSession resets the owner to a fresh session and frees the target', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    const newId = service.startNewSession(topicA, 's1')
    const outcome = service.detachSession(newId)
    expect(outcome).toEqual({ kind: 'released', ownerLabel: '话题(t1…)' })
    expect(service.sessionOwnerKey(newId)).toBeUndefined()
    // The owner's next message goes to a different (fresh) session
    expect(service.resolveSessionIdFor(topicA)).not.toBe(newId)
  })

  it('detachSession on a free session reports free', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    expect(service.detachSession('unowned-1')).toEqual({ kind: 'free' })
  })

  it('forwards image blocks into the user-turn content array', async () => {
    const f = fixture()
    let captured: any
    const original = f.create.getMockImplementation()
    f.create.mockImplementationOnce(async (input: any) => {
      const handle = await original!(input)
      handle.agent.followup = vi.fn((message: any) => {
        captured = message
        const seq = handle.agent.session.events.length
        handle.agent.session.events.push(
          { seq, type: 'turn/start', data: {} },
          { seq: seq + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer:${message.content[0].text}` }] } } },
          { seq: seq + 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
        )
      })
      return handle
    })
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    const ref = {
      attachmentId: 'att_1' as never,
      mediaType: 'image/jpeg' as const,
      bytes: 4,
      width: 1,
      height: 1,
    }
    await expect(service.reply({
      chatId: 'oc_1', chatType: 'p2p',
      content: 'describe this',
      imageBlocks: [ref],
    })).resolves.toBe('answer:[Feishu] describe this')
    expect(captured).toMatchObject({
      content: [
        { type: 'text', text: '[Feishu] describe this' },
        { type: 'image', attachment: ref },
      ],
    })
  })

  it('submits image-only messages without a text payload', async () => {
    const f = fixture()
    const original = f.create.getMockImplementation()
    f.create.mockImplementationOnce(async (input: any) => {
      const handle = await original!(input)
      handle.agent.followup = vi.fn((message: any) => {
        const seq = handle.agent.session.events.length
        const images = message.content.filter((c: any) => c.type === 'image').length
        handle.agent.session.events.push(
          { seq, type: 'turn/start', data: {} },
          { seq: seq + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `images:${images}` }] } } },
          { seq: seq + 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
        )
      })
      return handle
    })
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    const ref = {
      attachmentId: 'att_2' as never,
      mediaType: 'image/png' as const,
      bytes: 8,
      width: 2,
      height: 2,
    }
    await expect(service.reply({
      chatId: 'oc_2', chatType: 'p2p',
      content: '',
      imageBlocks: [ref, ref],
    })).resolves.toBe('images:2')
  })

  it('rejects an inbound message that carries neither text nor images', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    await expect(service.reply({ chatId: 'oc_3', chatType: 'p2p', content: '' })).rejects.toThrow(/empty user turn/)
  })

  it('prepends [Feishu] to every user turn so the model can see the source', async () => {
    const f = fixture()
    let captured: any
    const original = f.create.getMockImplementation()
    f.create.mockImplementationOnce(async (input: any) => {
      const handle = await original!(input)
      handle.agent.followup = vi.fn((message: any) => {
        captured = message
        const seq = handle.agent.session.events.length
        handle.agent.session.events.push(
          { seq, type: 'turn/start', data: {} },
          { seq: seq + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
          { seq: seq + 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
        )
      })
      return handle
    })
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    await service.reply({ chatId: 'oc_4', chatType: 'p2p', content: 'hello' })
    expect(captured.content[0]).toEqual({ type: 'text', text: '[Feishu] hello' })
  })

  it('still tags image-only messages with [Feishu] as a standalone text block', async () => {
    const f = fixture()
    let captured: any
    const original = f.create.getMockImplementation()
    f.create.mockImplementationOnce(async (input: any) => {
      const handle = await original!(input)
      handle.agent.followup = vi.fn((message: any) => {
        captured = message
        const seq = handle.agent.session.events.length
        handle.agent.session.events.push(
          { seq, type: 'turn/start', data: {} },
          { seq: seq + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
          { seq: seq + 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
        )
      })
      return handle
    })
    const ref = { attachmentId: 'att_x' as never, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 }
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    await service.reply({ chatId: 'oc_5', chatType: 'p2p', content: '', imageBlocks: [ref] })
    expect(captured.content).toEqual([
      { type: 'text', text: '[Feishu] ' },
      { type: 'image', attachment: ref },
    ])
  })

  it('needsOnboarding is true for a chat with no session history and false after /new', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    expect(await service.needsOnboarding(topicA)).toBe(true)
    service.startNewSession(topicA, 's1')
    expect(await service.needsOnboarding(topicA)).toBe(false)
  })

  it('needsOnboarding is false when the default-derived session already exists', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [{ id: 'lark-v2-something' }])
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const main = { chatId: 'b', chatType: 'p2p' as const }
    // The default-derived session for chat:b is a deterministic hash; fabricate
    // it as existing so needsOnboarding resolves false.
    const defaultId = service.resolveSessionIdFor(main)
    deps.sessionPersistence.list = vi.fn(async () => [{ id: defaultId }])
    expect(await service.needsOnboarding(main)).toBe(false)
  })

  it('attachSession force-takes over a session owned by another chat', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    const topicAId = service.startNewSession(topicA, 's1')
    expect(service.sessionOwnerKey(topicAId)).toBe('thread:a:t1')
    const main = { chatId: 'a', chatType: 'p2p' as const }
    // Force takeover from the main chat
    expect(service.attachSession(main, topicAId)).toBe('ok')
    expect(service.sessionOwnerKey(topicAId)).toBe('chat:a')
    // The previous owner (topic A) was reset to a fresh session
    expect(service.resolveSessionIdFor(topicA)).not.toBe(topicAId)
  })

  it('startNewSession stores creation options and createAgent honors them', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    const topicA = { chatId: 'a', chatType: 'p2p' as const, threadId: 't1' }
    const sessionId = service.startNewSession(topicA, 's1', {
      workspace: '/other-ws',
      agentPreset: 'researcher',
      provider: 'openai',
      model: 'gpt-4o',
    })
    expect(sessionId).not.toBe('')
    // createAgent is exercised via reply(); the first create call carries the
    // sessionId and the meta should reflect the per-chat creation options.
    const f2 = fixture()
    const service2 = new HarnessConversationService(dependencies(f2), { domain: 'feishu', workspace: '/work' })
    service2.startNewSession(topicA, 's1', {
      workspace: '/other-ws',
      agentPreset: 'researcher',
      provider: 'openai',
      model: 'gpt-4o',
    })
    f2.create.mockImplementationOnce(async (input: any) => {
      const handle = await f2.create.getMockImplementation()!(input)
      return handle
    })
    await service2.reply({ chatId: 'a', chatType: 'p2p', threadId: 't1', content: 'hello' })
    const createCall = f2.create.mock.calls[0]![0] as any
    expect(createCall.sessionId).toBe(service2.resolveSessionIdFor(topicA))
    expect(createCall.agentOptions).toMatchObject({ provider: 'openai', model: 'gpt-4o' })
  })
})
