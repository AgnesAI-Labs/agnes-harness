import type { CompositeTargetStore } from '@agnes/daemon-foundation/storage/composite-target-store'
import type { RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { decodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import type { RuntimeConvergenceReport } from '@agnes/protocol'

export type RuntimeTargetApplyReceipt = Readonly<{
  generation: number
  report: RuntimeConvergenceReport
  isCurrent?(): boolean
  restore?(): Promise<void>
}>

export type ProbedRuntimeTargetPublish = Readonly<{
  store: CompositeTargetStore
  artifact: RuntimeTargetArtifact
  pins?: readonly string[]
  probe(artifact: RuntimeTargetArtifact): Promise<void>
  /** Authorized business-worker apply, separate from the canonical-artifact probe. */
  apply?(artifact: RuntimeTargetArtifact): Promise<RuntimeTargetApplyReceipt>
}>

/**
 * Probe the already-encoded artifact, then persist that same payload. The target is never rebuilt
 * after probe.
 */
export async function publishProbedRuntimeTarget(options: ProbedRuntimeTargetPublish): Promise<void> {
  const artifact = Object.freeze({
    encoding: 'base64' as const,
    canonicalBase64: options.artifact.canonicalBase64,
    digest: options.artifact.digest,
    identity: Object.freeze({ ...options.artifact.identity }),
  })
  decodeRuntimeTargetArtifact(artifact)
  const baseline = options.store.desired()?.digest
  for (const pin of options.pins ?? []) options.store.pin(pin)
  await options.probe(artifact)
  if (options.store.desired()?.digest !== baseline) throw new Error('E_RUNTIME_TARGET_STALE')
  const receipt = await options.apply?.(artifact)
  try {
    if (
      receipt &&
      (!receipt.report.ok ||
        receipt.report.hash !== artifact.identity.treeHash ||
        !Number.isSafeInteger(receipt.generation) ||
        receipt.generation < 1 ||
        receipt.isCurrent?.() === false)
    )
      throw new Error('E_RUNTIME_TARGET_OUTCOME_UNKNOWN')
    if (options.store.desired()?.digest !== baseline) throw new Error('E_RUNTIME_TARGET_STALE')
    const remaining = new Set(options.store.pins())
    for (const pin of options.pins ?? []) {
      if (!remaining.has(pin)) throw new Error(`E_RUNTIME_TARGET_PIN: pin ${pin} missing after probe`)
    }
    // Desired, config audit and qualification commit together, before leaving compensation scope.
    options.store.publishDesired(artifact, receipt)
  } catch (error) {
    // Remain inside the publication lane while restoring after a post-apply refusal/CAS failure.
    try {
      await receipt?.restore?.()
    } catch {
      throw new Error('E_RUNTIME_TARGET_OUTCOME_UNKNOWN')
    }
    throw error
  }
  options.store.sweepPins()
}
