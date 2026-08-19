import { describe, expect, it } from 'vitest'
import { LARK_APP_SECRET_REF, resolveRuntimeConfig, resolveSettingsConfig } from '../src/config.ts'

describe('resolveSettingsConfig', () => {
  it('allows an installed plugin to remain unconfigured', () => {
    expect(resolveSettingsConfig({})).toMatchObject({
      appId: '', appSecretRef: LARK_APP_SECRET_REF, domain: 'feishu', requireMention: true, dmMode: 'open',
    })
  })

  it('applies safe conversational defaults', () => {
    expect(resolveSettingsConfig({ appId: 'id' })).toMatchObject({
      domain: 'feishu', requireMention: true, dmMode: 'open',
      errorMessage: '抱歉，处理这条消息时遇到了问题，请稍后重试。',
      reactEmoji: 'THUMBSUP',
    })
    expect(resolveSettingsConfig({ appId: 'id' })).not.toHaveProperty('workspace')
  })

  it('preserves an empty reaction override that disables the acknowledgement', () => {
    expect(resolveSettingsConfig({ appId: 'id', reactEmoji: '' }).reactEmoji).toBe('')
  })

  it('preserves Lark and access-policy configuration', () => {
    expect(resolveSettingsConfig({
      appId: 'id', domain: 'lark', requireMention: false,
      dmMode: 'allowlist', groupAllowlist: ['oc_a'], dmAllowlist: ['ou_a'],
      provider: 'deepseek-official', model: 'deepseek-v4-flash', workspace: '/work', agentPreset: 'coding',
    })).toMatchObject({ domain: 'lark', dmMode: 'allowlist', groupAllowlist: ['oc_a'], dmAllowlist: ['ou_a'], workspace: '/work', agentPreset: 'coding' })
  })

  it('requires a POSIX credential reference', () => {
    expect(() => resolveSettingsConfig({ appSecretRef: 'not-valid-ref' })).toThrow(/appSecretRef/)
  })

  it('rejects an unbounded error response', () => {
    expect(() => resolveSettingsConfig({ appId: 'id', errorMessage: 'x'.repeat(501) })).toThrow(/errorMessage/)
  })
})

describe('resolveRuntimeConfig', () => {
  it('requires the application id and resolved secret only at activation', () => {
    const config = resolveSettingsConfig({})
    expect(() => resolveRuntimeConfig(config, 'secret')).toThrow(/appId/)
    expect(() => resolveRuntimeConfig({ ...config, appId: 'id' }, '')).toThrow(/appSecret/)
    expect(resolveRuntimeConfig({ ...config, appId: 'id' }, 'secret')).toMatchObject({ appId: 'id', appSecret: 'secret' })
  })
})
