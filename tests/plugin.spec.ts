import { describe, expect, it, vi } from 'vitest'
import { startChannel } from '../src/channel.ts'

function fakeChannel() {
  const handlers = new Map<string, Function>()
  return {
    handlers,
    connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ messageId: 'out' })),
    addReaction: vi.fn(async () => 'reaction-id'),
    on: vi.fn((name: string, handler: Function) => { handlers.set(name, handler); return () => handlers.delete(name) }),
  }
}

describe('startChannel', () => {
  it('uses WebSocket policy defaults and replies to the inbound message', async () => {
    const channel = fakeChannel()
    const factory = vi.fn(() => channel as any)
    const bridge = { reply: vi.fn(async () => 'Hello **Lark**'), dispose: vi.fn(async () => undefined) }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const stop = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', reactEmoji: 'THUMBSUP',
    }, bridge, factory, logger)
    expect(logger.info).toHaveBeenCalledWith('dsh-lark: WebSocket connected')
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ transport: 'websocket', policy: expect.objectContaining({ requireMention: true, dmMode: 'open' }) }))
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    expect(channel.addReaction).toHaveBeenCalledWith('om_1', 'THUMBSUP')
    expect(bridge.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'hi' }))
    expect(channel.send).toHaveBeenCalledWith('oc_1', { markdown: 'Hello **Lark**' }, { replyTo: 'om_1', replyInThread: false })
    await stop()
    expect(channel.disconnect).toHaveBeenCalledOnce()
    expect(bridge.dispose).toHaveBeenCalledOnce()
    expect(logger.info).toHaveBeenCalledWith('dsh-lark: WebSocket disconnected')
  })

  it('skips the reaction when reactEmoji is empty', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'ok'), dispose: vi.fn(async () => undefined) }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const stop = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '',
    }, bridge, () => channel as any, logger)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    expect(channel.addReaction).not.toHaveBeenCalled()
    expect(channel.send).toHaveBeenCalledWith('oc_1', { markdown: 'ok' }, { replyTo: 'om_1', replyInThread: false })
    await stop()
  })

  it('logs a warning but still replies when the reaction fails', async () => {
    const channel = fakeChannel()
    channel.addReaction.mockRejectedValueOnce(new Error('reaction denied'))
    const bridge = { reply: vi.fn(async () => 'ok'), dispose: vi.fn(async () => undefined) }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const stop = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',
    }, bridge, () => channel as any, logger)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    expect(logger.warn).toHaveBeenCalledWith('dsh-lark: reaction failed: reaction denied')
    expect(channel.send).toHaveBeenCalledWith('oc_1', { markdown: 'ok' }, { replyTo: 'om_1', replyInThread: false })
    await stop()
  })

  it('sends a safe fallback when the Harness turn fails', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => { throw new Error('secret stack') }), dispose: vi.fn(async () => undefined) }
    const terminal = { error: vi.fn() }
    await startChannel({ appId: 'id', appSecret: 'secret', domain: 'lark', requireMention: true, dmMode: 'open', groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', reactEmoji: 'THUMBSUP' }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, terminal)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'group', threadId: 'omt_1', content: 'hi' })
    expect(terminal.error).toHaveBeenCalledWith('dsh-lark: message handling failed: secret stack')
    expect(channel.send).toHaveBeenCalledWith('oc_1', { text: 'safe error' }, { replyTo: 'om_1', replyInThread: true })
  })

  it('disposes conversation resources when channel disconnect fails', async () => {
    const channel = fakeChannel()
    channel.disconnect.mockRejectedValueOnce(new Error('disconnect failed'))
    const bridge = { reply: vi.fn(async () => ''), dispose: vi.fn(async () => undefined) }
    const stop = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'lark', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', reactEmoji: 'THUMBSUP',
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })
    await expect(stop()).rejects.toThrow('disconnect failed')
    expect(bridge.dispose).toHaveBeenCalledOnce()
  })

  it('logs an initial connection failure to the Harness logger and terminal without exposing the secret', async () => {
    const channel = fakeChannel()
    channel.connect.mockRejectedValueOnce(new Error('authentication failed for secret'))
    const bridge = { reply: vi.fn(async () => ''), dispose: vi.fn(async () => undefined) }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const terminal = { error: vi.fn() }

    await expect(startChannel({
      appId: 'id', appSecret: 'secret', domain: 'lark', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', reactEmoji: 'THUMBSUP',
    }, bridge, () => channel as any, logger, terminal)).rejects.toThrow('authentication failed for secret')

    expect(logger.error).toHaveBeenCalledWith('dsh-lark: WebSocket connection failed: authentication failed for [redacted]')
    expect(terminal.error).toHaveBeenCalledWith('dsh-lark: WebSocket connection failed: authentication failed for [redacted]')
    expect(bridge.dispose).toHaveBeenCalledOnce()
  })

  it('routes a slash command through the handler instead of the bridge', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'agent answer'), dispose: vi.fn(async () => undefined) }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const slashCommand = vi.fn(async () => ({ kind: 'success' as const, text: 'command answer' }))
    const stop = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',
    }, bridge, () => channel as any, logger, undefined, slashCommand)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: '/model list' })
    expect(slashCommand).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_1', content: '/model list' }))
    expect(bridge.reply).not.toHaveBeenCalled()
    expect(channel.send).toHaveBeenCalledWith('oc_1', { text: 'command answer' }, { replyTo: 'om_1', replyInThread: false })
    await stop()
  })

  it('falls back to the bridge reply when the slash handler returns undefined', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'agent answer'), dispose: vi.fn(async () => undefined) }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const slashCommand = vi.fn(async () => undefined)
    await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',
    }, bridge, () => channel as any, logger, undefined, slashCommand)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hello world' })
    expect(slashCommand).toHaveBeenCalledOnce()
    expect(bridge.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello world' }))
    expect(channel.send).toHaveBeenCalledWith('oc_1', { markdown: 'agent answer' }, { replyTo: 'om_1', replyInThread: false })
  })

  it('reports a slash-command failure with the safe fallback and skips the bridge', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'agent answer'), dispose: vi.fn(async () => undefined) }
    const terminal = { error: vi.fn() }
    const slashCommand = vi.fn(async () => { throw new Error('boom') })
    await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP',
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, terminal, slashCommand)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: '/model' })
    expect(bridge.reply).not.toHaveBeenCalled()
    expect(terminal.error).toHaveBeenCalledWith('dsh-lark: slash command failed: boom')
    expect(channel.send).toHaveBeenCalledWith('oc_1', { text: 'safe error' }, { replyTo: 'om_1', replyInThread: false })
  })
})
