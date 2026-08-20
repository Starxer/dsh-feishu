import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { CommandRuntime, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { createLarkChannel } from '@larksuiteoapi/node-sdk'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { ConfigSchema, LARK_SETTINGS_NAMESPACE, resolveSettingsConfig } from './config.ts'
import type { Config as PluginConfig, SettingsConfig } from './config.ts'
import { HarnessConversationService } from './harness.ts'
import { startChannel, type SlashCommandHandler } from './channel.ts'
import { LarkRuntime } from './runtime.ts'
import { createSettingsApi } from './settings-api.ts'
import { renderTerminalQr } from './provision.ts'
import { ProvisionManager } from './provision-manager.ts'
import { registerLarkCommands, type CommandTranslations } from './commands.ts'
import { handleProvisionRequest, handleSettingsRequest, PROVISION_PATH, SETTINGS_PATH } from './web.ts'

export const name = 'lark-channel'
export const inject = [
  'agents', 'sessions', 'sessionPersistence', 'agentDefaultModel', 'agentPresets', 'workspaceRegistry',
  'settings', 'credentials', 'webServer', 'commands', 'llm',
]
export const Config = ConfigSchema
export type { PluginConfig }
export { ConfigSchema } from './config.ts'

export async function apply(ctx: Context, rawConfig: PluginConfig): Promise<void> {
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const sessionPersistence = ctx.get('sessionPersistence')
  const defaultModel = ctx.get('agentDefaultModel')
  const agentPresets = ctx.get('agentPresets')
  const workspaceRegistry = ctx.get('workspaceRegistry')
  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')
  const webServer = ctx.get('webServer')
  const commands = ctx.get('commands')
  const llm = ctx.get('llm') as LlmRuntime | undefined
  if (agents === undefined || sessions === undefined || sessionPersistence === undefined || defaultModel === undefined || agentPresets === undefined || workspaceRegistry === undefined || settings === undefined || credentials === undefined || webServer === undefined) {
    throw new Error('dsh-lark requires Harness agent, settings, credentials, workspace, and webServer services')
  }
  if (commands === undefined || llm === undefined) {
    throw new Error('dsh-lark requires commands and llm services for /model support')
  }

  const settingsScope = settings.register(
    settingsNamespace(LARK_SETTINGS_NAMESPACE),
    ConfigSchema,
    { base: rawConfig, applies: 'live' },
  )
  const namespace = settingsNamespace(LARK_SETTINGS_NAMESPACE)
  const currentSettings = (): SettingsConfig => resolveSettingsConfig(settingsScope.get())
  const currentRevision = () => settings.describe({ redactSecrets: true }).find(item => item.ns === namespace)?.revision ?? 0
  let apiUpdateDepth = 0

  // The bridge is recreated every time the Lark channel reconciles; hold it
  // in a single-cell so the `/model` command always reaches the bridge that
  // is currently serving the inbound message. `lastChatMessage` is overwritten
  // on every inbound message under `chatQueue.enabled: true`, so a synchronous
  // command dispatch sees its own chat coordinates; concurrent chats in
  // different sessions are serialized by the queue and the race never happens.
  const bridgeHolder: {
    current: HarnessConversationService | undefined
    lastChatMessage: { chatId: string; chatType: 'p2p' | 'group'; threadId?: string } | undefined
  } = { current: undefined, lastChatMessage: undefined }
  registerLarkCommands(
    ctx,
    llm,
    defaultModel,
    {
      setCurrentSelection: (chatMessage, next) => bridgeHolder.current?.setCurrentSelection(chatMessage, next),
      currentSelectionFor: chatMessage => bridgeHolder.current?.currentSelectionFor(chatMessage),
      startNewSession: (chatMessage, salt) => bridgeHolder.current?.startNewSession(chatMessage, salt) ?? '',
      switchToSession: (chatMessage, sessionId) => bridgeHolder.current?.switchToSession(chatMessage, sessionId) ?? false,
      listSessions: async () => bridgeHolder.current?.listSessions() ?? [],
    },
    () => {
      const last = bridgeHolder.lastChatMessage
      if (last === undefined) {
        throw new Error('dsh-lark: chat coordinates missing for /model command — send a regular message first')
      }
      return last
    },
    larkCommandTranslations,
    commands,
  )

  const runtime = new LarkRuntime({
    settings: currentSettings,
    resolveSecret: async ref => (await credentials.resolve(credentialRef(ref)))?.value,
    start: async config => {
      const bridge = new HarnessConversationService({
        agents,
        sessions,
        sessionPersistence,
        selection: () => defaultModel.currentSelection(),
        agentPresets,
        workspaceRegistry,
      }, config)
      bridgeHolder.current = bridge
      return startChannel(
        config,
        bridge,
        createLarkChannel,
        ctx.logger,
        console,
        message => executeSlashCommand(message, bridge, commands, bridgeHolder),
      )
    },
  })

  let lastPrintedQrUrl: string | undefined
  const provisionManager = new ProvisionManager({
    domain: () => currentSettings().domain,
    onState: state => {
      if (state.phase === 'waiting' && state.qrUrl !== undefined && state.qrUrl !== lastPrintedQrUrl) {
        lastPrintedQrUrl = state.qrUrl
        renderTerminalQr(state.qrUrl, ctx.logger)
      }
    },
    onProvisioned: async result => {
      const ref = currentSettings().appSecretRef
      apiUpdateDepth += 1
      try {
        await credentials.set(credentialRef(ref), result.appSecret)
        await settings.mutate(namespace, [{ op: 'set', path: ['appId'], value: result.appId }], currentRevision())
      } finally {
        apiUpdateDepth -= 1
      }
      await runtime.reconcile()
    },
  })

  const api = createSettingsApi({
    getSettings: currentSettings,
    revision: currentRevision,
    beginUpdate: () => { apiUpdateDepth += 1 },
    endUpdate: () => { apiUpdateDepth -= 1 },
    updateSettings: (patch, unset, expectedRevision) => settings.mutate(namespace, [
      ...Object.entries(patch).map(([key, value]) => ({ op: 'set' as const, path: [key], value })),
      ...unset.map(key => ({ op: 'unset' as const, path: [key] })),
    ], expectedRevision),
    credentials: {
      describe: ref => credentials.describe(credentialRef(ref)),
      set: (ref, value) => credentials.set(credentialRef(ref), value),
      unset: ref => credentials.unset(credentialRef(ref)),
    },
    runtimeStatus: () => runtime.status(),
    reconcile: () => runtime.reconcile(),
    provision: {
      status: () => provisionManager.status(),
      start: () => provisionManager.start(),
    },
  })

  settingsScope.watch(() => apiUpdateDepth > 0 ? undefined : runtime.reconcile())
  ctx.on('credentials/updated', ref => {
    if (apiUpdateDepth === 0 && ref === currentSettings().appSecretRef) void runtime.reconcile()
  })
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: SETTINGS_PATH,
    handler: (req, res) => handleSettingsRequest(req, res, api),
  }), 'dsh-lark: settings page')
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: PROVISION_PATH,
    handler: (req, res) => handleProvisionRequest(req, res, api),
  }), 'dsh-lark: provision endpoint')
  ctx.effect(() => () => {
    provisionManager.dispose()
    return runtime.dispose()
  }, 'dsh-lark: runtime')
  await runtime.reconcile()
}

