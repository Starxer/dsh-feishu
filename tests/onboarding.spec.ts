import { describe, expect, it, vi } from 'vitest'
import { startFeishuOnboarding, type FeishuOnboardingDeps } from '../src/feishu-onboarding.ts'

interface FakeChannel {
  send: ReturnType<typeof vi.fn>
  updateCard: ReturnType<typeof vi.fn>
  onCardAction: ReturnType<typeof vi.fn>
  createCardInstance: ReturnType<typeof vi.fn>
  sendCardByReference: ReturnType<typeof vi.fn>
  updateCardInstance: ReturnType<typeof vi.fn>
}

function fakeChannel(): { channel: FakeChannel; handlers: Array<(evt: any) => void | Promise<void>> } {
  const handlers: Array<(evt: any) => void | Promise<void>> = []
  const channel: FakeChannel = {
    send: vi.fn(async () => ({ messageId: 'm-1' })),
    updateCard: vi.fn(async () => undefined),
    onCardAction: vi.fn((h: (evt: any) => void | Promise<void>) => {
      handlers.push(h)
      return () => {
        const i = handlers.indexOf(h)
        if (i >= 0) handlers.splice(i, 1)
      }
    }),
    createCardInstance: vi.fn(async (card: object) => `card-${JSON.stringify(card).length}`),
    sendCardByReference: vi.fn(async () => ({ messageId: 'm-ref' })),
    updateCardInstance: vi.fn(async () => undefined),
  }
  return { channel, handlers }
}

function fakeBridge() {
  const sessions: Array<{ id: string; updatedAt: number; title: string; ownedBy?: string }> = []
  return {
    sessions,
    current: {
      listSessions: vi.fn(async () => sessions),
      describeChatKey: (key: string) => (key.startsWith('thread:') ? `话题(${key.slice(7, 15)})` : '主聊天'),
      attachSession: vi.fn(() => 'ok' as const),
      sessionOwnerKey: vi.fn(() => undefined),
      currentSelectionFor: vi.fn(() => undefined),
      startNewSession: vi.fn(() => 'new-session-id'),
    },
  }
}

function deps(channel: FakeChannel, bridgeHolder: { current: any }): FeishuOnboardingDeps {
  return {
    bridgeHolder,
    channel: channel as unknown as FeishuOnboardingDeps['channel'],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    workspaceRegistry: { list: () => [{ path: '/ws-1', name: 'Workspace One' }, { path: '/ws-2' }], create: vi.fn(async () => undefined) },
    agentPresets: {
      list: async () => [{ id: 'default', title: 'Default' }, { id: 'researcher', title: 'Researcher' }],
      defaultId: 'default',
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'openai', model: 'gpt-4o' }) },
    config: { workspace: '/ws-1', agentPreset: 'default', provider: 'openai', model: 'gpt-4o' },
    onModelStep: vi.fn(async () => undefined),
  }
}

function fire(handlers: Array<(evt: any) => void | Promise<void>>, evt: any): Promise<void[]> {
  return Promise.all(handlers.map(h => h(evt)))
}

