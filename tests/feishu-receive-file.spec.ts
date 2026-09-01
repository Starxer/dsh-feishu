import { describe, expect, it, vi } from 'vitest'
import { startFeishuReceiveFileTool } from '../src/feishu-receive-file.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { HarnessConversationService } from '../src/harness.ts'

/** Minimal Cordis context exposing only tools.register. */
function fakeCtx() {
  const registered: Array<{ name: string; exec: (args: any) => Promise<unknown> }> = []
  return {
    registered,
    scope: { fork: undefined },
    tools: {
      register: (tool: any) => {
        registered.push(tool)
        return () => undefined
      },
    },
  }
}

/** Minimal channel exposing the raw resource client + a curlable download. */
function fakeChannel(downloadBytes: Buffer) {
  const { Readable } = require('node:stream') as typeof import('node:stream')
  return {
    send: vi.fn(async () => ({ messageId: 'm' })),
    rawClient: {
      im: {
        v1: {
          messageResource: {
            get: vi.fn(async () => ({
              getReadableStream: () => Readable.from(downloadBytes),
              writeFile: undefined,
              headers: {},
            })),
          },
        },
      },
    },
  } as unknown as LarkChannel
}

describe('startFeishuReceiveFileTool', () => {
  async function tempRoot(): Promise<string> {
    const { tmpdir } = await import('node:os')
    const { mkdtemp } = await import('node:fs/promises')
    return mkdtemp(`${tmpdir()}/dsh-rx-`)
  }

  it('registers a tool named feishu_receive_file', async () => {
    const tempWorkspace = await tempRoot()
    const fake = fakeCtx()
    const ctx = fake as unknown as Context
    const channelHolder = { current: fakeChannel(Buffer.from('hi')) }
    const bridgeHolder = { current: {} as HarnessConversationService }
    const disposer = startFeishuReceiveFileTool({
      ctx,
      bridgeHolder,
      channelHolder,
      resolveWorkspaceRoot: async () => tempWorkspace,
      logger: { warn: vi.fn(), error: vi.fn() },
    })
    expect(fake.registered.some(t => t.name === 'feishu_receive_file')).toBe(true)
    disposer()
  })

  it('downloads by message_id + file_key into the workspace .feishu-inbox and returns the path', async () => {
    const tempWorkspace = await tempRoot()
    const fake = fakeCtx()
    const ctx = fake as unknown as Context
    const bytes = Buffer.from('pdf payload bytes')
    const channel = fakeChannel(bytes)
    const channelHolder = { current: channel }
    const bridge = {
      resolveChat: vi.fn(() => ({ chatId: 'oc_1', chatType: 'p2p' as const, threadId: undefined })),
    } as unknown as HarnessConversationService
    const bridgeHolder = { current: bridge }
    startFeishuReceiveFileTool({
      ctx,
      bridgeHolder,
      channelHolder,
      resolveWorkspaceRoot: async () => tempWorkspace,
      logger: { warn: vi.fn(), error: vi.fn() },
    })

    const tool = fake.registered.find((t: any) => t.name === 'feishu_receive_file') as any
    const agent = { id: 'sess_1' }
    const result = await tool.execute(
      { message_id: 'om_9', file_key: 'fkey_x', file_name: 'paper.pdf' },
      { agent, signal: { throwIfAborted: () => undefined } },
    )

    expect(channel.rawClient.im.v1.messageResource.get).toHaveBeenCalledWith({
      params: { type: 'file' },
      path: { message_id: 'om_9', file_key: 'fkey_x' },
    })
    expect(bridge.resolveChat).toHaveBeenCalledWith('sess_1')
    expect(result.file_name).toBe('paper.pdf')
    expect(result.workspace).toBe(tempWorkspace)
    expect(result.path).toContain(`${tempWorkspace}/.feishu-inbox`)
    expect(result.path).toContain('paper.pdf')
  })

  it('fails with a clear error for an unbound session', async () => {
    const tempWorkspace = await tempRoot()
    const fake = fakeCtx()
    const ctx = fake as unknown as Context
    const channelHolder = { current: fakeChannel(Buffer.from('hi')) }
    const bridgeHolder = { current: { resolveChat: vi.fn(() => undefined) } as unknown as HarnessConversationService }
    startFeishuReceiveFileTool({
      ctx,
      bridgeHolder,
      channelHolder,
      resolveWorkspaceRoot: async () => tempWorkspace,
      logger: { warn: vi.fn(), error: vi.fn() },
    })
    const tool = fake.registered.find((t: any) => t.name === 'feishu_receive_file') as any
    await expect(tool.execute(
      { message_id: 'om', file_key: 'fk' },
      { agent: { id: 'sess_x' }, signal: { throwIfAborted: () => undefined } },
    )).rejects.toThrow('not bound to a Feishu chat')
  })

  it('rejects empty downloads', async () => {
    const tempWorkspace = await tempRoot()
    const fake = fakeCtx()
    const ctx = fake as unknown as Context
    const channelHolder = { current: fakeChannel(Buffer.alloc(0)) }
    const bridgeHolder = { current: { resolveChat: vi.fn(() => ({ chatId: 'oc', chatType: 'p2p' as const })) } as unknown as HarnessConversationService }
    startFeishuReceiveFileTool({
      ctx,
      bridgeHolder,
      channelHolder,
      resolveWorkspaceRoot: async () => tempWorkspace,
      logger: { warn: vi.fn(), error: vi.fn() },
    })
    const tool = fake.registered.find((t: any) => t.name === 'feishu_receive_file') as any
    await expect(tool.execute(
      { message_id: 'om', file_key: 'fk' },
      { agent: { id: 'sess_x' }, signal: { throwIfAborted: () => undefined } },
    )).rejects.toThrow('empty file')
  })
})