/**
 * Localized strings for the `/model` command. Keeping these inline (rather
 * than registering a locale namespace) keeps the dependency surface small —
 * the strings are owned by the Feishu-facing command handler and rarely
 * change.
 */
const larkCommandTranslations: CommandTranslations = {
  modelDescription: 'Show, list, or switch the active model',
  modelCurrentHeader: 'Current model:',
  modelUsage: 'Usage: /model [list|<provider>/<model>[:reasoning]]',
  modelListHeader: 'Available models:',
  modelListEmpty: 'No registered providers are available.',
  modelSwitched: (provider, model) => `Switched default model to \`${provider}/${model}\`.`,
  modelUnknown: route => `Unknown model route "${route}".`,
  modelPersisted: 'The change is persisted; the next message in this chat will use it.',
  modelLiveApplied: 'The change applies to this chat immediately on the next message.',
  newDescription: 'Start a fresh conversation in this chat',
  newSessionReady: sessionId => `Started a new conversation. Next message uses session \`${sessionId}\`.`,
  threadDescription: 'List persisted sessions or switch the chat to one by index',
  threadUsage: 'Usage: /thread [N]',
  threadListHeader: 'Available sessions (reply with `/thread N` to switch):',
  threadListEmpty: 'No persisted sessions yet.',
  threadListEntry: (index, id, title, lastActive) => `${index}. ${title} — ${lastActive} (\`${id}\`)`,
  threadSwitched: (index, id) => `Switched to session #${index} (\`${id}\`).`,
  threadInvalidIndex: 'Invalid session index.',
  threadArchived: 'That session is archived — unarchive it from the workspace webui first.',
  threadIdle: id => `(idle: ${id.slice(-12)})`,
  threadLastActiveJustNow: 'just now',
  threadLastActiveMinutesAgo: n => `${n}m ago`,
  threadLastActiveHoursAgo: n => `${n}h ago`,
  threadLastActiveDaysAgo: n => `${n}d ago`,
  threadLastActiveUnknown: 'unknown',
  helpDescription: 'List every slash command available in this chat',
  helpHeader: 'Available commands:',
  helpUsage: 'Send `/<name> [arguments]` to run a command. Optional input hints appear in `[brackets]`.',
  helpEntry: (name, description, hint) => hint === undefined
    ? `• \`/${name}\` — ${description}`
    : `• \`/${name}\` — ${description} \`[${hint}]\``,
  helpEmpty: 'No slash commands are available right now.',
}

