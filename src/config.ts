import z from '@deepseek-ai/schemastery'

export type DomainName = 'feishu' | 'lark'
export type DirectMessageMode = 'open' | 'allowlist' | 'disabled'

export interface Config {
  appId: string
  appSecret: string
  domain?: DomainName
  requireMention?: boolean
  dmMode?: DirectMessageMode
  groupAllowlist?: string[]
  dmAllowlist?: string[]
  provider?: string
  model?: string
  workspace?: string
  agentPreset?: string
  errorMessage?: string
}

export interface ResolvedConfig extends Required<Pick<Config,
  'appId' | 'appSecret' | 'domain' | 'requireMention' | 'dmMode' | 'groupAllowlist' |
  'dmAllowlist' | 'errorMessage'>> {
  provider?: string
  model?: string
  workspace?: string
  agentPreset?: string
}

export const ConfigSchema: z<Config> = z.object({
  appId: z.string().required().description('Feishu/Lark application ID'),
  appSecret: z.string().role('secret').required().description('Feishu/Lark application secret'),
  domain: z.union(['feishu', 'lark']).default('feishu'),
  requireMention: z.boolean().default(true),
  dmMode: z.union(['open', 'allowlist', 'disabled']).default('open'),
  groupAllowlist: z.array(z.string()).default([]),
  dmAllowlist: z.array(z.string()).default([]),
  provider: z.string(),
  model: z.string(),
  workspace: z.string(),
  agentPreset: z.string(),
  errorMessage: z.string().default('抱歉，处理这条消息时遇到了问题，请稍后重试。'),
})

export function resolveConfig(config: Config): ResolvedConfig {
  if (config.appId.trim() === '') throw new TypeError('appId is required')
  if (config.appSecret.trim() === '') throw new TypeError('appSecret is required')
  const errorMessage = config.errorMessage ?? '抱歉，处理这条消息时遇到了问题，请稍后重试。'
  if (errorMessage.length > 500) throw new TypeError('errorMessage must not exceed 500 characters')
  const base = {
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain ?? 'feishu',
    requireMention: config.requireMention ?? true,
    dmMode: config.dmMode ?? 'open',
    groupAllowlist: config.groupAllowlist ?? [],
    dmAllowlist: config.dmAllowlist ?? [],
    errorMessage,
  } satisfies Omit<ResolvedConfig, 'provider' | 'model' | 'workspace' | 'agentPreset'>
  return {
    ...base,
    ...(config.provider === undefined ? {} : { provider: config.provider }),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.workspace === undefined ? {} : { workspace: config.workspace }),
    ...(config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset }),
  }
}
