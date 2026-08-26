import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  registerApp: vi.fn(),
  Client: vi.fn(),
  patch: vi.fn(),
  abilityPatch: vi.fn(),
}))

vi.mock('@larksuiteoapi/node-sdk', () => ({
  registerApp: (...args: unknown[]) => mocks.registerApp(...args),
  Client: function Client(...args: unknown[]) { return mocks.Client(...args) },
  Domain: { Feishu: 0, Lark: 1 },
}))

import { enableCardCallbacks, enableWebsocketLongConnection, provisionApp, renderTerminalQr } from '../src/provision.ts'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.patch.mockResolvedValue({ code: 0, msg: 'success' })
  mocks.abilityPatch.mockResolvedValue({ code: 0, msg: 'success' })
  mocks.Client.mockReturnValue({
    application: { v7: { applicationConfig: { patch: mocks.patch }, applicationAbility: { patch: mocks.abilityPatch } } },
  })
})

describe('provisionApp', () => {
  it('emits a waiting state with the QR url and resolves credentials after authorization', async () => {
    let options: any
    mocks.registerApp.mockImplementation(async (opts: any) => {
      options = opts
      opts.onQRCodeReady({ url: 'https://scan.example/verify', expireIn: 600 })
      return { client_id: 'cli_test', client_secret: 'app-secret' }
    })

    const states: unknown[] = []
    const result = await provisionApp({
      domain: 'feishu',
      signal: new AbortController().signal,
      onState: state => states.push(state),
    })

    expect(options.onStatusChange).toBeTypeOf('function')
    expect(options.createOnly).toBeUndefined()
    expect(options.addons.scopes.tenant).toContain('im:message:send_as_bot')
    expect(options.addons.scopes.tenant).toContain('im:message.reaction')
    expect(options.addons.scopes.tenant).toContain('application:application:patch')
    expect(options.addons.events.items.tenant).toContain('im.message.receive_v1')
    expect(states).toEqual([
      { phase: 'waiting', qrUrl: 'https://scan.example/verify', expireIn: 600 },
      { phase: 'configuring' },
    ])
    expect(result).toEqual({ appId: 'cli_test', appSecret: 'app-secret' })
  })

  it('forwards the domain to the websocket long-connection setup', async () => {
    mocks.registerApp.mockResolvedValue({ client_id: 'cli_lark', client_secret: 'secret' })
    await provisionApp({ domain: 'lark', signal: new AbortController().signal, onState: () => undefined })
    expect(mocks.Client).toHaveBeenCalledWith(expect.objectContaining({ domain: 1 }))
  })
})

describe('enableWebsocketLongConnection', () => {
  it('forces the websocket subscription and adds the message event', async () => {
    await enableWebsocketLongConnection('cli_test', 'secret', 'feishu')
    expect(mocks.Client).toHaveBeenCalledWith(expect.objectContaining({ appId: 'cli_test', appSecret: 'secret', domain: 0 }))
    expect(mocks.patch).toHaveBeenCalledWith({
      data: { event: { subscription_type: 'websocket', add_events: ['im.message.receive_v1'] } },
      path: { app_id: 'cli_test' },
    })
  })

  it('rejects when the config patch returns a non-zero code', async () => {
    mocks.patch.mockResolvedValue({ code: 99991, msg: 'forbidden' })
    await expect(enableWebsocketLongConnection('cli_test', 'secret', 'feishu')).rejects.toThrow(/99991/)
  })
})

describe('renderTerminalQr', () => {
  it('logs the QR code and a fallback link', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    renderTerminalQr('https://scan.example/verify', logger)
    expect(logger.info).toHaveBeenCalledTimes(3)
    const calls = logger.info.mock.calls.map(call => call[0] as string)
    expect(calls[0]).toContain('飞书')
    expect(calls[2]).toContain('https://scan.example/verify')
  })
})