describe('feishu-onboarding', () => {
  it('sends the onboarding card with a session dropdown for every session', async () => {
    const { channel, handlers } = fakeChannel()
    const bridge = fakeBridge()
    bridge.sessions.push({ id: 's-1', updatedAt: 1, title: 'First' })
    bridge.sessions.push({ id: 's-2', updatedAt: 2, title: 'Occupied', ownedBy: 'thread:oc_9:t_123' })
    const handle = startFeishuOnboarding(deps(channel, bridge))
    await handle.sendOnboardingCard({ chatId: 'oc_1', chatType: 'p2p' }, '这个对话框')
    expect(channel.createCardInstance).toHaveBeenCalledOnce()
    const card = channel.createCardInstance.mock.calls[0]![0] as any
    expect(card.schema).toBe('2.0')
    const contents = JSON.stringify(card)
    expect(contents).toContain('First')
    expect(contents).toContain('Occupied')
    expect(contents).toContain('🔒')
    expect(contents).toContain('select_static')
    expect(contents).toContain('新建会话')
    expect(handlers.length).toBe(1)
    handle.dispose()
  })

  it('attach form submission force-takes over the chosen session', async () => {
    const { channel, handlers } = fakeChannel()
    const bridge = fakeBridge()
    const handle = startFeishuOnboarding(deps(channel, bridge))
    await fire(handlers, {
      chatId: 'oc_1',
      messageId: 'm-1',
      action: { value: JSON.stringify({ kind: 'attach' }) },
      raw: { action: { form_value: { session: 's-1' } } },
    })
    expect(bridge.current.attachSession).toHaveBeenCalledWith({ chatId: 'oc_1', chatType: 'p2p' }, 's-1')
    expect(channel.createCardInstance).toHaveBeenCalled()
    handle.dispose()
  })

  it('new action starts the workspace → preset → model flow', async () => {
    const { channel, handlers } = fakeChannel()
    const bridge = fakeBridge()
    const onModelStep = vi.fn(async () => undefined)
    const handle = startFeishuOnboarding({ ...deps(channel, bridge), onModelStep })
    // "new" → workspace picker (fresh card)
    await fire(handlers, { chatId: 'oc_1', action: { value: JSON.stringify({ kind: 'new' }) } })
    let card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    expect(JSON.stringify(card)).toContain('选择工作区')
    // pick workspace → preset picker (updates the referenced card instance)
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-workspace', value: '/ws-2' }) } })
    expect(channel.updateCardInstance).toHaveBeenCalled()
    card = channel.updateCardInstance.mock.calls.at(-1)![1] as any
    expect(JSON.stringify(card)).toContain('选择 Agent 模板')
    // pick preset → model step
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-preset', value: 'researcher' }) } })
    expect(onModelStep).toHaveBeenCalledWith(
      { chatId: 'oc_1', chatType: 'p2p' },
      'm-ref',
      { workspace: '/ws-2', agentPreset: 'researcher' },
    )
    handle.dispose()
  })

  it('create-workspace form creates the workspace and advances to preset picker', async () => {
    const { channel, handlers } = fakeChannel()
    const bridge = fakeBridge()
    const create = vi.fn(async () => undefined)
    const d = deps(channel, bridge)
    d.workspaceRegistry = { list: () => [], create }
    const handle = startFeishuOnboarding(d)
    await fire(handlers, {
      chatId: 'oc_1',
      messageId: 'm-ref',
      action: { value: JSON.stringify({ kind: 'create-workspace' }) },
      raw: { action: { form_value: { workspace_path: '~/projects/my-app' } } },
    })
    expect(create).toHaveBeenCalledWith(expect.stringMatching(/\/projects\/my-app$/))
    expect(channel.createCardInstance).toHaveBeenCalled()
    const card = channel.createCardInstance.mock.calls.at(-1)![0] as any
    expect(JSON.stringify(card)).toContain('选择 Agent 模板')
    handle.dispose()
  })

  it('attach form submitted from a topic card binds the THREAD key, not the main chat key', async () => {
    const { channel, handlers } = fakeChannel()
    const bridge = fakeBridge()
    const handle = startFeishuOnboarding(deps(channel, bridge))
    // First-message onboarding card in a topic records the topic context.
    await handle.sendOnboardingCard(
      { chatId: 'oc_1', chatType: 'group', threadId: 'omt_9', rootId: 'om_root' },
      '这个话题',
    )
    // Attach form submitted from the topic's card. Card action events carry
    // only chatId + messageId, so the handler must restore threadId/rootId
    // from the recorded topic context or the binding would land on
    // `chat:oc_1` (main chat) instead of `thread:oc_1:omt_9`.
    await fire(handlers, {
      chatId: 'oc_1',
      messageId: 'm-1',
      action: { value: JSON.stringify({ kind: 'attach' }) },
      raw: { action: { form_value: { session: 's-1' } } },
    })
    expect(bridge.current.attachSession).toHaveBeenCalledWith(
      { chatId: 'oc_1', chatType: 'p2p', threadId: 'omt_9', rootId: 'om_root' },
      's-1',
    )
    // The success card is sent as a topic reply to the root message.
    expect(channel.sendCardByReference).toHaveBeenCalledWith(
      'oc_1',
      expect.any(String),
      { replyInThread: true, replyTo: 'om_root' },
    )
    handle.dispose()
  })

  it('noteTopic records slash-command topic context for later card actions', async () => {
    const { channel, handlers } = fakeChannel()
    const bridge = fakeBridge()
    const onModelStep = vi.fn(async () => undefined)
    const handle = startFeishuOnboarding({ ...deps(channel, bridge), onModelStep })
    // A slash command (`/new`) in a topic records the thread key.
    handle.noteTopic({ chatId: 'oc_1', chatType: 'group', threadId: 'omt_9', rootId: 'om_root' })
    // The workspace picker card clicked in the topic advances the flow with
    // topic context restored on the chatMessage.
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-workspace', value: '/ws-2' }) } })
    await fire(handlers, { chatId: 'oc_1', messageId: 'm-ref', action: { value: JSON.stringify({ kind: 'pick-preset', value: 'researcher' }) } })
    expect(onModelStep).toHaveBeenCalledWith(
      { chatId: 'oc_1', chatType: 'p2p', threadId: 'omt_9', rootId: 'om_root' },
      'm-ref',
      { workspace: '/ws-2', agentPreset: 'researcher' },
    )
    handle.dispose()
  })
})
