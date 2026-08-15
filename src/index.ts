import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { createLarkChannel } from '@larksuiteoapi/node-sdk'
import { ConfigSchema, resolveConfig } from './config.ts'
import type { Config as PluginConfig } from './config.ts'
import { HarnessConversationService } from './harness.ts'
import { startChannel } from './channel.ts'

export const name = 'lark-channel'
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'agentPresets', 'workspaceRegistry']
export const Config = ConfigSchema
export type { PluginConfig }
export { ConfigSchema } from './config.ts'

export async function apply(ctx: Context, rawConfig: PluginConfig): Promise<void> {
  const config = resolveConfig(rawConfig)
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const defaultModel = ctx.get('agentDefaultModel')
  const agentPresets = ctx.get('agentPresets')
  const workspaceRegistry = ctx.get('workspaceRegistry')
  if (agents === undefined || sessions === undefined || defaultModel === undefined || agentPresets === undefined || workspaceRegistry === undefined) {
    throw new Error('dsh-lark requires agents, sessions, agentDefaultModel, agentPresets, and workspaceRegistry services')
  }
  const bridge = new HarnessConversationService({
    agents,
    sessions,
    selection: () => defaultModel.currentSelection(),
    agentPresets,
    workspaceRegistry,
  }, config)
  const stop = await startChannel(config, bridge, createLarkChannel, ctx.logger)
  ctx.effect(() => stop, 'dsh-lark: channel')
}
