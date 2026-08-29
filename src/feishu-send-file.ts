/**
 * `feishu_send_file` model tool: lets the agent push a workspace file to the
 * user's Feishu chat.
 *
 * DSH itself has no "agent pushes a binary file to the client" primitive — the
 * agent writes files into the workspace, and the WebUI's `ui-deliverables`
 * plugin auto-links them. Feishu has no equivalent, so this tool gives the
 * agent an explicit way to deliver a produced file into the chat that owns the
 * current session.
 *
 * Sending goes through the SDK's `LarkChannel.send({ file })` path, which
 * uploads via `im.v1.file.create` (file_type `stream`, the generic "other
 * file" bucket) and then sends a file message — no hand-rolled upload + send
 * dance needed. Thread replies reuse the same `replyTo`/`replyInThread`
 * options the question/approval cards use.
 *
 * @module @starxer/dsh-feishu/feishu-send-file
 */

import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { HarnessConversationService } from './harness.ts'
import { errorText } from './error-text.ts'

/** Feishu file-message ceiling (`im.v1.file.create` rejects > 30 MB). */
const MAX_FILE_BYTES = 30 * 1024 * 1024

/** Minimal logger surface; matches ctx.logger's call style. */
interface PluginLogger {
  warn(message: string): unknown
  error(message: string): unknown
}

/** Live references read lazily on every execution (channel/bridge reconcile). */
export interface FeishuSendFileDeps {
  ctx: Context
  bridgeHolder: { current: HarnessConversationService | undefined }
  channelHolder: { current: LarkChannel | undefined }
  logger: PluginLogger
}

/**
 * Register the `feishu_send_file` tool on the global host context (visible to
 * every agent). Unbound sessions — e.g. a session created directly in the
 * WebUI — fail at execution time with a clear error instead of at registration.
 *
 * @param deps Live references to the host context, bridge, and channel.
 * @returns the exact disposer that unregisters the tool.
 */
export function startFeishuSendFileTool(deps: FeishuSendFileDeps): () => void {
  const { ctx, bridgeHolder, channelHolder, logger } = deps

  return ctx.tools.register(defineTool({
    name: 'feishu_send_file',
    description:
      'Send a file from the workspace to the user via Feishu chat. Pass the absolute filesystem '
      + 'path of the file you produced. The file must exist, be a regular non-empty file, and be '
      + 'under 30 MB. Only works when the current session is bound to a Feishu chat; otherwise it '
      + 'fails with a clear error and you should just tell the user the file path instead.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute filesystem path of the file to send (e.g. the path a write/edit tool returned).',
      },
      caption: {
        type: 'string',
        description: 'Optional short note sent as a text message just before the file.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_name: { type: 'string', required: true },
          message_id: { type: 'string', required: true },
          chat_id: { type: 'string', required: true },
          caption_sent: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Sent "${value.file_name}" to Feishu chat ${value.chat_id} (message ${value.message_id}).`,
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('feishu_send_file requires an agent-backed session')
      }
      exec.signal.throwIfAborted()

      const bridge = bridgeHolder.current
      if (bridge === undefined) {
        throw new Error('dsh-feishu: bridge not ready — try again after the channel connects')
      }
      const chat = bridge.resolveChat(agent.id)
      if (chat === undefined) {
        throw new Error(
          'This session is not bound to a Feishu chat, so there is no chat to send the file to. '
          + `Tell the user the file is at ${JSON.stringify(args.path)} instead.`,
        )
      }
      const ch = channelHolder.current
      if (ch === undefined) {
        throw new Error('dsh-feishu: channel not connected — try again later')
      }

      // Validate locally so failures carry actionable messages rather than a
      // Feishu API error (empty file, > 30 MB, missing path).
      let fileStat
      try {
        fileStat = await stat(args.path)
      } catch {
        throw new Error(`File not found or unreadable: ${args.path}`)
      }
      if (!fileStat.isFile()) {
        throw new Error(`Not a regular file: ${args.path}`)
      }
      if (fileStat.size === 0) {
        throw new Error(`File is empty (Feishu rejects empty files): ${args.path}`)
      }
      if (fileStat.size > MAX_FILE_BYTES) {
        throw new Error(`File is ${fileStat.size} bytes, over Feishu's 30 MB limit: ${args.path}`)
      }

      exec.signal.throwIfAborted()
      const bytes = await readFile(args.path)
      const fileName = basename(args.path)

      const opts = chat.threadId !== undefined
        ? { replyInThread: true as const, ...(chat.rootId !== undefined ? { replyTo: chat.rootId } : {}) }
        : {}

      // Optional caption first, so the explanation precedes the attachment.
      let captionSent = false
      if (args.caption !== undefined && args.caption.trim() !== '') {
        try {
          await ch.send(chat.chatId, { text: args.caption }, opts)
          captionSent = true
        } catch (error: unknown) {
          throw new Error(`Failed to send caption via Feishu: ${errorText(error, 'unknown Feishu error')}`)
        }
      }

      exec.signal.throwIfAborted()
      // Surfacing the specific reason (and Feishu API code, e.g. 230021 for an
      // oversized file) on failure lets the agent report exactly why the send
      // failed instead of a generic "send failed".
      const result = await ch.send(chat.chatId, { file: { source: bytes, fileName } }, opts).catch((error: unknown) => {
        throw new Error(`Failed to send "${fileName}" via Feishu: ${errorText(error, 'unknown Feishu error')}`)
      })
      logger.warn(`dsh-feishu: feishu_send_file sent "${fileName}" to chat ${chat.chatId}`)

      return {
        file_name: fileName,
        message_id: result.messageId ?? '',
        chat_id: chat.chatId,
        caption_sent: captionSent,
      }
    },
  }))
}
