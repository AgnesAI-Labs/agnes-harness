import type { RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import {
  validateRuntimeApplyFailedFrame,
  validateRuntimeBootReadyFrame,
  validateRuntimeConvergedFrame,
} from '@agnes/protocol'
import { RuntimeAdmission } from './runtime-admission.js'
import type { CompositeTargetStore } from './storage/composite-target-store.js'

export type RuntimeBootDelivery = Readonly<{
  artifact: RuntimeTargetArtifact
  source: 'lastGood' | 'bootstrap'
}>

export type CompositeRuntimeDeliveryOptions = Readonly<{
  /** Called, without blocking the frame, after a failure of the desired target was recorded. */
  onFailureRecorded?: (() => unknown) | undefined
}>

/**
 * Owns lastGood/bootstrap delivery, boot_ready admission, and qualified converged/failure writes.
 * Probe-successful artifacts are never rebuilt here.
 */
export class CompositeRuntimeDelivery {
  readonly #store: CompositeTargetStore
  readonly #boots = new Map<number, RuntimeAdmission>()
  readonly #onFailureRecorded: (() => unknown) | undefined

  constructor(store: CompositeTargetStore, options: CompositeRuntimeDeliveryOptions = {}) {
    this.#store = store
    this.#onFailureRecorded = options.onFailureRecorded
  }

  #failureRecorded(): void {
    const notify = this.#onFailureRecorded
    if (!notify) return
    void Promise.resolve()
      .then(notify)
      .catch(() => undefined)
  }

  /**
   * A worker start that never reached boot_ready. When the target it was started with is the desired
   * one, that target is what failed, and the failure is recorded so it gets put back. Answers whether
   * the desired target was the cause: it was when nothing had ever been confirmed to start from.
   */
  recordBootFailure(generation: number, boot: RuntimeBootDelivery, error: Error): boolean {
    if (boot.source !== 'bootstrap') return false
    const recorded = this.#store.qualifyFailed(generation, boot.artifact, {
      generation,
      digest: boot.artifact.digest,
      identity: boot.artifact.identity,
      phase: 'boot',
      message: error.message,
    })
    if (recorded) this.#failureRecorded()
    // Not recorded because the failure frame got there first and the target is already put back.
    // A target that moved on for any other reason blames nothing, so the exit stays a crash.
    return recorded || this.#store.revertedFrom(boot.artifact.digest) !== undefined
  }

  bootFor(_generation: number): RuntimeBootDelivery | undefined {
    const lastGood = this.#store.lastGood()
    if (lastGood) return Object.freeze({ artifact: lastGood, source: 'lastGood' as const })
    const desired = this.#store.desired()
    if (desired) return Object.freeze({ artifact: desired, source: 'bootstrap' as const })
    return undefined
  }

  desired(): RuntimeTargetArtifact | undefined {
    return this.#store.desired()
  }

  beginBoot(generation: number, boot: RuntimeBootDelivery): RuntimeAdmission {
    const admission = new RuntimeAdmission({
      workerKind: 'session',
      workerKey: '@shared',
      generation,
      digest: boot.artifact.digest,
      identity: boot.artifact.identity,
      source: boot.source,
    })
    this.#boots.set(generation, admission)
    return admission
  }

  admission(generation: number): RuntimeAdmission | undefined {
    return this.#boots.get(generation)
  }

  handleWorkerFrame(generation: number, frame: unknown): boolean {
    const boot = validateRuntimeBootReadyFrame(frame)
    if (boot.ok) return this.#boots.get(generation)?.admit(boot.value) === true
    const failedBoot = validateRuntimeApplyFailedFrame(frame)
    if (failedBoot.ok && failedBoot.value.generation === generation) {
      const admission = this.#boots.get(generation)
      if (admission && !admission.ready && admission.expected.digest === failedBoot.value.digest)
        admission.fail(new Error(failedBoot.value.message))
    }
    const desired = this.#store.desired()
    if (!desired) return false
    const converged = validateRuntimeConvergedFrame(frame)
    if (converged.ok) {
      const value = converged.value
      if (value.generation !== generation || value.digest !== desired.digest) return false
      return this.#store.qualifyConverged(value.generation, desired, value.report)
    }
    const failed = validateRuntimeApplyFailedFrame(frame)
    if (failed.ok) {
      const value = failed.value
      if (value.generation !== generation || value.digest !== desired.digest) return false
      const recorded = this.#store.qualifyFailed(value.generation, desired, {
        generation: value.generation,
        digest: value.digest,
        identity: value.identity,
        phase: value.phase,
        message: value.message,
      })
      if (recorded) this.#failureRecorded()
      return recorded
    }
    return false
  }
}

/**
 * A published desired must reach a Host-bearing worker so it can emit runtime.converged.
 * Serve-only plugin admin never opens a session, so acquire the shared worker when none is live.
 */
export async function deliverDesiredToWorkers(
  pool: {
    businessWorker(): { link: { offerRuntimeTarget(artifact: RuntimeTargetArtifact): void } } | undefined
    acquireSharedWorker(): Promise<unknown>
  },
  artifact: RuntimeTargetArtifact,
): Promise<void> {
  const live = pool.businessWorker()
  if (live) {
    live.link.offerRuntimeTarget(artifact)
    return
  }
  await pool.acquireSharedWorker()
  pool.businessWorker()?.link.offerRuntimeTarget(artifact)
}
