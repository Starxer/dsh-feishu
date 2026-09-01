import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startFeishuSendFileTool } from '../src/feishu-send-file.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { HarnessConversationService } from '../src/harness.ts'

/** Minimal Cordis context exposing only tools.register. */
function fakeCtx() {
  const registered: Array<any> = []
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

function fakeChannel() {
  return {
    send: vi.fn(async () => ({ messageId: 'm' })),
  } as unknown as LarkChannel
}

/** Fake bridge that binds every session to a main chat. */
function fakeBridge(): HarnessConversationService {
  return {
    resolveChat: (() => ({ chatId: 'oc_x', chatType: 'p2p' })) as any,
  } as unknown as HarnessConversationService
}

async function tempFile(contents: Buffer, name = 'f'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-send-'))
  const p = join(dir, name)
  await writeFile(p, contents)
  return p
}

function execCtx(): any {
  return {
    agent: { id: 'session-1' },
    signal: { throwIfAborted: () => undefined },
  }
}

// PNG magic: 89 50 4E 47 0D 0A 1A 0A ...
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00])
// Plain text → not an image
const TXT_BYTES = Buffer.from('hello world')

describe('startFeishuSendFileTool', () => {
  it('registers a tool named feishu_send_file', async () => {
    const fake = fakeCtx()
    startFeishuSendFileTool({
      ctx: fake as unknown as Context,
      bridgeHolder: { current: fakeBridge() },
      channelHolder: { current: fakeChannel() },
      logger: { warn: vi.fn(), error: vi.fn() },
    })
    expect(fake.registered.some(t => t.name === 'feishu_send_file')).toBe(true)
  })

  it('sends real image bytes as an inline-preview image message', async () => {
    const p = await tempFile(PNG_BYTES, 'pic.png')
    const fake = fakeCtx()
    const ch = fakeChannel()
    startFeishuSendFileTool({
      ctx: fake as unknown as Context,
      bridgeHolder: { current: fakeBridge() },
      channelHolder: { current: ch },
      logger: { warn: vi.fn(), error: vi.fn() },
    })
    const tool = fake.registered.find(t => t.name === 'feishu_send_file')!
    const result: any = await tool.execute({ path: p }, execCtx())
    expect(ch.send).toHaveBeenCalledWith(
      'oc_x',
      expect.objectContaining({ image: expect.objectContaining({ source: expect.any(Buffer) }) }),
      {},
    )
    expect((ch.send as any).mock.calls[0][1].file).toBeUndefined()
    expect(result.file_name).toBe('pic.png')
  })

  it('sends non-image bytes as a file message', async () => {
    const p = await tempFile(TXT_BYTES, 'note.txt')
    const fake = fakeCtx()
    const ch = fakeChannel()
    startFeishuSendFileTool({
      ctx: fake as unknown as Context,
      bridgeHolder: { current: fakeBridge() },
      channelHolder: { current: ch },
      logger: { warn: vi.fn(), error: vi.fn() },
    })
    const tool = fake.registered.find(t => t.name === 'feishu_send_file')!
    await tool.execute({ path: p }, execCtx())
    expect(ch.send).toHaveBeenCalledWith(
      'oc_x',
      expect.objectContaining({ file: expect.objectContaining({ source: expect.any(Buffer), fileName: 'note.txt' }) }),
      {},
    )
    expect((ch.send as any).mock.calls[0][1].image).toBeUndefined()
  })
})
