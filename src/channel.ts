import { Domain, LoggerLevel, createLarkChannel } from '@larksuiteoapi/node-sdk'
import type { LarkChannel, LarkChannelOptions, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { RuntimeConfig } from './config.ts'
import type { HarnessConversationService } from './harness.ts'

export type ChannelFactory = (options: LarkChannelOptions) => LarkChannel
export interface PluginLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/**
 * Dispatch a parsed slash command against the receiving chat.
 * Returning `undefined` means the message is not a command; the bridge
 * falls back to its ordinary agent reply.
 */
export type SlashCommandHandler = (
  message: NormalizedMessage,
) => Promise<{ kind: 'success' | 'error'; text: string } | undefined>

export async function startChannel(
  config: Omit<RuntimeConfig, 'appSecretRef'>,
  bridge: Pick<HarnessConversationService, 'reply' | 'dispose'>,
  factory: ChannelFactory = createLarkChannel,
  logger: PluginLogger = console,
  terminalLogger?: Pick<PluginLogger, 'error'>,
  slashCommand?: SlashCommandHandler,
): Promise<() => Promise<void>> {
  const logError = (message: string) => {
    logger.error(message)
    terminalLogger?.error(message)
  }
  const channel = factory({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    domain: config.domain === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'dsh-lark',
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
          logger.warn(`dsh-lark: reaction failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // Slash commands bypass the agent loop entirely; the registered
      // command handler resolves the chat's session and produces a direct
      // textual result.
      if (slashCommand !== undefined) {
        try {
          const commandResult = await slashCommand(message)
          if (commandResult !== undefined) {
            await channel.send(message.chatId, { text: commandResult.text }, {
              replyTo: message.messageId,
              replyInThread,
            })
            return
          }
        } catch (error: unknown) {
          logError(`dsh-lark: slash command failed: ${error instanceof Error ? error.message : String(error)}`)
          await channel.send(message.chatId, { text: config.errorMessage }, {
            replyTo: message.messageId,
            replyInThread,
          }).catch((sendError: unknown) => {
            logError(`dsh-lark: fallback reply failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`)
          })
          return
        }
      }
      try {
        const text = await bridge.reply(message)
        await channel.send(message.chatId, { markdown: text }, {
          replyTo: message.messageId,
          replyInThread,
        })
      } catch (error: unknown) {
        logError(`dsh-lark: message handling failed: ${error instanceof Error ? error.message : String(error)}`)
        await channel.send(message.chatId, { text: config.errorMessage }, {
          replyTo: message.messageId,
          replyInThread,
        }).catch((sendError: unknown) => {
          logError(`dsh-lark: fallback reply failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`)
        })
      }
    }),
    channel.on('reconnecting', () => { logger.warn('dsh-lark: WebSocket reconnecting') }),
    channel.on('reconnected', () => { logger.info('dsh-lark: WebSocket reconnected') }),
    channel.on('error', (error) => { logError(`dsh-lark: channel error: ${String(error)}`) }),
  ]
  try {
    await channel.connect()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const redacted = config.appSecret === '' ? detail : detail.split(config.appSecret).join('[redacted]')
    logError(`dsh-lark: WebSocket connection failed: ${redacted}`)
    for (const unsubscribe of unsubscribers) unsubscribe()
    await bridge.dispose()
    throw error
  }
  logger.info('dsh-lark: WebSocket connected')

  return async () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
    try {
      await channel.disconnect()
      logger.info('dsh-lark: WebSocket disconnected')
    } finally {
      await bridge.dispose()
    }
  }
}
