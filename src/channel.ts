import { Readable } from 'node:stream'
import { Domain, LoggerLevel, createLarkChannel } from '@larksuiteoapi/node-sdk'
import type { LarkChannel, LarkChannelOptions, NormalizedMessage, ResourceDescriptor } from '@larksuiteoapi/node-sdk'
import type { AttachmentStore, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { RuntimeConfig } from './config.ts'
import type { HarnessConversationService, InboundMessage } from './harness.ts'

export type ChannelFactory = (options: LarkChannelOptions) => LarkChannel
export interface PluginLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/**
 * Dispatch a parsed slash command against the receiving chat.
 * Returning `undefined` means the message is not a command; the bridge
 * falls back to its ordinary agent reply.  When `card` is present the
 * channel sends it as an interactive card instead of plain text.
 */
export type SlashCommandHandler = (
  message: NormalizedMessage,
) => Promise<{ kind: 'success' | 'error'; text: string; card?: object } | undefined>

/** Narrow attachment-store view needed for image admission. */
type AttachmentLike = Pick<AttachmentStore, 'saveImage' | 'imageLimits'>

/** Feishu media type -> MIME type. Returns undefined when unsupported. */
const FEISHU_IMAGE_MIME = new Map<string, 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'>([
  ['image/jpeg', 'image/jpeg'],
  ['image/jpg', 'image/jpeg'],
  ['image/png', 'image/png'],
  ['image/webp', 'image/webp'],
  ['image/gif', 'image/gif'],
])

function pickImageMime(descriptor: ResourceDescriptor): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | undefined {
  const hint = descriptor.fileName?.toLowerCase() ?? ''
  if (hint.endsWith('.png')) return 'image/png'
  if (hint.endsWith('.jpg') || hint.endsWith('.jpeg')) return 'image/jpeg'
  if (hint.endsWith('.webp')) return 'image/webp'
  if (hint.endsWith('.gif')) return 'image/gif'
  // Feishu only tags `image` for image-only messages; there is no MIME hint
  // in the descriptor itself. Default to JPEG because Feishu mobile captures
  // are commonly JPEG; the validator re-checks against decoded magic bytes.
  return FEISHU_IMAGE_MIME.get('image/jpeg')
}

/**
 * Read the SDK download wrapper (which exposes its body as a Readable) into
 * a single buffer. `im.v1.image.get` and `im.v1.messageResource.get` both
 * return `{ writeFile, getReadableStream, headers }`, not a raw Buffer.
 */
async function readDownloadStream(raw: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof Uint8Array) return Buffer.from(raw)
  if (raw !== null && typeof raw === 'object' && typeof (raw as { getReadableStream?: () => unknown }).getReadableStream === 'function') {
    const stream = (raw as { getReadableStream: () => unknown }).getReadableStream()
    if (!(stream instanceof Readable)) throw new Error('dsh-feishu: unexpected stream type from messageResource.get')
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    return Buffer.concat(chunks)
  }
  throw new Error('dsh-feishu: unsupported download response shape')
}

/**
 * Pull every image resource off one normalized message, download it via the
 * correct `im.v1.messageResource` endpoint (user-sent images, NOT `im.v1.image`
 * which only serves bot-uploaded keys), and durably commit the bytes via the
 * attachment store. Returns an empty array when the message carries no images.
 */
async function admitImagesForMessage(
  channel: LarkChannel,
  message: NormalizedMessage,
  attachments: AttachmentLike,
  signal: AbortSignal,
): Promise<readonly ImageAttachmentRef[]> {
  const resources = (message.resources ?? []).filter(resource => resource.type === 'image')
  if (resources.length === 0) return []
  const accepted = attachments.imageLimits.mediaTypes
  const inputs: SaveImageAttachment[] = []
  for (const resource of resources) {
    const mediaType = pickImageMime(resource)
    if (mediaType === undefined || !accepted.includes(mediaType)) {
      throw new Error(`dsh-feishu: image type "${mediaType ?? 'unknown'}" is not accepted by the deployment`)
    }
    if (signal.aborted) throw new Error('dsh-feishu: image admission aborted')
    // `LarkChannel.downloadResource(fileKey, 'image')` resolves the wrong
    // endpoint (`im.v1.image.get`) which 400s for user-sent keys. The
    // `im.v1.messageResource.get` endpoint takes the message id plus the file
    // key, so reach into the raw HTTP client directly.
    const raw = await channel.rawClient.im.v1.messageResource.get({
      params: { type: 'image' },
      path: { message_id: message.messageId, file_key: resource.fileKey },
    })
    if (signal.aborted) throw new Error('dsh-feishu: image admission aborted')
    const bytes = await readDownloadStream(raw)
    inputs.push({
      data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      mediaType,
      ...resource.fileName === undefined ? {} : { name: resource.fileName },
    })
  }
  const refs: ImageAttachmentRef[] = []
  for (const input of inputs) refs.push(await attachments.saveImage(input))
  return refs
}

