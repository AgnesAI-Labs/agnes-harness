import type { ResourceOperationReceipt, SkillScanReport } from '@agnes/protocol'

const scopeError = () =>
  Object.assign(new Error('Skill scan scope changed.'), { code: 'SKILL_SCAN_SCOPE_CHANGED' })
export function isSkillScanScopeError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'SKILL_SCAN_SCOPE_CHANGED'
}

export function normalizeWorkspaceId(workspaceId?: string): string | undefined {
  return workspaceId && /^[a-f0-9]{64}$/.test(workspaceId) ? workspaceId : undefined
}

/** A report belongs to one mounted resource scope and one completed scan operation. */
export class SkillScanController {
  #running = false
  #revision = 0
  #report: SkillScanReport | undefined
  constructor(readonly changed?: ((report: SkillScanReport | undefined) => void) | undefined) {}
  clear(): void {
    this.#revision++
    this.#running = false
    this.#report = undefined
    this.changed?.(undefined)
  }
  observe(report: SkillScanReport | undefined): void {
    // Server generations restart with the daemon; the owning page fences list replies by request and scope.
    this.#report = report
    this.changed?.(report)
  }
  async run(options: {
    allowed: boolean
    refresh(): Promise<ResourceOperationReceipt>
    track(receipt: ResourceOperationReceipt): Promise<boolean>
    completed(operationId: string): void
    cancelled(operationId: string): boolean
  }): Promise<SkillScanReport | undefined> {
    if (!options.allowed || this.#running) throw new Error('Skill scan is unavailable.')
    this.#running = true
    const revision = this.#revision
    try {
      const receipt = await options.refresh()
      if (revision !== this.#revision) throw scopeError()
      const completed = await options.track(receipt)
      if (revision !== this.#revision) throw scopeError()
      if (!completed)
        throw Object.assign(new Error('Skill scan did not finish.'), {
          code: options.cancelled(receipt.operationId) ? 'SKILL_SCAN_CANCELLED' : 'SKILL_SCAN_INCOMPLETE',
        })
      if (this.#report?.operationId !== receipt.operationId) return undefined
      options.completed(receipt.operationId)
      return this.#report
    } catch (error) {
      if (revision !== this.#revision) throw scopeError()
      throw error
    } finally {
      if (revision === this.#revision) this.#running = false
    }
  }
}
