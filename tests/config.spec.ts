import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('requires both application credentials', () => {
    expect(() => resolveConfig({ appId: '', appSecret: 'secret' })).toThrow(/appId/)
    expect(() => resolveConfig({ appId: 'id', appSecret: '' })).toThrow(/appSecret/)
  })

  it('applies safe conversational defaults', () => {
    expect(resolveConfig({ appId: 'id', appSecret: 'secret' })).toMatchObject({
      domain: 'feishu', requireMention: true, dmMode: 'open',
      errorMessage: '抱歉，处理这条消息时遇到了问题，请稍后重试。',
    })
    expect(resolveConfig({ appId: 'id', appSecret: 'secret' })).not.toHaveProperty('workspace')
  })

  it('preserves Lark and access-policy configuration', () => {
    expect(resolveConfig({
      appId: 'id', appSecret: 'secret', domain: 'lark', requireMention: false,
      dmMode: 'allowlist', groupAllowlist: ['oc_a'], dmAllowlist: ['ou_a'],
      provider: 'deepseek-official', model: 'deepseek-v4-flash', workspace: '/work', agentPreset: 'coding',
    })).toMatchObject({ domain: 'lark', dmMode: 'allowlist', groupAllowlist: ['oc_a'], dmAllowlist: ['ou_a'], workspace: '/work', agentPreset: 'coding' })
  })

  it('rejects an unbounded error response', () => {
    expect(() => resolveConfig({ appId: 'id', appSecret: 'secret', errorMessage: 'x'.repeat(501) })).toThrow(/errorMessage/)
  })
})
