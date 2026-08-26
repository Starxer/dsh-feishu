import { Client, Domain, registerApp } from '@larksuiteoapi/node-sdk'
import qrcode from 'qrcode-terminal'
import type { DomainName } from './config.ts'

export type ProvisionPhase = 'idle' | 'waiting' | 'configuring' | 'done' | 'error'

export interface ProvisionState {
  phase: ProvisionPhase
  /** Verification URL to render as a QR code while waiting for the user to scan. */
  qrUrl?: string
  /** Seconds until the verification URL expires. */
  expireIn?: number
  message?: string
}

export interface ProvisionResult {
  appId: string
  appSecret: string
}

export interface ProvisionOptions {
  domain: DomainName
  source?: string
  signal: AbortSignal
  onState(state: ProvisionState): void
}

/** Permissions a Feishu/Lark bot needs to receive DMs, group @mentions, and reply. */
export const FEISHU_BOT_SCOPES = [
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:message:send_as_bot',
  /** Needed for addReaction (emoji reaction on inbound messages). */
  'im:message.reaction',
]

/**
 * Scope required to call the "update application config" OpenAPI, which the
 * scan flow uses to force the WebSocket long connection (the subscription
 * transport is a sensitive manifest field that `addons` cannot preset).
 */
export const FEISHU_APP_CONFIG_SCOPE = 'application:application:patch'

/** Every tenant scope the scan flow pre-fills so the created app works end-to-end. */
export const FEISHU_PROVISION_SCOPES = [...FEISHU_BOT_SCOPES, FEISHU_APP_CONFIG_SCOPE]

export const FEISHU_MESSAGE_EVENT = 'im.message.receive_v1'

export interface ProvisionLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/**
 * Scan-to-configure flow backed by the official SDK's `registerApp` (RFC 8628
 * Device Authorization Grant). Emits a verification URL through `onState` for
 * the caller to render as a QR code; resolves with the created app credentials
 * once the user scans and authorizes.
 */
export async function provisionApp(options: ProvisionOptions): Promise<ProvisionResult> {
  const registered = await registerApp({
    source: options.source ?? 'dsh-feishu-scan',
    signal: options.signal,
    appPreset: {
      name: 'DSH 助手',
      desc: 'DeepSeek Harness 飞书入口',
    },
    // Don't pass addons — the QR landing page's addons parameter overrides
    // the server's default app configuration, which may disable card action
    // callbacks. hermes and qwenpaw don't pass addons and card buttons work.
    onQRCodeReady: info => options.onState({ phase: 'waiting', qrUrl: info.url, expireIn: info.expireIn }),
    onStatusChange: () => undefined,
  })

  options.onState({ phase: 'configuring' })
  await enableWebsocketLongConnection(registered.client_id, registered.client_secret, options.domain)
  await enableCardCallbacks(registered.client_id, registered.client_secret, options.domain)

  return { appId: registered.client_id, appSecret: registered.client_secret }
}

/**
 * The scan flow cannot preset the event subscription transport (it is a
 * sensitive manifest field). Force WebSocket long connection and subscribe the
 * message event through the "update application config" OpenAPI.
 */
export async function enableWebsocketLongConnection(appId: string, appSecret: string, domain: DomainName): Promise<void> {
  const client = new Client({
    appId,
    appSecret,
    domain: domain === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'dsh-feishu-scan',
  })
  const response = await client.application.v7.applicationConfig.patch({
    data: {
      event: {
        subscription_type: 'websocket',
        add_events: [FEISHU_MESSAGE_EVENT],
      },
    },
    path: { app_id: appId },
  })
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`飞书应用配置更新失败: ${response.code} ${response.msg ?? ''}`)
  }
}

/**
 * Enable card action callbacks via the applicationAbility.patch API.
 * Without this, interactive card buttons/selectors do not fire
 * `card.action.trigger` events and appear unresponsive.
 */
export async function enableCardCallbacks(appId: string, appSecret: string, domain: DomainName): Promise<void> {
  const client = new Client({
    appId,
    appSecret,
    domain: domain === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'dsh-feishu-scan',
  })
  const response = await client.application.v7.applicationAbility.patch({
    path: { app_id: appId },
    data: {
      card_action_callback: {
        enable: true,
      },
    } as any,
  })
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`飞书卡片回调配置失败: ${response.code} ${response.msg ?? ''}`)
  }
}

/** Print the verification URL as an ASCII QR code plus a fallback link. */
export function renderTerminalQr(url: string, logger: ProvisionLogger): void {
  logger.info('请用飞书 App 扫描下方二维码完成配置:')
  qrcode.generate(url, { small: true }, qrcodeText => logger.info(qrcodeText))
  logger.info(`如果二维码无法扫描,请在飞书中打开链接: ${url}`)
}
