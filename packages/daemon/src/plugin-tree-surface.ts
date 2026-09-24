import type { RuntimeTargetArtifact, RuntimeTargetIdentity } from '@agnes/plugin-runtime/host'
import type { CompositeTargetStore } from './storage/composite-target-store.js'

export type PluginTreeActual = Readonly<{
  desiredDigest: string
  identity: RuntimeTargetIdentity
  actual: boolean
  pending: boolean
  reportOk: boolean | undefined
  failurePhase: string | undefined
  workerGeneration: number | undefined
}>

export type TreeChangedNotice = Readonly<{
  type: 'tree_changed'
  profile: string
  targetDigest: string
  identity: RuntimeTargetIdentity
  hash: string
}>

function treeChangedNotice(profile: string, artifact: RuntimeTargetArtifact): TreeChangedNotice {
  return Object.freeze({
    type: 'tree_changed',
    profile,
    targetDigest: artifact.digest,
    identity: Object.freeze({ ...artifact.identity }),
    hash: artifact.digest,
  })
}

/**
 * Actual is qualified report.ok for the current desired digest/identity and current worker generation.
 * Resource-only updates stay pending until that qualification holds.
 */
export function pluginTreeActual(
  store: CompositeTargetStore,
  workerGeneration: number | undefined,
): PluginTreeActual | undefined {
  const desired = store.desired()
  if (!desired) return undefined
  const ack = store.acknowledged()
  const report = store.report()
  const lastGood = store.lastGood()
  const qualified =
    Boolean(report?.ok) &&
    ack?.digest === desired.digest &&
    lastGood?.digest === desired.digest &&
    ack.identity.treeHash === desired.identity.treeHash &&
    ack.identity.resourceRevision === desired.identity.resourceRevision &&
    ack.identity.compositeRevision === desired.identity.compositeRevision &&
    workerGeneration !== undefined &&
    workerGeneration >= 1 &&
    ack.generation === workerGeneration
  return Object.freeze({
    desiredDigest: desired.digest,
    identity: Object.freeze({ ...desired.identity }),
    actual: qualified,
    pending: !qualified,
    reportOk: report?.ok,
    failurePhase: store.lastFailure()?.phase,
    workerGeneration,
  })
}

export function pluginTreeList(
  store: CompositeTargetStore,
  profile: string,
  workerGeneration: number | undefined,
): Readonly<{
  desired: RuntimeTargetArtifact | undefined
  actual: PluginTreeActual | undefined
  notice: TreeChangedNotice | undefined
}> {
  const desired = store.desired()
  return Object.freeze({
    desired,
    actual: pluginTreeActual(store, workerGeneration),
    notice: desired ? treeChangedNotice(profile, desired) : undefined,
  })
}
