/**
 * `feishu_receive_file` model tool: lets the agent pull an inbound Feishu file
 * resource into the session's workspace inbox.
 *
 * The channel service auto-admits file resources carried on a normal message
 * (it downloads them and injects a `[文件: name → path]` reference). But when
 * a file reference is NOT auto-admitted — e.g. a message whose resource key
 * never got pulled, or a downstream agent that wants the bytes on demand —
 * this tool lets the agent fetch it directly by its Feishu identifiers
 * (`message_id` + `file_key`, the pair `im.v1.messageResource.get` needs) and
 * persists it to `<workspace>/.feishu-inbox/` so it shares the same landing
 * dir as auto-admitted files.
 *
 * Like `feishu_send_file`, this is the model-side counterpart to the channel's
 * inbound admission: send pushes a workspace file out; receive pulls a Feishu
 * file resource in. The download bypasses the SDK's normalized resources (it
 * operates on explicit ids), so it works even when the normalized message did
 * not surface the resource.
 *
 * @module @starxer/chatterbox4dsh/feishu-receive-file
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { HarnessConversationService } from './harness.ts'
import { errorText } from './error-text.ts'

/** Feishu file-message ceiling (`resource.get` rejects > 30 MB upstream). */
const MAX_FILE_BYTES = 30 * 1024 * 1024

/** Minimal logger surface; matches ctx.logger's call style. */
interface PluginLogger {
  warn(message: string): unknown
  error(message: string): unknown
}

/** Live references read lazily on every execution (channel/bridge reconcile). */
export interface FeishuReceiveFileDeps {
  ctx: Context
  /** Reverse lookup: sessionId → bound chat message. */
  bridgeHolder: { current: HarnessConversationService | undefined }
  channelHolder: { current: LarkChannel | undefined }
  /** Resolve the workspace root for a session's bound chat. */
  resolveWorkspaceRoot(sessionId: string): Promise<string | undefined>
  logger: PluginLogger
}

/**
 * Register the `feishu_receive_file` tool on the global host context (visible
 * to every agent). Unbound sessions fail at execution time with a clear error
 * instead of at registration.
 *
 * @param deps Live references to the host context, bridge, and channel.
 * @returns the exact disposer that unregisters the tool.
 */
export function startFeishuReceiveFileTool(deps: FeishuReceiveFileDeps): () => void {
  const { ctx, bridgeHolder, channelHolder, resolveWorkspaceRoot, logger } = deps

  return ctx.tools.register(defineTool({
    name: 'feishu_receive_file',
    description:
      'Download an inbound Feishu file into the current session\'s workspace '
      + 'inbox (`.feishu-inbox/`). Requires the message_id and file_key of the '
      + 'file (the pair shown in an incoming file reference). Returns the local '
      + 'path the agent can then open with its file tools. Only works when the '
      + 'current session is bound to a Feishu chat and its workspace resolves.',
    parameters: {
      message_id: {
        type: 'string',
        required: true,
        description: 'The Feishu message id that carries the file resource.',
      },
      file_key: {
        type: 'string',
        required: true,
        description: 'The Feishu file_key of the resource to download.',
      },
      file_name: {
        type: 'string',
        description: 'Optional display/file name (defaults to the file_key). Used only for the on-disk name.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_name: { type: 'string', required: true },
          path: { type: 'string', required: true },
          workspace: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Received "${value.file_name}" into ${value.path} (workspace ${value.workspace}).`,
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('feishu_receive_file requires an agent-backed session')
      }
      exec.signal.throwIfAborted()

      const bridge = bridgeHolder.current
      if (bridge === undefined) {
        throw new Error('dsh-feishu: bridge not ready — try again after the channel connects')
      }
      const chat = bridge.resolveChat(agent.id)
      if (chat === undefined) {
        throw new Error(
          'This session is not bound to a Feishu chat, so there is no channel to pull the file from.',
        )
      }
      const ch = channelHolder.current
      if (ch === undefined) {
        throw new Error('dsh-feishu: channel not connected — try again later')
      }

      exec.signal.throwIfAborted()
      const root = await resolveWorkspaceRoot(agent.id)
      const inboxDir = root !== undefined && root.trim() !== ''
        ? join(root, '.feishu-inbox')
        : await (async () => {
            const { join: j } = await import('node:path')
            const { homedir } = await import('node:os')
            const dshHome = process.env.DSH_HOME || `${homedir()}/.dsh`
            return j(dshHome, 'feishu-inbox')
          })()
      await mkdir(inboxDir, { recursive: true })

      exec.signal.throwIfAborted()
      // `rawClient` reaches the real `im.v1.messageResource.get` endpoint,
      // which needs `(message_id, file_key)` together (the SDK's typed
      // `downloadResource` routes user-sent keys to the wrong endpoint). The
      // SDK returns `{ getReadableStream, ... }` rather than a Buffer.
      const raw: unknown = await (ch as unknown as { rawClient: any }).rawClient.im.v1.messageResource.get({
        params: { type: 'file' },
        path: { message_id: args.message_id, file_key: args.file_key },
      })

      let bytes: Buffer
      if (Buffer.isBuffer(raw)) {
        bytes = raw
      } else if (raw instanceof Uint8Array) {
        bytes = Buffer.from(raw)
      } else if (raw !== null && typeof raw === 'object' && typeof (raw as { getReadableStream?: () => unknown }).getReadableStream === 'function') {
        const { Readable } = await import('node:stream')
        const stream = (raw as { getReadableStream: () => unknown }).getReadableStream()
        if (!(stream instanceof Readable)) throw new Error('dsh-feishu: unexpected stream type from messageResource.get')
        const chunks: Buffer[] = []
        for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
        bytes = Buffer.concat(chunks)
      } else {
        throw new Error('dsh-feishu: unsupported download response shape')
      }

      if (bytes.length === 0) {
        throw new Error('Feishu returned an empty file — returning no local path.')
      }
      if (bytes.length > MAX_FILE_BYTES) {
        throw new Error(`File is ${bytes.length} bytes, over Feishu's 30 MB limit: ${args.file_key}`)
      }

      const fileName = (args.file_name ?? args.file_key).replace(/[^a-zA-Z0-9._-]/g, '_') || args.file_key
      const ts = Date.now()
      const filePath = join(inboxDir, `${ts}_${fileName}`)
      await writeFile(filePath, bytes)
      logger.warn(`dsh-feishu: feishu_receive_file pulled "${fileName}" (message ${args.message_id}) into ${filePath}`)

      return {
        file_name: fileName,
        path: filePath,
        workspace: root ?? '(fallback)',
      }
    },
  }))
}
