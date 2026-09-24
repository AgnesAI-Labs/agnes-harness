import type { RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import {
  differingPackages,
  emptyTarget,
  type LoadableSnapshots,
  revertTarget,
  sameTargetContent,
} from './composite-desired.js'
import type { CompositeTargetStore } from './storage/composite-target-store.js'

export type TargetRevertAuditEvent = Readonly<{ kind: string; detail: Readonly<Record<string, unknown>> }>

export type TargetReverterOptions = Readonly<{
  store: CompositeTargetStore
  /** What a worker started right now could import, keyed `<package>@<snapshot>`. */
  loadableSnapshots(): Promise<LoadableSnapshots>
  now?: () => string
  audit?: (event: TargetRevertAuditEvent) => void
}>

/**
 * Puts the desired target back after the worker reported that it could not apply it.
 *
 * It works from what is stored, so it is safe to call from anywhere, any number of times: when the
 * desired target is not a failed one there is nothing to do. The first fallback is what was desired
 * before, without the rows a restarted worker could no longer load. When that fallback failed as well
 * the next one is no packages at all, and after that there is nothing left to try.
 */
export function createTargetReverter(options: TargetReverterOptions): {
  revertFailedDesired(): Promise<void>
} {
  const { store } = options
  const now = options.now ?? (() => new Date().toISOString())

  async function once(): Promise<void> {
    const failure = store.lastFailure()
    const desired = store.desired()
    if (!failure || !desired || failure.digest !== desired.digest) return
    const loadable = await options.loadableSnapshots()
    // Something newer may have been published while the inventory was being read.
    if (store.desired()?.digest !== desired.digest) return

    // A fallback that was put back and failed too has only one way left: the empty package set.
    // Working out the fallback from what came before again would send it back to a target that failed.
    let level: 'previous' | 'empty'
    let target: RuntimeTargetArtifact
    if (store.isRevertTarget(desired.digest)) {
      level = 'empty'
      target = emptyTarget(desired)
    } else {
      level = 'previous'
      target = revertTarget(desired, store.previous(), loadable)
    }
    if (sameTargetContent(target, desired)) return

    const { packages, unattributed } = differingPackages(desired, target)
    const applied = store.revertDesired({
      expectedDigest: desired.digest,
      target,
      packages,
      failure: { digest: desired.digest, phase: failure.phase, message: failure.message },
      at: now(),
    })
    if (!applied) return
    options.audit?.({
      kind: 'plugin.tree.reverted',
      detail: {
        digest: desired.digest,
        target: target.digest,
        level,
        packages,
        unattributed,
        phase: failure.phase,
        message: failure.message,
      },
    })
  }

  let running: Promise<void> | undefined
  let again = false
  return {
    revertFailedDesired() {
      if (running) {
        again = true
        return running
      }
      running = (async () => {
        do {
          again = false
          await once()
        } while (again)
      })().finally(() => {
        running = undefined
      })
      return running
    },
  }
}
