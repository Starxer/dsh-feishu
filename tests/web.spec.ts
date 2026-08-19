import { describe, expect, it, vi } from 'vitest'
import { handleProvisionRequest, handleSettingsRequest } from '../src/web.ts'

function response() {
  const headers = new Map<string, string>()
  let body = ''
  return {
    statusCode: 200,
    setHeader: vi.fn((name: string, value: string) => headers.set(name, value)),
    end: vi.fn((value = '') => { body = value }),
    get body() { return body },
    headers,
  }
}

describe('settings web route', () => {
  it('rejects non-loopback requests', async () => {
    const res = response()
    await handleSettingsRequest({ method: 'GET', headers: {}, socket: { remoteAddress: '192.168.1.2' } } as any, res as any, {} as any)
    expect(res.statusCode).toBe(403)
  })

  it('does not serve a standalone HTML settings page', async () => {
    const api = {
      describe: vi.fn(async () => ({ settings: { appId: 'id' }, credential: { configured: false, writable: true }, runtime: { state: 'unconfigured' } })),
    }
    const res = response()
    await handleSettingsRequest({ method: 'GET', headers: { accept: 'text/html' }, socket: { remoteAddress: '127.0.0.1' } } as any, res as any, api as any)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.body).not.toContain('<form')
    expect(api.describe).toHaveBeenCalledOnce()
  })

  it('serves value-free JSON and dispatches update and delete', async () => {
    const api = {
      describe: vi.fn(async () => ({ settings: { appId: 'id' }, credential: { configured: true, writable: true }, runtime: { state: 'connected' } })),
      update: vi.fn(async () => ({ ok: true })),
      unsetSecret: vi.fn(async () => ({ ok: true })),
    }
    const getRes = response()
    await handleSettingsRequest({ method: 'GET', headers: { accept: 'application/json' }, socket: { remoteAddress: '::1' } } as any, getRes as any, api as any)
    expect(getRes.body).not.toContain('secret-value')

    const postRes = response()
    const post = Object.assign((async function* () { yield Buffer.from('{"appId":"next"}') })(), {
      method: 'POST', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }, socket: { remoteAddress: '::1' },
    })
    await handleSettingsRequest(post as any, postRes as any, api as any)
    expect(api.update).toHaveBeenCalledWith({ appId: 'next' })

    const deleteRes = response()
    await handleSettingsRequest({ method: 'DELETE', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }, socket: { remoteAddress: '::1' }, [Symbol.asyncIterator]: async function* () {} } as any, deleteRes as any, api as any)
    expect(api.unsetSecret).toHaveBeenCalledOnce()
  })

  it('rejects cross-origin mutations even when they arrive from loopback', async () => {
    const api = { describe: vi.fn(), update: vi.fn(), unsetSecret: vi.fn() }
    const res = response()
    const request = Object.assign((async function* () { yield Buffer.from('{}') })(), {
      method: 'POST', headers: { origin: 'https://attacker.example', host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' },
    })
    await handleSettingsRequest(request as any, res as any, api as any)
    expect(res.statusCode).toBe(403)
    expect(api.update).not.toHaveBeenCalled()
  })

  it('rejects mutations addressed through a non-loopback Host', async () => {
    const api = { describe: vi.fn(), update: vi.fn(), unsetSecret: vi.fn() }
    const res = response()
    const request = Object.assign((async function* () { yield Buffer.from('{}') })(), {
      method: 'POST', headers: { origin: 'https://attacker.example', host: 'attacker.example' }, socket: { remoteAddress: '127.0.0.1' },
    })
    await handleSettingsRequest(request as any, res as any, api as any)
    expect(res.statusCode).toBe(403)
    expect(api.update).not.toHaveBeenCalled()
  })
})

describe('provision web route', () => {
  it('rejects non-loopback requests', async () => {
    const res = response()
    await handleProvisionRequest({ method: 'GET', headers: {}, socket: { remoteAddress: '192.168.1.2' } } as any, res as any, {} as any)
    expect(res.statusCode).toBe(403)
  })

  it('serves the provision status on GET and starts on same-origin POST', async () => {
    const api = {
      provisionStatus: vi.fn(() => ({ phase: 'waiting', qrUrl: 'https://scan.example/verify' })),
      provision: vi.fn(() => ({ phase: 'waiting', qrUrl: 'https://scan.example/verify' })),
    }
    const getRes = response()
    await handleProvisionRequest({ method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any, getRes as any, api as any)
    expect(api.provisionStatus).toHaveBeenCalledOnce()
    expect(getRes.body).toContain('scan.example')

    const postRes = response()
    await handleProvisionRequest({ method: 'POST', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }, socket: { remoteAddress: '::1' } } as any, postRes as any, api as any)
    expect(api.provision).toHaveBeenCalledOnce()
  })

  it('rejects cross-origin provisioning', async () => {
    const api = { provisionStatus: vi.fn(), provision: vi.fn() }
    const res = response()
    await handleProvisionRequest({ method: 'POST', headers: { origin: 'https://attacker.example', host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } } as any, res as any, api as any)
    expect(res.statusCode).toBe(403)
    expect(api.provision).not.toHaveBeenCalled()
  })
})
