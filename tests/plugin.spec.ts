import { describe, expect, it, vi } from 'vitest'
import { startChannel } from '../src/channel.ts'
import type { AttachmentId, ImageAttachmentRef, ImageMediaType, ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'

/** Flush the microtask queue so fire-and-forget promises settle. */
const flushAsync = () => new Promise<void>(resolve => setTimeout(resolve, 0))

const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 10_000_000,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100_000_000,
  maxImagePixels: 40_000_000,
  maxImageDimension: 4096,
  mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const,
}

function fakeImageRef(input: { data: Uint8Array; mediaType: string; name?: string }): ImageAttachmentRef {
  return {
    attachmentId: `att_${input.data.byteLength}` as AttachmentId,
    mediaType: input.mediaType as ImageMediaType,
    bytes: input.data.byteLength,
    width: 1,
    height: 1,
    ...input.name === undefined ? {} : { name: input.name },
  }
}

function fakeAttachments(overrides: { saveImage?: (input: any) => Promise<ImageAttachmentRef> } = {}) {
  return {
    saveImage: vi.fn(overrides.saveImage ?? (async input => fakeImageRef(input))),
    imageLimits: IMAGE_LIMITS,
  }
}

function fakeChannel(imageBytes?: Buffer) {
  const handlers = new Map<string, Function>()
  // Minimal SDK download-response shape: the wrapper exposes a readable stream.
  const fakeReadable = (bytes: Buffer): { getReadableStream: () => unknown; writeFile: unknown; headers: unknown } => ({
    getReadableStream: () => {
      const { Readable } = require('node:stream') as typeof import('node:stream')
      return Readable.from(bytes)
    },
    writeFile: vi.fn(async () => undefined),
    headers: {},
  })
  return {
    handlers,
    connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ messageId: 'out' })),
    addReaction: vi.fn(async () => 'reaction-id'),
    rawClient: {
      im: {
        v1: {
          messageResource: {
            get: vi.fn(async () => fakeReadable(imageBytes ?? Buffer.from([0xff, 0xd8, 0xff, 0xe0]))),
          },
        },
      },
    },
    on: vi.fn((name: string, handler: Function) => { handlers.set(name, handler); return () => handlers.delete(name) }),
  }
}

