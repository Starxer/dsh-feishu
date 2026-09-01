import { Readable } from 'node:stream'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Domain, LoggerLevel, createLarkChannel } from '@larksuiteoapi/node-sdk'
import type { LarkChannel, LarkChannelOptions, NormalizedMessage, ResourceDescriptor } from '@larksuiteoapi/node-sdk'
import type { AttachmentStore, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { RuntimeConfig } from './config.ts'
import type { HarnessConversationService, InboundMessage } from './harness.ts'
import type { BusyMode } from './harness.ts'
import { translationsFor, type Translations } from './i18n.ts'
import { TurnDroppedError } from './harness.ts'
import type { TurnStats } from './feishu-streaming.ts'
import { errorText } from './error-text.ts'
import { chunkText, CARD_TEXT_MAX } from './text-chunk.ts'

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
 * Returning `{ kind: 'consumed' }` means the command was handled directly
 * (e.g. a V2 card instance already sent via cardkit) — the channel sends
 * no follow-up message and does NOT fall through to the agent loop.
 */
export type SlashCommandHandler = (
  message: NormalizedMessage,
) => Promise<
  | { kind: 'success' | 'error'; text: string; card?: object }
  | { kind: 'consumed' }
  | undefined
>

/** Narrow attachment-store view needed for image admission. */
type AttachmentLike = Pick<AttachmentStore, 'saveImage' | 'imageLimits'>

export type ImageMediaTypeId = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

/**
 * Sniff the real media type from the first bytes of an image, independent of
 * any filename/MIME hint. The attachment store validates declared vs actual
 * bytes (`IMAGE_TYPE_MISMATCH`), so we must NOT guess — Feishu only exposes
 * `type: 'image'` with no reliable content hint, and a guessed JPEG stamp will
 * reject every non-JPEG upload (PNG/WebP/GIF).
 */
export function sniffImageMime(bytes: Uint8Array): ImageMediaTypeId | undefined {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  // WebP: "RIFF" .... "WEBP"
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  // GIF: "GIF87a" / "GIF89a"
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 &&
      (b[3] === 0x38) && (b[5] === 0x61)) return 'image/gif'
  return undefined
}

/** Extension hint as a fallback when magic bytes are inconclusive. */
function pickImageMimeByExt(descriptor: ResourceDescriptor): ImageMediaTypeId | undefined {
  const hint = descriptor.fileName?.toLowerCase() ?? ''
  if (hint.endsWith('.png')) return 'image/png'
  if (hint.endsWith('.jpg') || hint.endsWith('.jpeg')) return 'image/jpeg'
  if (hint.endsWith('.webp')) return 'image/webp'
  if (hint.endsWith('.gif')) return 'image/gif'
  return undefined
}

/**
 * Resolve the real media type for an image: magic bytes take priority (the
 * attachment store validates against actual bytes), the filename extension is
 * only a fallback when the header is unrecognizable. Never guesses JPEG.
 */
