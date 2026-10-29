import type { PackageInstalledDescriptor, PackageOperation, PackagePreview } from '@agnes/protocol'
import type { AdminError, InstallReviewState } from '../types.js'
import type { PreviewMode } from './operation-storage.js'

/** Why an operation stopped, as the page shows it. */
export const operationFailure = (operation: PackageOperation): AdminError => ({
  code: operation.error?.code ?? 'E_PACKAGE_STATE',
  message: operation.error?.safeMessage ?? 'The operation could not be completed.',
  blockers: operation.error?.blockers,
  sourceFailure: operation.error?.sourceFailure,
})

type Review = {
  busy: boolean
  error?: AdminError | undefined
  enableAfter?: boolean
  /** The install or update its confirmation started. */
  operationId?: string | undefined
}

/**
 * What the full plugins page shows of an install while it runs: a check on the catalog card that
 * asked (keyed by package id) or on the add form, then the review page of the finished check, busy
 * until the confirmed operation settles. Nothing here opens a dialog or moves the page.
 */
export class InstallFlow {
  readonly #checking = new Set<string>()
  readonly #checks = new Map<string, string>()
  readonly #failures = new Map<string, AdminError>()
  review: Review | undefined
  /** The check the add form waits on. */
  sourceCheck: string | undefined
  /** The running operations were asked for; they never open by themselves. */
  operationsShown = false

  checking(key: string): boolean {
    return this.#checking.has(key)
  }

  failure(key: string): AdminError | undefined {
    return this.#failures.get(key)
  }

  begin(key: string): void {
    this.#checking.add(key)
    this.#failures.delete(key)
  }

  accepted(key: string, operationId: string): void {
    this.#checks.set(operationId, key)
  }

  stopped(key: string, error: AdminError): void {
    this.#checking.delete(key)
    this.#failures.set(key, error)
  }

  /** A check settled; the card that asked for it, if any, is no longer checking. */
  settle(operationId: string): string | undefined {
    const key = this.#checks.get(operationId)
    this.#checks.delete(operationId)
    if (key) this.#checking.delete(key)
    return key
  }

  /** The review settles with the operation it started, or undefined for another operation. */
  reviewed(operation: PackageOperation): boolean {
    return !!this.review?.operationId && this.review.operationId === operation.operationId
  }

  state(
    preview: PackagePreview | undefined,
    mode: PreviewMode,
    current: PackageInstalledDescriptor | undefined,
    combined: boolean,
    enables: boolean,
  ): InstallReviewState | undefined {
    const review = this.review
    if (!preview || !review) return undefined
    return {
      preview,
      mode,
      current,
      combined,
      enables,
      enableAfter: review.enableAfter ?? false,
      busy: review.busy,
      error: review.error,
    }
  }
}
