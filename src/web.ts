import type { IncomingMessage, ServerResponse } from 'node:http'

export const SETTINGS_PATH = '/dsh-feishu/settings'
export const PROVISION_PATH = '/dsh-feishu/provision'

export interface SettingsApiLike {
  describe(): Promise<unknown>
  update(input: any): Promise<unknown>
  unsetSecret(): Promise<unknown>
  provision(): unknown
  provisionStatus(): unknown
}

export async function handleSettingsRequest(req: IncomingMessage, res: ServerResponse, api: SettingsApiLike): Promise<void> {
  if (!isLoopback(req.socket.remoteAddress)) return send(res, 403, { error: 'DSH Lark settings are available only from localhost' })
  try {
    if (req.method === 'GET') return send(res, 200, await api.describe())
    if ((req.method === 'POST' || req.method === 'DELETE') && !isSameOrigin(req)) {
      return send(res, 403, { error: 'untrusted origin' })
    }
    if (req.method === 'POST') return send(res, 200, await api.update(JSON.parse(await readBody(req))))
    if (req.method === 'DELETE') return send(res, 200, await api.unsetSecret())
    res.setHeader('allow', 'GET, POST, DELETE')
    send(res, 405, { error: 'method not allowed' })
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

export async function handleProvisionRequest(req: IncomingMessage, res: ServerResponse, api: SettingsApiLike): Promise<void> {
  if (!isLoopback(req.socket.remoteAddress)) return send(res, 403, { error: 'DSH Lark provisioning is available only from localhost' })
  try {
    if (req.method === 'GET') return send(res, 200, api.provisionStatus())
    if (req.method === 'POST' && !isSameOrigin(req)) {
      return send(res, 403, { error: 'untrusted origin' })
    }
    if (req.method === 'POST') return send(res, 200, api.provision())
    res.setHeader('allow', 'GET, POST')
    send(res, 405, { error: 'method not allowed' })
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

function isLoopback(address?: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    const requestUrl = new URL(`http://${host}`)
    const hostname = requestUrl.hostname.toLowerCase()
    if (hostname !== '127.0.0.1' && hostname !== '[::1]' && hostname !== 'localhost') return false
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > 64 * 1024) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}