function pickImageMime(bytes: Uint8Array, descriptor: ResourceDescriptor): ImageMediaTypeId | undefined {
  return sniffImageMime(bytes) ?? pickImageMimeByExt(descriptor)
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
    // Resolve the media type FROM THE BYTES, not a guessed MIME. The
    // attachment store rejects declared-vs-actual mismatches, so a filename
    // hint is only a fallback and JPEG is never assumed.
    const mediaType = pickImageMime(bytes, resource)
    if (mediaType === undefined || !accepted.includes(mediaType)) {
      throw new Error(`dsh-feishu: image type "${mediaType ?? 'unknown'}" is not accepted by the deployment`)
    }
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

/**
 * Fallback inbox directory (when no session workspace is resolved at inbound
 * time) so inbound files always land somewhere persistent and readable by the
 * agent's file tools. A plain `/tmp` path is unusable because the channel
 * service and the agent's tool sandbox have isolated `/tmp` mounts; DSH_HOME is
 * a real on-disk directory both sides can reach.
 */
async function getFallbackInboxDir(): Promise<string> {
  const dshHome = process.env.DSH_HOME || `${homedir()}/.dsh`
  const dir = join(dshHome, 'feishu-inbox')
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Resolve the per-workspace inbox directory for an inbound file. Prefers the
 * session's workspace root (`<workspace>/.feishu-inbox/`) so files stay with
 * the session's files instead of a global shared dir; falls back to the
 * global `~/.dsh/feishu-inbox/` when no workspace is resolvable.
 */
async function resolveInboxDir(message: NormalizedMessage, resolveWorkspaceRoot?: (msg: NormalizedMessage) => Promise<string | undefined>): Promise<string> {
  if (resolveWorkspaceRoot !== undefined) {
    try {
      const root = await resolveWorkspaceRoot(message)
      if (root !== undefined && root.trim() !== '') {
        const dir = join(root, '.feishu-inbox')
        await mkdir(dir, { recursive: true })
        return dir
      }
    } catch { /* fall through to global inbox */ }
  }
  return getFallbackInboxDir()
}

/**
 * Download every file resource off one normalized message and persist the
 * bytes to the session's workspace inbox dir. Returns an array of
 * `{ path, fileName }` entries so the inbound message content can reference
 * them. Returns an empty array when the message carries no file resources.
 */
async function admitFilesForMessage(
  channel: LarkChannel,
  message: NormalizedMessage,
  signal: AbortSignal,
  resolveWorkspaceRoot?: (msg: NormalizedMessage) => Promise<string | undefined>,
): Promise<readonly { path: string; fileName: string }[]> {
  const resources = (message.resources ?? []).filter(resource => resource.type === 'file')
  if (resources.length === 0) return []
  const dir = await resolveInboxDir(message, resolveWorkspaceRoot)
  const results: { path: string; fileName: string }[] = []
  for (const resource of resources) {
    if (signal.aborted) throw new Error('dsh-feishu: file admission aborted')
    const raw = await channel.rawClient.im.v1.messageResource.get({
      params: { type: 'file' },
      path: { message_id: message.messageId, file_key: resource.fileKey },
    })
    if (signal.aborted) throw new Error('dsh-feishu: file admission aborted')
    const bytes = await readDownloadStream(raw)
    const fileName = resource.fileName ?? resource.fileKey
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
    const ts = Date.now()
    const filePath = join(dir, `${ts}_${safeName}`)
    await writeFile(filePath, bytes)
    results.push({ path: filePath, fileName })
  }
  return results
}

/** Metadata for the reply card footer. */
export interface ReplyCardMeta {
  workspace?: string
  agentPreset?: string
  model?: string
  reasoningEffort?: string
  contextWindow?: number
  lastInputTokens?: number
  /** Per-chat Enter-behavior-while-busy mode (Queue / Steer), shown in the Turn Complete footer. */
  busyMode?: BusyMode
}

/** Chat coordinates passed to the footer callback for session lookup. */
export interface ChatCoordinates {
  chatId: string
  chatType: 'p2p' | 'group'
  threadId?: string
}

export async function startChannel(
  config: Omit<RuntimeConfig, 'appSecretRef'>,
  bridge: Pick<HarnessConversationService, 'reply' | 'dispose' | 'consumeIntermediateSent' | 'resolveSessionIdFor' | 'needsOnboarding'>,
  factory: ChannelFactory = createLarkChannel,
  logger: PluginLogger = console,
  terminalLogger?: Pick<PluginLogger, 'error'>,
  slashCommand?: SlashCommandHandler,
  attachments?: AttachmentLike,
  replyCardMeta?: (coords: ChatCoordinates) => ReplyCardMeta | Promise<ReplyCardMeta>,
  consumeReasoning?: (sessionId: string) => string | undefined,
  consumeLastStepHadContent?: (sessionId: string) => boolean,
  flushed?: (sessionId: string) => Promise<TurnStats | undefined>,
  messageInterceptor?: (msg: NormalizedMessage) => boolean | Promise<boolean>,
  onboarding?: {
    needsOnboarding(msg: NormalizedMessage): Promise<boolean>
    sendOnboardingCard(msg: NormalizedMessage): Promise<void>
  },
  getTranslations?: () => Translations,
  resolveWorkspaceRoot?: (msg: NormalizedMessage) => Promise<string | undefined>,
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
    includeRawEvent: true,
    // Self-healing inbound: on a silent network partition (TCP half-open) the
    // socket never emits a clean `close`, so the SDK's auto-reconnect never
    // fires and inbound messages stop while outbound (new HTTP connections per
    // send) still works. The SDK's liveness watchdog (no inbound frame within
    // `pingTimeout` of the last ping) terminates the dead socket to trigger a
    // reconnect — but it is DISABLED unless `wsConfig.pingTimeout` is set
    // (defaults to 0). Enabling it restores inbound self-healing.
    wsConfig: { pingTimeout: 60 },
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
      // Message interceptor (e.g., for question custom-input collection).
      // If the interceptor returns true, the message is consumed.
      if (messageInterceptor !== undefined) {
        try {
          const consumed = await messageInterceptor(message)
          if (consumed) return
        } catch (error: unknown) {
          logger.warn(`dsh-feishu: message interceptor error: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const replyInThread = message.threadId !== undefined
      // Feishu topic replies must target the topic ROOT message: replying to a
      // non-root topic message with `reply_in_thread` does not reliably land in
      // the topic. Root messages (no root_id) reply to themselves.
      const replyToId = message.rootId ?? message.messageId
      console.log(`dsh-feishu: [msg] chatId=${message.chatId} threadId=${message.threadId ?? '-'} rootId=${message.rootId ?? '-'} replyInThread=${replyInThread} replyTo=${replyToId}`)
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
            if (commandResult.kind === 'consumed') {
              // The handler already sent its response directly (e.g. a V2
              // card instance via cardkit). Do not send a follow-up and do
              // not fall through into the agent loop.
              return
            }
            const payload = commandResult.card !== undefined ? { card: commandResult.card } : { text: commandResult.text }
            await channel.send(message.chatId, payload, {
              replyTo: replyToId,
              replyInThread,
            })
            return
          }
        } catch (error: unknown) {
          logError(`dsh-feishu: slash command failed: ${error instanceof Error ? error.message : String(error)}`)
          await channel.send(message.chatId, { text: `命令执行出错：${errorText(error, config.errorMessage)}` }, {
            replyTo: replyToId,
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
        ...message.threadId === undefined ? {} : { rootId: replyToId },
        content: message.content,
      }
      if ((message.resources ?? []).some(resource => resource.type === 'image')) {
        if (attachments === undefined) {
          await channel.send(message.chatId, {
            text: 'Image messages are not supported because the deployment has no attachment service composed.',
          }, { replyTo: replyToId, replyInThread }).catch(() => undefined)
          return
        }
        try {
          const imageBlocks = await admitImagesForMessage(channel, message, attachments, new AbortController().signal)
          inboundMessage = { ...inboundMessage, imageBlocks }
        } catch (error: unknown) {
          logError(`dsh-feishu: image admission failed: ${error instanceof Error ? error.message : String(error)}`)
          await channel.send(message.chatId, { text: `图片处理出错：${errorText(error, config.errorMessage)}` }, {
            replyTo: replyToId,
            replyInThread,
          }).catch(() => undefined)
          return
        }
      }
      // Admit file resources: download them to a temp directory and inject
      // file paths into the message content so the agent can read them.
      if ((message.resources ?? []).some(resource => resource.type === 'file')) {
        try {
          const files = await admitFilesForMessage(channel, message, new AbortController().signal, resolveWorkspaceRoot)
          if (files.length > 0) {
            const fileRefs = files.map(f => `[文件: ${f.fileName} → ${f.path}]`).join('\n')
            const extraContent = inboundMessage.content.length > 0
              ? `${inboundMessage.content}\n${fileRefs}`
              : fileRefs
            inboundMessage = { ...inboundMessage, content: extraContent }
          }
        } catch (error: unknown) {
          logError(`dsh-feishu: file admission failed: ${error instanceof Error ? error.message : String(error)}`)
          // Non-fatal: continue with the message even if file download fails.
          // The agent will see the raw <file .../> tag and can report the issue.
        }
      }
      try {
        // First-message onboarding: a chat with no session history gets a
        // card (attach an existing session or create a new one) instead of
        // silently auto-creating a session. Only non-command messages reach
        // this point — slash commands (including `/new`) are handled above.
        if (onboarding !== undefined) {
          const needsOnboarding = await onboarding.needsOnboarding(message)
          if (needsOnboarding) {
            await onboarding.sendOnboardingCard(message)
            return
          }
        }
        // Fire-and-forget: submit the message to the agent and return
        // immediately so the chatQueue can deliver the next message (e.g.
        // a slash command) without waiting for the agent turn to finish.
        // The reply card is sent asynchronously when the agent completes.
        const chatId = message.chatId
        const chatType = message.chatType
        const threadId = message.threadId
        void bridge.reply(inboundMessage).then(async (text) => {
          const sessionId = bridge.resolveSessionIdFor(inboundMessage)
          const intermediateSent = bridge.consumeIntermediateSent(sessionId)
          const meta = await replyCardMeta?.({ chatId, chatType, ...(threadId !== undefined ? { threadId } : {}) })

          if (intermediateSent) {
            // Streaming already sent a step card with the text content.
            // Wait for the final step card update to complete, then send the footer.
            const turnStats = await flushed?.(sessionId)
            const footerCard = renderFooterCard(getTranslations?.() ?? translationsFor('zh'), meta, turnStats)
            if (footerCard !== undefined) {
              await channel.send(chatId, { card: footerCard }, {
                replyTo: replyToId,
                replyInThread,
              })
            }
          } else {
            // No intermediate card was sent — send the full reply, split across
            // multiple cards if the output exceeds one card's content budget.
            const cards = renderReplyCards(text, meta)
            for (const card of cards) {
              await channel.send(chatId, { card }, {
                replyTo: replyToId,
                replyInThread,
              })
            }
          }
        }).catch((error: unknown) => {
          if (error instanceof TurnDroppedError) {
            // Message intentionally dropped because the session was stopped
            // while it waited for the current turn — no error card needed.
            logError(`dsh-feishu: message dropped (session stopped): ${error.message}`)
            return
          }
          logError(`dsh-feishu: message handling failed: ${error instanceof Error ? error.message : String(error)}`)
          void channel.send(chatId, { text: `处理这条消息时出错：${errorText(error, config.errorMessage)}` }, {
            replyTo: replyToId,
            replyInThread,
          }).catch((sendError: unknown) => {
            logError(`dsh-feishu: fallback reply failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`)
          })
        })
      } catch (error: unknown) {
        // Synchronous errors from bridge.reply() setup (rare)
        logError(`dsh-feishu: message dispatch failed: ${error instanceof Error ? error.message : String(error)}`)
        await channel.send(message.chatId, { text: `处理这条消息时出错：${errorText(error, config.errorMessage)}` }, {
          replyTo: replyToId,
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

function formatMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
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
 * Render an assistant reply as one or more Feishu interactive cards with
 * optional workspace/preset footer metadata. Card JSON 2.0 supports full
 * markdown (tables, headings, inline code) natively.
 *
 * Long model output is partitioned into multiple cards so none of them is
 * silently truncated by the card renderer. Reasoning is only drawn on the
 * first card; the footer metadata is only drawn on the last card.
 */
export function renderReplyCards(text: string, meta?: ReplyCardMeta, reasoning?: string): object[] {
  // Ensure content is never empty - use a placeholder if needed
  const displayText = text.trim() === '' ? '(empty response)' : text
  const reasonForHeader = (reasoning !== undefined && reasoning !== '') ? reasoning : undefined

  const textChunks = chunkText(displayText, CARD_TEXT_MAX)
  const total = textChunks.length
  const cards: object[] = []

  for (let i = 0; i < total; i++) {
    const isFirst = i === 0
    const isLast = i === total - 1
    const elements: object[] = []

    if (isFirst && reasonForHeader !== undefined) {
      const displayReasoning = reasonForHeader.length > 2000 ? reasonForHeader.slice(0, 2000) + '\n…(truncated)' : reasonForHeader
      elements.push({
        tag: 'markdown',
        content: `🧠 **Reasoning**\n\`\`\`\n${displayReasoning}\n\`\`\``,
      })
      elements.push({ tag: 'hr' })
    }

    // A short continuation header helps the reader see a card is a fragment of
    // a longer reply instead of thinking the answer ended abruptly.
    if (total > 1) {
      elements.push({ tag: 'markdown', content: `*(${tReplyPart(i + 1, total)})*`, text_size: 'notation' })
    }
    elements.push({
      tag: 'markdown',
      content: textChunks[i],
    })

    if (isLast) {
      elements.push(...buildReplyFooter(meta))
    }

    cards.push({
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: total > 1 ? `Reply (${i + 1}/${total})` : 'Reply' },
        template: 'blue',
      },
      body: { elements },
    })
  }
  return cards
}