/**
 * Detect a slash command in an inbound chat message and dispatch it through
 * the Harness command runtime, returning the textual result so the channel
 * can echo it back to the user. A `undefined` return signals that the
 * message is not a command and should fall through to the agent reply.
 */
async function executeSlashCommand(
  message: NormalizedMessage,
  bridge: HarnessConversationService,
  commands: CommandRuntime,
  bridgeHolder: { lastChatMessage: { chatId: string; chatType: 'p2p' | 'group'; threadId?: string } | undefined },
): Promise<{ kind: 'success' | 'error'; text: string } | undefined> {
  const parsed = parseCommand(message.content)
  if (parsed === undefined) return undefined
  const chatMessage = {
    chatId: message.chatId,
    chatType: message.chatType,
    ...message.threadId === undefined ? {} : { threadId: message.threadId },
  }
  // Stash the chat coordinates so the registered handler can find them
  // without holding per-invocation state on the agent. The bridge serializes
  // inbound messages per chat, so a synchronous dispatch always sees its own
  // chat context here.
  bridgeHolder.lastChatMessage = chatMessage
  const agent = await bridge.resolveAgent(chatMessage)
  if (agent === undefined) {
    return {
      kind: 'error',
      text: 'Slash commands need an existing conversation in this chat — send a regular message first.',
    }
  }
  const controller = new AbortController()
  const line = `/${parsed.name}${parsed.rawInput}`
  // `commands.execute` takes `(agent, line, images, signal)`; the Feishu
  // channel has no image-attachment path, so pass an empty image list.
  const execution = await commands.execute(agent, line, [], controller.signal)
  if (execution === undefined) return undefined
  const result: CommandResult = execution.result
  return { kind: result.kind, text: result.text ?? `Command /${parsed.name} produced no output.` }
}

// Keep the SlashCommandHandler import live for callers that prefer the type
// alias without reaching into `./channel.ts`.
export type { SlashCommandHandler }