/** Metadata for the reply card footer. */
export interface ReplyCardMeta {
  workspace?: string
  agentPreset?: string
  model?: string
  reasoningEffort?: string
  contextWindow?: number
  lastInputTokens?: number
}

/** Chat coordinates passed to the footer callback for session lookup. */
export interface ChatCoordinates {
  chatId: string
  chatType: 'p2p' | 'group'
  threadId?: string
}

export async function startChannel(
  config: Omit<RuntimeConfig, 'appSecretRef'>,
  bridge: Pick<HarnessConversationService, 'reply' | 'dispose' | 'consumeIntermediateSent' | 'resolveSessionIdFor'>,
  factory: ChannelFactory = createLarkChannel,
  logger: PluginLogger = console,
  terminalLogger?: Pick<PluginLogger, 'error'>,
  slashCommand?: SlashCommandHandler,
  attachments?: AttachmentLike,
  replyCardMeta?: (coords: ChatCoordinates) => ReplyCardMeta | Promise<ReplyCardMeta>,
  consumeReasoning?: (sessionId: string) => string | undefined,
  consumeLastStepHadContent?: (sessionId: string) => boolean,
): Promise<{ stop: () => Promise<void>; channel: LarkChannel }> {
  const logError = (message: string) => {
    logger.error(message)
    terminalLogger?.error(message)
  }
  const channel = factory({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    domain: config.domain === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'dsh-feishu',
    loggerLevel: LoggerLevel.info,
    handshakeTimeoutMs: 15_000,
    policy: {
      requireMention: config.requireMention,
      dmMode: config.dmMode,
      groupAllowlist: config.groupAllowlist,
      dmAllowlist: config.dmAllowlist,
      respondToMentionAll: false,
    },
    safety: {
      chatQueue: { enabled: true },
      staleMessageWindowMs: 5 * 60_000,
      dedup: { ttl: 10 * 60_000, maxEntries: 10_000 },
    },
  })

  const unsubscribers = [
    channel.on('message', async (message: NormalizedMessage) => {
      const replyInThread = message.threadId !== undefined
      if (config.reactEmoji !== '') {
        try {
          await channel.addReaction(message.messageId, config.reactEmoji)
        } catch (error: unknown) {
          logger.warn(`dsh-feishu: reaction failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // Slash commands bypass the agent loop entirely; the registered
      // command handler resolves the chat's session and produces a direct
      // textual result.
      if (slashCommand !== undefined) {
        try {
          const commandResult = await slashCommand(message)
          if (commandResult !== undefined) {
            const payload = commandResult.card !== undefined ? { card: commandResult.card } : { text: commandResult.text }
            await channel.send(message.chatId, payload, {
              replyTo: message.messageId,
              replyInThread,
            })
            return
          }
        } catch (error: unknown) {
          logError(`dsh-feishu: slash command failed: ${error instanceof Error ? error.message : String(error)}`)
          await channel.send(message.chatId, { text: config.errorMessage }, {
            replyTo: message.messageId,
            replyInThread,
          }).catch((sendError: unknown) => {
            logError(`dsh-feishu: fallback reply failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`)
          })
          return
        }
      }
      // Admit any image resources on the inbound message through the
      // attachment store so the bridge can attach durable ImageBlocks to
      // the user turn. Without an attachment service we reject image-bearing
      // messages so the bridge never falls back to a text-only user turn
      // that would silently drop the image.
      let inboundMessage: InboundMessage = {
        chatId: message.chatId,
        chatType: message.chatType,
        ...message.threadId === undefined ? {} : { threadId: message.threadId },
        content: message.content,
      }
      if ((message.resources ?? []).some(resource => resource.type === 'image')) {
        if (attachments === undefined) {
          await channel.send(message.chatId, {
            text: 'Image messages are not supported because the deployment has no attachment service composed.',
          }, { replyTo: message.messageId, replyInThread }).catch(() => undefined)
          return
        }
        try {
          const imageBlocks = await admitImagesForMessage(channel, message, attachments, new AbortController().signal)
          inboundMessage = { ...inboundMessage, imageBlocks }
        } catch (error: unknown) {
          logError(`dsh-feishu: image admission failed: ${error instanceof Error ? error.message : String(error)}`)
          await channel.send(message.chatId, { text: config.errorMessage }, {
            replyTo: message.messageId,
            replyInThread,
          }).catch(() => undefined)
          return
        }
      }
      try {
        // Fire-and-forget: submit the message to the agent and return
        // immediately so the chatQueue can deliver the next message (e.g.
        // a slash command) without waiting for the agent turn to finish.
        // The reply card is sent asynchronously when the agent completes.
        const chatId = message.chatId
        const chatType = message.chatType
        const messageId = message.messageId
        const threadId = message.threadId
        void bridge.reply(inboundMessage).then(async (text) => {
          const sessionId = bridge.resolveSessionIdFor(inboundMessage)
          const intermediateSent = bridge.consumeIntermediateSent(sessionId)
          const meta = await replyCardMeta?.({ chatId, chatType, ...(threadId !== undefined ? { threadId } : {}) })

          if (intermediateSent) {
            // Streaming already sent a step card with the text content.
            // Only send the footer card (workspace/preset/model metadata).
            const footerCard = renderFooterCard(meta)
            if (footerCard !== undefined) {
              await channel.send(chatId, { card: footerCard }, {
                replyTo: messageId,
                replyInThread,
              })
            }
          } else {
            // No intermediate card was sent — send the full reply card.
            const card = renderReplyCard(text, meta)
            await channel.send(chatId, { card }, {
              replyTo: messageId,
              replyInThread,
            })
          }
        }).catch((error: unknown) => {
          logError(`dsh-feishu: message handling failed: ${error instanceof Error ? error.message : String(error)}`)
          void channel.send(chatId, { text: config.errorMessage }, {
            replyTo: messageId,
            replyInThread,
          }).catch((sendError: unknown) => {
            logError(`dsh-feishu: fallback reply failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`)
          })
        })
      } catch (error: unknown) {
        // Synchronous errors from bridge.reply() setup (rare)
        logError(`dsh-feishu: message dispatch failed: ${error instanceof Error ? error.message : String(error)}`)
        await channel.send(message.chatId, { text: config.errorMessage }, {
          replyTo: message.messageId,
          replyInThread,
        }).catch(() => undefined)
      }
    }),
    channel.on('reconnecting', () => { logger.warn('dsh-feishu: WebSocket reconnecting') }),
    channel.on('reconnected', () => { logger.info('dsh-feishu: WebSocket reconnected') }),
    channel.on('error', (error) => { logError(`dsh-feishu: channel error: ${String(error)}`) }),
  ]
  try {
    await channel.connect()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const redacted = config.appSecret === '' ? detail : detail.split(config.appSecret).join('[redacted]')
    logError(`dsh-feishu: WebSocket connection failed: ${redacted}`)
    for (const unsubscribe of unsubscribers) unsubscribe()
    await bridge.dispose()
    throw error
  }
  logger.info('dsh-feishu: WebSocket connected')

  return {
    channel,
    stop: async () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
      try {
        await channel.disconnect()
        logger.info('dsh-feishu: WebSocket disconnected')
      } finally {
        await bridge.dispose()
      }
    },
  }
}

/** Compact token count display: 517 / 12.2K / 1.2M */
function formatTokenCount(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}K`
  return `${Math.round(n / 100_000) / 10}M`
}

/**
 * Render a reasoning-only card for the two-phase reply pattern.
 * Shown first, then updated with the full reply content.
 */
function renderReasoningForReply(reasoning: string): object {
  const displayReasoning = reasoning.length > 5000 ? reasoning.slice(0, 5000) + '\n…(truncated)' : reasoning
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Thinking' },
      template: 'violet',
    },
    body: { elements: [{ tag: 'markdown', content: `\`\`\`\n${displayReasoning}\n\`\`\`` }] },
  }
}

/**
 * Render an assistant reply as a Feishu interactive card with optional
 * workspace/preset footer metadata. Card JSON 2.0 supports full markdown
 * (tables, headings, inline code) natively.
 */
function renderReplyCard(text: string, meta?: ReplyCardMeta, reasoning?: string): object {
  // Ensure content is never empty - use a placeholder if needed
  const displayText = text.trim() === '' ? '(empty response)' : text
  const elements: object[] = []
  // Add reasoning section if present
  if (reasoning !== undefined && reasoning !== '') {
    const displayReasoning = reasoning.length > 2000 ? reasoning.slice(0, 2000) + '\n…(truncated)' : reasoning
    elements.push({
      tag: 'markdown',
      content: `🧠 **Reasoning**\n\`\`\`\n${displayReasoning}\n\`\`\``,
    })
    elements.push({ tag: 'hr' })
  }
  elements.push({
    tag: 'markdown',
    content: displayText,
  })
  // Add footer with workspace/preset/model/context info when available
  const line1: string[] = []
  const line2: string[] = []
  if (meta?.workspace !== undefined && meta.workspace !== '') {
    line1.push(`📂 ${meta.workspace}`)
  }
  if (meta?.agentPreset !== undefined && meta.agentPreset !== '') {
    line1.push(`⚙️ ${meta.agentPreset}`)
  }
  if (meta?.model !== undefined && meta.model !== '') {
    line2.push(`🧠 ${meta.model}`)
  }
  if (meta?.reasoningEffort !== undefined && meta.reasoningEffort !== '') {
    line2.push(`💡 ${meta.reasoningEffort}`)
  }
  if (meta?.contextWindow !== undefined && meta.contextWindow > 0 && meta?.lastInputTokens !== undefined) {
    const pct = Math.min(100, Math.round(meta.lastInputTokens / meta.contextWindow * 100))
    line2.push(`📊 ${formatTokenCount(meta.lastInputTokens)}/${formatTokenCount(meta.contextWindow)} (${pct}%)`)
  }
  const noteElements: object[] = []
  if (line1.length > 0) noteElements.push({ tag: 'lark_md', content: line1.join(' · ') })
  if (line2.length > 0) noteElements.push({ tag: 'lark_md', content: line2.join(' · ') })
  if (noteElements.length > 0) {
    elements.push({ tag: 'hr' })
    // Card JSON 2.0 doesn't support 'note' tag — use markdown with notation text size
    const footerContent = (noteElements as Array<{ tag: string; content?: string }>)
      .filter((e) => e.tag === 'lark_md')
      .map((e) => e.content ?? '')
      .filter(Boolean)
      .join('\n')
    if (footerContent !== '') {
      elements.push({ tag: 'markdown', content: footerContent, text_size: 'notation' })
    }
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Reply' },
      template: 'blue',
    },
    body: { elements },
  }
}

/**
 * Render a lightweight footer-only card when the last step already sent
 * content but we still want to show workspace/preset/model metadata.
 * Returns undefined when there's no metadata to show.
 */
function renderFooterCard(meta?: ReplyCardMeta): object | undefined {
  const line1: string[] = []
  const line2: string[] = []
  if (meta?.workspace !== undefined && meta.workspace !== '') {
    line1.push(`📂 ${meta.workspace}`)
  }
  if (meta?.agentPreset !== undefined && meta.agentPreset !== '') {
    line1.push(`⚙️ ${meta.agentPreset}`)
  }
  if (meta?.model !== undefined && meta.model !== '') {
    line2.push(`🧠 ${meta.model}`)
  }
  if (meta?.reasoningEffort !== undefined && meta.reasoningEffort !== '') {
    line2.push(`💡 ${meta.reasoningEffort}`)
  }
  if (meta?.contextWindow !== undefined && meta.contextWindow > 0 && meta?.lastInputTokens !== undefined) {
    const pct = Math.min(100, Math.round(meta.lastInputTokens / meta.contextWindow * 100))
    line2.push(`📊 ${formatTokenCount(meta.lastInputTokens)}/${formatTokenCount(meta.contextWindow)} (${pct}%)`)
  }
  if (line1.length === 0 && line2.length === 0) return undefined

  const footerContent = [line1.join(' · '), line2.join(' · ')].filter(Boolean).join('\n')
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [
        { tag: 'markdown', content: footerContent, text_size: 'notation' },
      ],
    },
  }
}