describe('startChannel', () => {
  it('uses WebSocket policy defaults and replies to the inbound message', async () => {
    const channel = fakeChannel()
    const factory = vi.fn(() => channel as any)
    const bridge = { reply: vi.fn(async () => 'Hello **Lark**'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false) }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', reactEmoji: 'THUMBSUP', showIntermediateMessages: false, showReasoning: true,
    }, bridge, factory, logger)
    expect(logger.info).toHaveBeenCalledWith('dsh-feishu: WebSocket connected')
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ transport: 'websocket', policy: expect.objectContaining({ requireMention: true, dmMode: 'open' }), wsConfig: expect.objectContaining({ pingTimeout: expect.any(Number) }) }))
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await flushAsync()
    expect(channel.addReaction).toHaveBeenCalledWith('om_1', 'THUMBSUP')
    expect(bridge.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'hi' }))
    // Reply card is no longer sent separately — step cards from feishu-streaming handle it.
    await stop()
    expect(channel.disconnect).toHaveBeenCalledOnce()
    expect(bridge.dispose).toHaveBeenCalledOnce()
    expect(logger.info).toHaveBeenCalledWith('dsh-feishu: WebSocket disconnected')
  })

  it('skips the reaction when reactEmoji is empty', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'ok'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false) }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: '', showIntermediateMessages: false, showReasoning: true,
    }, bridge, () => channel as any, logger)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await flushAsync()
    expect(channel.addReaction).not.toHaveBeenCalled()
    // Reply card is no longer sent separately — step cards from feishu-streaming handle it.
    await stop()
  })

  it('logs a warning but still replies when the reaction fails', async () => {
    const channel = fakeChannel()
    channel.addReaction.mockRejectedValueOnce(new Error('reaction denied'))
    const bridge = { reply: vi.fn(async () => 'ok'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false) }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP', showIntermediateMessages: false, showReasoning: true,
    }, bridge, () => channel as any, logger)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' })
    await flushAsync()
    expect(logger.warn).toHaveBeenCalledWith('dsh-feishu: reaction failed: reaction denied')
    // Reply card is no longer sent separately — step cards from feishu-streaming handle it.
    await stop()
  })

  it('surfaces the turn failure reason instead of a bare apology', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => { throw new Error('secret stack') }), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false) }
    const terminal = { error: vi.fn() }
    await startChannel({ appId: 'id', appSecret: 'secret', domain: 'lark', requireMention: true, dmMode: 'open', groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', reactEmoji: 'THUMBSUP', showIntermediateMessages: false, showReasoning: true }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, terminal)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'group', threadId: 'omt_1', content: 'hi' })
    await flushAsync()
    expect(terminal.error).toHaveBeenCalledWith('dsh-feishu: message handling failed: secret stack')
    expect(channel.send).toHaveBeenCalledWith('oc_1', { text: '处理这条消息时出错：secret stack' }, { replyTo: 'om_1', replyInThread: true })
  })

  it('disposes conversation resources when channel disconnect fails', async () => {
    const channel = fakeChannel()
    channel.disconnect.mockRejectedValueOnce(new Error('disconnect failed'))
    const bridge = { reply: vi.fn(async () => ''), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false) }
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'lark', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', reactEmoji: 'THUMBSUP', showIntermediateMessages: false, showReasoning: true,
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })
    await expect(stop()).rejects.toThrow('disconnect failed')
    expect(bridge.dispose).toHaveBeenCalledOnce()
  })

  it('logs an initial connection failure to the Harness logger and terminal without exposing the secret', async () => {
    const channel = fakeChannel()
    channel.connect.mockRejectedValueOnce(new Error('authentication failed for secret'))
    const bridge = { reply: vi.fn(async () => ''), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false) }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const terminal = { error: vi.fn() }

    await expect(startChannel({
      appId: 'id', appSecret: 'secret', domain: 'lark', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', reactEmoji: 'THUMBSUP', showIntermediateMessages: false, showReasoning: true,
    }, bridge, () => channel as any, logger, terminal)).rejects.toThrow('authentication failed for secret')

    expect(logger.error).toHaveBeenCalledWith('dsh-feishu: WebSocket connection failed: authentication failed for [redacted]')
    expect(terminal.error).toHaveBeenCalledWith('dsh-feishu: WebSocket connection failed: authentication failed for [redacted]')
    expect(bridge.dispose).toHaveBeenCalledOnce()
  })

  it('routes a slash command through the handler instead of the bridge', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'agent answer'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false) }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const slashCommand = vi.fn(async () => ({ kind: 'success' as const, text: 'command answer' }))
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP', showIntermediateMessages: false, showReasoning: true,
    }, bridge, () => channel as any, logger, undefined, slashCommand)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: '/model list' })
    expect(slashCommand).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_1', content: '/model list' }))
    expect(bridge.reply).not.toHaveBeenCalled()
    expect(channel.send).toHaveBeenCalledWith('oc_1', { text: 'command answer' }, { replyTo: 'om_1', replyInThread: false })
    await stop()
  })

  it('falls back to the bridge reply when the slash handler returns undefined', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'agent answer'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false) }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const slashCommand = vi.fn(async () => undefined)
    await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP', showIntermediateMessages: false, showReasoning: true,
    }, bridge, () => channel as any, logger, undefined, slashCommand)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hello world' })
    await flushAsync()
    expect(slashCommand).toHaveBeenCalledOnce()
    expect(bridge.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello world' }))
    // Reply card is no longer sent separately — step cards from feishu-streaming handle it.
  })

  it('reports a slash-command failure with the safe fallback and skips the bridge', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'agent answer'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false) }
    const terminal = { error: vi.fn() }
    const slashCommand = vi.fn(async () => { throw new Error('boom') })
    await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP', showIntermediateMessages: false, showReasoning: true,
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, terminal, slashCommand)
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: '/model' })
    expect(bridge.reply).not.toHaveBeenCalled()
    expect(terminal.error).toHaveBeenCalledWith('dsh-feishu: slash command failed: boom')
    expect(channel.send).toHaveBeenCalledWith('oc_1', { text: '命令执行出错：boom' }, { replyTo: 'om_1', replyInThread: false })
  })

  it('downloads image resources and attaches ImageBlocks to the bridge call', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'described image'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false) }
    const attachments = fakeAttachments()
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP', showIntermediateMessages: false, showReasoning: true,
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, undefined, attachments)
    await channel.handlers.get('message')!({
      messageId: 'om_2', chatId: 'oc_2', chatType: 'p2p', content: '',
      resources: [{ type: 'image', fileKey: 'img_abc' }],
    })
    await flushAsync()
    expect(channel.rawClient.im.v1.messageResource.get).toHaveBeenCalledWith({
      params: { type: 'image' },
      path: { message_id: 'om_2', file_key: 'img_abc' },
    })
    expect(attachments.saveImage).toHaveBeenCalledOnce()
    expect(bridge.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: '',
      imageBlocks: [expect.objectContaining({ mediaType: 'image/jpeg', bytes: 4 })],
    }))
    // Reply card is no longer sent separately — step cards from feishu-streaming handle it.
    await stop()
  })

  it('derives image media type from the downloaded bytes, not a guessed MIME (PNG)', async () => {
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A ...
    const channel = fakeChannel(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]))
    const bridge = { reply: vi.fn(async () => 'described image'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false) }
    const attachments = fakeAttachments()
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP', showIntermediateMessages: false, showReasoning: true,
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, undefined, attachments)
    await channel.handlers.get('message')!({
      messageId: 'om_png', chatId: 'oc_png', chatType: 'p2p', content: '',
      resources: [{ type: 'image', fileKey: 'img_png' }],
    })
    await flushAsync()
    expect(attachments.saveImage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'image/png' }))
    expect(bridge.reply).toHaveBeenCalledWith(expect.objectContaining({
      imageBlocks: [expect.objectContaining({ mediaType: 'image/png' })],
    }))
    await stop()
  })

  it('rejects image-bearing messages when no attachment service is composed', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'should not happen'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false) }
    await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP', showIntermediateMessages: false, showReasoning: true,
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })
    await channel.handlers.get('message')!({
      messageId: 'om_3', chatId: 'oc_3', chatType: 'p2p', content: '',
      resources: [{ type: 'image', fileKey: 'img_no_store' }],
    })
    expect(channel.send).toHaveBeenCalledWith(
      'oc_3',
      { text: 'Image messages are not supported because the deployment has no attachment service composed.' },
      { replyTo: 'om_3', replyInThread: false },
    )
    expect(bridge.reply).not.toHaveBeenCalled()
  })

  it('reports image-admission failures with the safe fallback and skips the bridge', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => 'should not happen'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false) }
    const terminal = { error: vi.fn() }
    const attachments = fakeAttachments({
      saveImage: async () => { throw new Error('storage full') },
    })
    await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP', showIntermediateMessages: false, showReasoning: true,
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, terminal, undefined, attachments)
    await channel.handlers.get('message')!({
      messageId: 'om_4', chatId: 'oc_4', chatType: 'p2p', content: '',
      resources: [{ type: 'image', fileKey: 'img_fail' }],
    })
    expect(terminal.error).toHaveBeenCalledWith('dsh-feishu: image admission failed: storage full')
    expect(bridge.reply).not.toHaveBeenCalled()
    expect(channel.send).toHaveBeenCalledWith('oc_4', { text: '图片处理出错：storage full' }, { replyTo: 'om_4', replyInThread: false })
  })

  it('admits files into the session workspace .feishu-inbox and injects the path', async () => {
    const channel = fakeChannel()
    const bridge: any = { reply: vi.fn(async () => 'ok'), dispose: vi.fn(async () => undefined), consumeIntermediateSent: vi.fn(() => false), resolveSessionIdFor: vi.fn(() => 'test-session'), needsOnboarding: vi.fn(async () => false) }
    const workspaceRoot = await (await import('node:fs/promises')).mkdtemp('/tmp/dsh-test-ws-')
    const resolveWorkspaceRoot = vi.fn(async () => workspaceRoot)
    const { stop } = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', reactEmoji: 'THUMBSUP', showIntermediateMessages: false, showReasoning: true,
    }, bridge, () => channel as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, resolveWorkspaceRoot)
    await channel.handlers.get('message')!({
      messageId: 'om_file', chatId: 'oc_file', chatType: 'p2p', content: '',
      resources: [{ type: 'file', fileKey: 'file_abc', fileName: 'report.pdf' }],
    })
    await flushAsync()
    expect(channel.rawClient.im.v1.messageResource.get).toHaveBeenCalledWith({
      params: { type: 'file' },
      path: { message_id: 'om_file', file_key: 'file_abc' },
    })
    expect(resolveWorkspaceRoot).toHaveBeenCalled()
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(`${workspaceRoot}/.feishu-inbox`)
    expect(files.length).toBeGreaterThan(0)
    const injected = (bridge.reply.mock.calls[0]![0] as { content: string }).content
    expect(injected).toContain('[文件: report.pdf')
    expect(injected).toContain(`${workspaceRoot}/.feishu-inbox`)
    await stop()
  })
})
