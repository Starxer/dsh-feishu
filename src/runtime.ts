import { resolveRuntimeConfig } from './config.ts'
import type { RuntimeConfig, SettingsConfig } from './config.ts'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'

export type RuntimeStatus =
  | { state: 'unconfigured'; message: string }
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'error'; message: string }
  | { state: 'stopped' }

export interface LarkRuntimeStart {
  stop: () => Promise<void>
  channel: LarkChannel
}

export interface LarkRuntimeDependencies {
  settings(): SettingsConfig
  resolveSecret(ref: string): Promise<string | undefined>
  start(config: RuntimeConfig): Promise<LarkRuntimeStart>
}

export class LarkRuntime {
  private current: { fingerprint: string; start: LarkRuntimeStart } | undefined
  private snapshot: RuntimeStatus = { state: 'unconfigured', message: 'App ID and App Secret are required' }
  private operations = Promise.resolve()
  private disposed = false
  /** Notified whenever the active Lark channel changes (initial connect or
   *  post-reconcile reconnect). The Feishu questions listener subscribes
   *  here so it always uses the channel's card send + cardAction handler. */
  onChannelChange?: (channel: LarkChannel) => void

  constructor(private readonly deps: LarkRuntimeDependencies) {}

  status(): RuntimeStatus {
    return { ...this.snapshot }
  }

  reconcile(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return
      let secret: string | undefined
      let invalidConfig = false
      try {
        const settings = this.deps.settings()
        secret = await this.deps.resolveSecret(settings.appSecretRef) ?? settings.appSecret
        let config: RuntimeConfig
        try {
          config = resolveRuntimeConfig(settings, secret)
        } catch (error) {
          invalidConfig = true
          throw error
        }
        const fingerprint = JSON.stringify(config)
        if (this.current?.fingerprint === fingerprint) return
        await this.stopCurrent()
        this.snapshot = { state: 'connecting' }
        const start = await this.deps.start(config)
        if (this.disposed) {
          await start.stop()
          return
        }
        this.current = { fingerprint, start }
        this.snapshot = { state: 'connected' }
        this.onChannelChange?.(start.channel)
      } catch (error) {
        let failure = error
        if (invalidConfig) {
          try {
            await this.stopCurrent()
          } catch (stopError) {
            invalidConfig = false
            failure = stopError
          }
        }
        const message = failure instanceof Error ? failure.message : String(failure)
        const redacted = secret === undefined || secret === '' ? message : message.split(secret).join('[redacted]')
        this.snapshot = invalidConfig
          ? { state: 'unconfigured', message: redacted }
          : { state: 'error', message: redacted }
      }
    })
  }

  dispose(): Promise<void> {
    this.disposed = true
    return this.enqueue(async () => {
      await this.stopCurrent()
      this.snapshot = { state: 'stopped' }
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operations.then(operation, operation)
    this.operations = result.catch(() => undefined)
    return result
  }

  private async stopCurrent(): Promise<void> {
    const current = this.current
    this.current = undefined
    if (current !== undefined) await current.start.stop()
  }
}
