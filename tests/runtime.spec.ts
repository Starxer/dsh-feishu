import { describe, expect, it, vi } from 'vitest'
import { LarkRuntime } from '../src/runtime.ts'
import { resolveSettingsConfig } from '../src/config.ts'

describe('LarkRuntime', () => {
  it('stays idle until both application credentials are configured', async () => {
    const start = vi.fn()
    const runtime = new LarkRuntime({
      settings: () => resolveSettingsConfig({}),
      resolveSecret: vi.fn(async () => undefined),
      start,
    })
    await runtime.reconcile()
    expect(start).not.toHaveBeenCalled()
    expect(runtime.status()).toMatchObject({ state: 'unconfigured' })
  })

  it('replaces the active channel when effective configuration changes', async () => {
    let config = resolveSettingsConfig({ appId: 'id' })
    const stops: Array<ReturnType<typeof vi.fn>> = []
    const start = vi.fn(async () => {
      const stop = vi.fn(async () => undefined)
      stops.push(stop)
      return stop
    })
    const runtime = new LarkRuntime({ settings: () => config, resolveSecret: async () => 'secret', start })
    await runtime.reconcile()
    await runtime.reconcile()
    expect(start).toHaveBeenCalledOnce()
    config = { ...config, requireMention: false }
    await runtime.reconcile()
    expect(stops[0]).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledTimes(2)
    expect(runtime.status()).toMatchObject({ state: 'connected' })
  })

  it('replaces the channel after the credential value changes', async () => {
    let secret = 'first'
    const stop = vi.fn(async () => undefined)
    const start = vi.fn(async () => stop)
    const runtime = new LarkRuntime({
      settings: () => resolveSettingsConfig({ appId: 'id' }),
      resolveSecret: async () => secret,
      start,
    })
    await runtime.reconcile()
    secret = 'second'
    await runtime.reconcile()
    expect(stop).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('disposes the current channel', async () => {
    const stop = vi.fn(async () => undefined)
    const runtime = new LarkRuntime({
      settings: () => resolveSettingsConfig({ appId: 'id' }),
      resolveSecret: async () => 'secret',
      start: async () => stop,
    })
    await runtime.reconcile()
    await runtime.dispose()
    expect(stop).toHaveBeenCalledOnce()
    expect(runtime.status()).toMatchObject({ state: 'stopped' })
  })

  it('never exposes the resolved secret in connection errors', async () => {
    const runtime = new LarkRuntime({
      settings: () => resolveSettingsConfig({ appId: 'id' }),
      resolveSecret: async () => 'actual-secret',
      start: async () => { throw new Error('authentication failed for actual-secret') },
    })
    await runtime.reconcile()
    expect(JSON.stringify(runtime.status())).not.toContain('actual-secret')
    expect(runtime.status()).toMatchObject({ state: 'error' })
  })

  it('moves to an error state when credential resolution fails', async () => {
    const runtime = new LarkRuntime({
      settings: () => resolveSettingsConfig({ appId: 'id' }),
      resolveSecret: async () => { throw new Error('credential backend unavailable') },
      start: vi.fn(),
    })
    await runtime.reconcile()
    expect(runtime.status()).toEqual({ state: 'error', message: 'credential backend unavailable' })
  })

  it('moves to an error state when stopping the old channel fails', async () => {
    let config = resolveSettingsConfig({ appId: 'id' })
    const runtime = new LarkRuntime({
      settings: () => config,
      resolveSecret: async () => 'secret',
      start: async () => async () => { throw new Error('disconnect failed') },
    })
    await runtime.reconcile()
    config = { ...config, requireMention: false }
    await runtime.reconcile()
    expect(runtime.status()).toEqual({ state: 'error', message: 'disconnect failed' })
  })
})
