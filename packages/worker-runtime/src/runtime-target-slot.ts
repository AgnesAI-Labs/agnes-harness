import type { RuntimeTarget, RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { adaptRuntimeStaleFrame, type VerifiedRuntimeTargetDelivery } from './runtime-target-artifact.js'

export type RuntimeTargetApplyPort<Result = void> = Readonly<{
  applyRuntimeTarget(target: RuntimeTarget): Result | PromiseLike<Result>
}>

export type RuntimeTargetSlotOutcome<Result = void> =
  | Readonly<{
      status: 'applied'
      artifact: RuntimeTargetArtifact
      /** False when this digest is already the live target and Host does not need another apply. */
      changed: boolean
      value: Result
    }>
  | Readonly<{
      status: 'failed'
      artifact: RuntimeTargetArtifact
      error: unknown
    }>
  | Readonly<{
      status: 'superseded'
      artifact: RuntimeTargetArtifact
      supersededBy: string
    }>

export type RuntimeTargetSlot<Result = void> = Readonly<{
  /**
   * Verify and enqueue one complete runtime.stale frame. Host applies are serialized; while one is
   * running, only the most recently offered distinct target remains queued.
   */
  offer(frame: unknown): Promise<RuntimeTargetSlotOutcome<Result>>
}>

type Waiter<Result> = (outcome: RuntimeTargetSlotOutcome<Result>) => void

type TargetEntry<Result> = {
  readonly delivery: VerifiedRuntimeTargetDelivery
  readonly waiters: Waiter<Result>[]
}

type AppliedTarget<Result> = Readonly<{
  digest: string
  value: Result
}>

class LatestRuntimeTargetSlot<Result> implements RuntimeTargetSlot<Result> {
  readonly #port: RuntimeTargetApplyPort<Result>
  #active: TargetEntry<Result> | undefined
  #pending: TargetEntry<Result> | undefined
  #applied: AppliedTarget<Result> | undefined
  #draining = false

  constructor(port: RuntimeTargetApplyPort<Result>) {
    this.#port = port
  }

  offer(frame: unknown): Promise<RuntimeTargetSlotOutcome<Result>> {
    let delivery: VerifiedRuntimeTargetDelivery
    try {
      // The Task 8 adapter validates the envelope and owns immutable artifact/target snapshots
      // before this method returns control to the caller.
      delivery = adaptRuntimeStaleFrame(frame)
    } catch (error) {
      return Promise.reject(error)
    }

    return new Promise<RuntimeTargetSlotOutcome<Result>>((resolve) => {
      const digest = delivery.artifact.digest

      if (this.#active?.delivery.artifact.digest === digest) {
        // A repeat of the target currently being applied is the newest desired value. Any different
        // queued target is therefore stale, even though this apply itself does not need to restart.
        this.#supersedePending(digest)
        this.#active.waiters.push(resolve)
        return
      }

      if (this.#pending?.delivery.artifact.digest === digest) {
        this.#pending.waiters.push(resolve)
        return
      }

      if (!this.#active && !this.#pending && this.#applied?.digest === digest) {
        resolve(
          Object.freeze({
            status: 'applied',
            artifact: delivery.artifact,
            changed: false,
            value: this.#applied.value,
          }),
        )
        return
      }

      this.#supersedePending(digest)
      this.#pending = { delivery, waiters: [resolve] }
      this.#startDrain()
    })
  }

  #supersedePending(supersededBy: string): void {
    const pending = this.#pending
    if (!pending) return
    this.#pending = undefined
    this.#finish(
      pending,
      Object.freeze({
        status: 'superseded',
        artifact: pending.delivery.artifact,
        supersededBy,
      }),
    )
  }

  #startDrain(): void {
    if (this.#draining) return
    this.#draining = true
    void this.#drain()
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending) {
        const entry = this.#pending
        this.#pending = undefined
        this.#active = entry
        const digest = entry.delivery.artifact.digest
        const alreadyApplied = this.#applied

        if (alreadyApplied?.digest === digest) {
          this.#finish(
            entry,
            Object.freeze({
              status: 'applied',
              artifact: entry.delivery.artifact,
              changed: false,
              value: alreadyApplied.value,
            }),
          )
          this.#active = undefined
          continue
        }

        try {
          const value = await this.#port.applyRuntimeTarget(entry.delivery.target)
          this.#applied = Object.freeze({ digest, value })
          this.#finish(
            entry,
            Object.freeze({
              status: 'applied',
              artifact: entry.delivery.artifact,
              changed: true,
              value,
            }),
          )
        } catch (error) {
          this.#finish(entry, Object.freeze({ status: 'failed', artifact: entry.delivery.artifact, error }))
        } finally {
          this.#active = undefined
        }
      }
    } finally {
      this.#draining = false
      // Defensive against a reentrant offer from an unusual thenable/failure object while the final
      // loop iteration is settling. Normal Promise continuations already observe draining=true.
      if (this.#pending) this.#startDrain()
    }
  }

  #finish(entry: TargetEntry<Result>, outcome: RuntimeTargetSlotOutcome<Result>): void {
    for (const resolve of entry.waiters.splice(0)) resolve(outcome)
  }
}

export function createRuntimeTargetSlot<Result = void>(
  port: RuntimeTargetApplyPort<Result>,
): RuntimeTargetSlot<Result> {
  return new LatestRuntimeTargetSlot(port)
}