/** Local "part i/total" label used in the reply card continuation header. */
function tReplyPart(i: number, total: number): string {
  return `Part ${i}/${total}`
}

/** Build the footer metadata elements (workspace/preset/model/context). */
function buildReplyFooter(meta?: ReplyCardMeta): object[] {
  const elements: object[] = []
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
  return elements
}

/**
 * Render a Turn Complete card with turn stats and optional session metadata.
 * Returns undefined when there's nothing to show.
 */
export function renderFooterCard(
  t: Translations,
  meta?: ReplyCardMeta,
  turnStats?: TurnStats,
): object | undefined {
  const elements: object[] = []

  // Turn stats section — all notation size
  if (turnStats !== undefined) {
    // Duration: total (wall-clock) / LLM / tools
    const totalMs = turnStats.totalTurnMs || turnStats.totalStepMs
    const llmMs = turnStats.totalStepMs
    const toolMs = turnStats.totalToolMs
    const durParts: string[] = [
      `⏱ ${formatMs(totalMs)}`,
      `🧠 LLM ${formatMs(llmMs)}`,
      `🔧 Tools ${formatMs(toolMs)}`,
    ]
    elements.push({ tag: 'markdown', content: durParts.join(' · '), text_size: 'notation' })

    // Performance: TTFT · tok/s · steps
    const perfParts: string[] = []
    if (turnStats.firstStepTtftMs !== null && turnStats.firstStepTtftMs > 0) {
      perfParts.push(`⚡ TTFT ${formatMs(turnStats.firstStepTtftMs)}`)
    }
    if (turnStats.totalDecodeMs > 0 && turnStats.totalOutputTokens > 0) {
      const tps = turnStats.totalOutputTokens / (turnStats.totalDecodeMs / 1000)
      perfParts.push(`🚀 ${tps.toFixed(0)} tok/s`)
    }
    if (turnStats.stepCount > 0) {
      perfParts.push(`🔄 ${turnStats.stepCount} steps`)
    }
    if (perfParts.length > 0) {
      elements.push({ tag: 'markdown', content: perfParts.join(' · '), text_size: 'notation' })
    }

    // Tokens: total consumed (matches Web UI "consumed") · in/out · cache
    const tokenParts: string[] = []
    const billedIn = turnStats.totalInputTokens + turnStats.totalCacheReadTokens + turnStats.totalCacheWriteTokens
    const totalBilled = turnStats.totalBilledTokens > 0
      ? turnStats.totalBilledTokens
      : billedIn + turnStats.totalOutputTokens
    if (totalBilled > 0) {
      tokenParts.push(`📦 ${formatTokenCount(totalBilled)} tokens`)
    }
    if (billedIn > 0 || turnStats.totalOutputTokens > 0) {
      tokenParts.push(`📥 ${formatTokenCount(billedIn)} in · 📤 ${formatTokenCount(turnStats.totalOutputTokens)} out`)
    }
    if (billedIn > 0 && turnStats.totalCacheReadTokens > 0) {
      const cacheHitPct = Math.round(turnStats.totalCacheReadTokens / billedIn * 100)
      tokenParts.push(`💾 cache ${cacheHitPct}%`)
    }
    if (tokenParts.length > 0) {
      elements.push({ tag: 'markdown', content: tokenParts.join(' · '), text_size: 'notation' })
    }
  }

  // Metadata section — simplified (short names only)
  const metaParts: string[] = []
  if (meta?.workspace !== undefined && meta.workspace !== '') {
    // Show only the last directory name, not the full path.
    const short = meta.workspace.includes('/') ? meta.workspace.split('/').pop()! : meta.workspace
    metaParts.push(`📂 ${short}`)
  }
  if (meta?.model !== undefined && meta.model !== '') {
    // Show only the model name, not the provider prefix.
    const short = meta.model.includes('/') ? meta.model.split('/').pop()! : meta.model
    metaParts.push(`🧠 ${short}`)
  }
  if (meta?.reasoningEffort !== undefined && meta.reasoningEffort !== '') {
    metaParts.push(`💡 ${meta.reasoningEffort}`)
  }
  if (meta?.contextWindow !== undefined && meta.contextWindow > 0 && meta?.lastInputTokens !== undefined) {
    const pct = Math.min(100, Math.round(meta.lastInputTokens / meta.contextWindow * 100))
    metaParts.push(`📊 ${formatTokenCount(meta.lastInputTokens)}/${formatTokenCount(meta.contextWindow)} (${pct}%)`)
  }
  if (meta?.busyMode !== undefined) {
    const label = meta.busyMode === 'steer' ? 'Steer' : 'Queue'
    const icon = meta.busyMode === 'steer' ? '🎯' : '📥'
    metaParts.push(`**${t.enterWhileBusy}:** ${icon} ${label}`)
  }

  // If nothing to show, return undefined.
  if (elements.length === 0 && metaParts.length === 0) return undefined

  // Append metadata with divider if both stats and metadata exist.
  if (metaParts.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' })
    // Two items per line for mobile readability.
    const line1 = metaParts.slice(0, 2).join(' · ')
    const line2 = metaParts.slice(2).join(' · ')
    const metaContent = [line1, line2].filter(Boolean).join('\n')
    elements.push({ tag: 'markdown', content: metaContent, text_size: 'notation' })
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.turnCompleteTitle },
      template: 'green',
    },
    body: { elements },
  }
}
