import { provisionApp } from './provision.ts'
import type { ProvisionResult, ProvisionState } from './provision.ts'
import type { DomainName } from './config.ts'

export interface ProvisionManagerDeps {
  domain(): DomainName
  onState(state: ProvisionState): void
  onProvisioned(result: ProvisionResult): Promise<void>
}

/**
 * Owns the scan-to-configure lifecycle: at most one in-flight flow, cancellable
 * via {@link dispose}, reporting each transition through {@link onState} and
 * writing credentials back through {@link onProvisioned}.
 */
export class ProvisionManager {
  private controller: AbortController | undefined
  private state: ProvisionState = { phase: 'idle' }

  constructor(private readonly deps: ProvisionManagerDeps) {}

  status(): ProvisionState {
    return { ...this.state }
  }

  isRunning(): boolean {
    return this.controller !== undefined
  }

  start(): ProvisionState {
    if (this.controller !== undefined) return this.status()
    const controller = new AbortController()
    this.controller = controller
    this.setState({ phase: 'waiting' })
    void this.run(controller)
    return this.status()
  }

  dispose(): void {
    this.controller?.abort()
    this.controller = undefined
    if (this.state.phase !== 'idle') this.setState({ phase: 'idle' })
  }

  private setState(next: ProvisionState): void {
    this.state = next
    this.deps.onState(next)
  }

  private async run(controller: AbortController): Promise<void> {
    try {
      const result = await provisionApp({
        domain: this.deps.domain(),
        signal: controller.signal,
        onState: state => this.setState(state),
      })
      this.controller = undefined
      this.setState({ phase: 'done' })
      await this.deps.onProvisioned(result)
    } catch (error) {
      const aborted = controller.signal.aborted
      this.controller = undefined
      if (aborted) {
        this.setState({ phase: 'idle' })
      } else {
        this.setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }
  }
}
