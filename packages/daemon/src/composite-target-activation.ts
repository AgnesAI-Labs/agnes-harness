import { PackageError, type PackageManager } from '@agnes/package-manager'
import { decodeRuntimeTargetArtifact, type RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import type { PackageAdminError, RuntimePinDescriptor, RuntimePinReleaseResult } from '@agnes/protocol'
import { ownsRow } from './composite-desired.js'
import { idle, type SettleOptions, settle } from './composite-target-settle.js'
import {
  classifyPackageContributions,
  type PackageContributionInput,
  packageActualReady,
  packageExtensionRowsActive,
  packageExtensionRowsStopped,
} from './package-readiness.js'
import type {
  PackageActivationAdapter,
  PackageActivationObservation,
  RuntimePinsAdapter,
} from './packages/handler.js'
import type { PackageReferenceFactReader } from './packages/runtime-references.js'
import { pluginTreeActual } from './plugin-tree-surface.js'
import { type createRuntimePinCoordinator, referencedRuntimePins } from './runtime-pin-coordinator.js'
import { publishProbedRuntimeTarget } from './runtime-target-publisher.js'
import type { CompositeTargetStore } from './storage/composite-target-store.js'

export type CompositeTargetActivationOptions = Readonly<{
  store: CompositeTargetStore
  workerGeneration?: () => number | undefined
  /** Produce the complete desired artifact after lockfile enable/disable/update. */
  desiredFor?(input: {
    profile: string
    packageId: string
    operation: 'enable' | 'disable' | 'update' | 'rollback' | 'remove'
  }): RuntimeTargetArtifact | Promise<RuntimeTargetArtifact | undefined> | undefined
  contributions?(packageId: string): readonly PackageContributionInput[] | undefined
  surfaceRunningRevision?(packageId: string): string | undefined
  desiredSurfaceRevision?(packageId: string): string | undefined
  clientRosterMatch?(packageId: string): boolean
  extensionRowsActive?(packageId: string): boolean
  packageIdentity?(packageId: string): Readonly<{ version?: string; integrity: string }> | undefined
  /** Re-check eligibility before a historical target can be replayed by rollback. */
  lifecycleEligible?(packageId: string): boolean
  /** The isolated worker probe that must accept an artifact before it becomes desired. */
  probe?(artifact: RuntimeTargetArtifact): Promise<void>
  publish?(
    artifact: RuntimeTargetArtifact,
    probe: (artifact: RuntimeTargetArtifact) => Promise<void>,
  ): Promise<void>
  collectPins?(): Promise<void>
  revokePackage?(packageId: string): Promise<void>
  releaseRetiring?(packageId: string): Promise<void>
  deliver?(artifact: RuntimeTargetArtifact): Promise<void>
  /**
   * Make an operation wait for what became of its own target, and for an earlier one to be settled
   * before it starts. Left out, an operation returns as soon as the target was delivered.
   */
  settle?: Omit<SettleOptions, 'signal'>
  /** Puts a target that failed back before the next one is composed on top of it. */
  revertFailedDesired?(): Promise<void>
}>

/**
 * Whether nothing of this package runs or is about to. The desired tree must want it off (every row of
 * the package disabled, or none), and either no worker is alive to run it, or the worker confirmed the
 * latest tree and its report shows no row of the package that is not disabled.
 */
function packageStopped(
  store: CompositeTargetStore,
  workerGeneration: number | undefined,
  packageId: string,
): boolean {
  const desired = store.desired()
  if (!desired) return true
  const wantsOff = decodeRuntimeTargetArtifact(desired).tree.rows.every(
    (row) => !ownsRow(row.plugin, packageId) || row.disabled,
  )
  if (!wantsOff) return false
  if (workerGeneration === undefined) return true
  const report = store.report()
  return (
    store.acknowledged()?.digest === desired.digest &&
    store.acknowledged()?.generation === workerGeneration &&
    report !== undefined &&
    packageExtensionRowsStopped(packageId, report.rows, packageRowIds(store, packageId))
  )
}

/** The worker confirmed the desired tree and it loads an enabled row of this package. */
function confirmedRunning(
  store: CompositeTargetStore,
  workerGeneration: number | undefined,
  packageId: string,
): boolean {
  const desired = store.desired()
  if (
    !desired ||
    workerGeneration === undefined ||
    store.acknowledged()?.digest !== desired.digest ||
    store.acknowledged()?.generation !== workerGeneration
  )
    return false
  return decodeRuntimeTargetArtifact(desired).tree.rows.some(
    (row) => ownsRow(row.plugin, packageId) && !row.disabled,
  )
}

/**
 * The ids of the rows the desired tree and the last confirmed tree load from this package. The
 * report describes the confirmed tree, which can be older than the desired one.
 */
function packageRowIds(store: CompositeTargetStore, packageId: string): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const artifact of [store.desired(), store.lastGood()]) {
    if (!artifact) continue
    for (const row of decodeRuntimeTargetArtifact(artifact).tree.rows) {
      if (ownsRow(row.plugin, packageId)) ids.add(row.id)
    }
  }
  return ids
}

/** Legacy activation without pinned snapshots cannot keep an unavailable boot target. */
function dropUnpinnedLastGood(
  store: CompositeTargetStore,
  packageId: string,
  next: RuntimeTargetArtifact,
): void {
  const lastGood = store.lastGood()
  if (!lastGood) return
  // `entryRevision` already carries the row's real snapshot id (every row constructor sets it to the
  // same snapshotId as `plugin`'s `@<snapshot>` segment). Comparing it avoids re-deriving that segment
  // by slicing `plugin` at its last '/', which mis-parses multi-client rows shaped
  // `<package>@<snapshot>/client/<id>` (an extra '/' after the snapshot).
  const nextSnapshots = new Set(
    decodeRuntimeTargetArtifact(next)
      .tree.rows.filter((row) => ownsRow(row.plugin, packageId))
      .map((row) => row.entryRevision),
  )
  if (
    decodeRuntimeTargetArtifact(lastGood).tree.rows.some(
      (row) => ownsRow(row.plugin, packageId) && !nextSnapshots.has(row.entryRevision),
    )
  )
    store.dropLastGood()
}

function observation(
  options: CompositeTargetActivationOptions,
  packageId?: string,
): PackageActivationObservation {
  const view = pluginTreeActual(options.store, options.workerGeneration?.())
  if (!view) return { actual: 'not-running' }
  // A failure held against this package. It names no version: nothing of it is known to be running.
  const held = packageId ? options.store.packageFailure(packageId) : undefined
  if (packageId && held) {
    if (!confirmedRunning(options.store, options.workerGeneration?.(), packageId))
      return { actual: 'failed', actualReason: held.phase }
    // A mark the failure left on a package that turned out to run fine does not outlive that.
    options.store.clearPackageFailure(packageId)
  }
  if (view.failurePhase) return withPackageIdentity(options, packageId, 'failed', view.failurePhase)
  if (packageId && options.contributions) {
    const contributions = options.contributions(packageId) ?? []
    const surfaceRunningRevision = options.surfaceRunningRevision?.(packageId)
    const desiredSurfaceRevision = options.desiredSurfaceRevision?.(packageId)
    const reportRows = options.store.report()?.rows ?? []
    const hasBackendRows = [...packageRowIds(options.store, packageId)].some((id) => !id.startsWith('web:'))
    const readinessClass = classifyPackageContributions(contributions, hasBackendRows)
    // A package the tree does not want running, with nothing left running it, is simply not running.
    // Reporting it as starting would block removing a disabled package, which needs not-running.
    if (
      readinessClass === 'extension-only' &&
      packageStopped(options.store, options.workerGeneration?.(), packageId)
    )
      return { actual: 'not-running' }
    const ready = packageActualReady({
      class: readinessClass,
      desiredPublished: Boolean(options.store.desired()),
      treeQualified: view.actual,
      extensionRowsActive:
        options.extensionRowsActive?.(packageId) ??
        packageExtensionRowsActive(packageId, reportRows, packageRowIds(options.store, packageId)),
      ...(surfaceRunningRevision === undefined ? {} : { surfaceRunningRevision }),
      ...(desiredSurfaceRevision === undefined ? {} : { desiredSurfaceRevision }),
      clientRosterMatch: options.clientRosterMatch?.(packageId) ?? false,
    })
    return withPackageIdentity(options, packageId, ready ? 'running' : 'starting')
  }
  if (view.actual) return withPackageIdentity(options, packageId, 'running')
  return { actual: 'starting' }
}

function withPackageIdentity(
  options: CompositeTargetActivationOptions,
  packageId: string | undefined,
  actual: PackageActivationObservation['actual'],
  actualReason?: string,
): PackageActivationObservation {
  const identity = packageId ? options.packageIdentity?.(packageId) : undefined
  const reason = actualReason === undefined ? {} : { actualReason }
  if (!identity || (actual !== 'running' && actual !== 'failed')) return { actual, ...reason }
  return {
    actual,
    ...(identity.version === undefined ? {} : { actualVersion: identity.version }),
    actualIntegrity: identity.integrity,
    ...reason,
  }
}

const unavailable: PackageAdminError = Object.freeze({
  code: 'E_PACKAGE_STATE',
  safeMessage: 'The package operation cannot run in the current state.',
  blockers: [],
})

/**
 * Enable/disable/update/rollback/remove write CompositeTargetStore only. They do not call the old
 * in-process activation lane.
 */
export function createCompositeTargetActivation(
  options: CompositeTargetActivationOptions,
): PackageActivationAdapter {
  return Object.freeze({
    async prepareRemoval(_profile, packageId) {
      if (!packageStopped(options.store, options.workerGeneration?.(), packageId))
        throw new Error('E_PACKAGE_STATE: package is still running')
      if (options.revokePackage) await options.revokePackage(packageId)
      else options.store.revokePackage(packageId)
      // Revocation changes the desired digest and clears the worker acknowledgement. Keep the
      // retiring snapshot pinned until the live worker confirms the sanitized target.
      const sanitized = options.store.desired()
      if (sanitized && !packageStopped(options.store, options.workerGeneration?.(), packageId)) {
        if (!options.settle) throw new Error('E_PACKAGE_STATE: package removal is not settled')
        await settle(options.store, sanitized.digest, {
          ...options.settle,
          ...(options.workerGeneration ? { workerGeneration: options.workerGeneration } : {}),
        })
        if (!packageStopped(options.store, options.workerGeneration?.(), packageId))
          throw new Error('E_PACKAGE_STATE: package removal is not settled')
      }
      await options.releaseRetiring?.(packageId)
      await options.collectPins?.()
    },
    async actual(_profile, packageId) {
      return observation(options, packageId)
    },
    async stopped(_profile, packageId) {
      return packageStopped(options.store, options.workerGeneration?.(), packageId)
    },
    async reconcile(input) {
      const probe = options.probe
      if (!probe) return { actual: 'failed', error: unavailable }
      const wait = options.settle && {
        ...options.settle,
        ...(options.workerGeneration ? { workerGeneration: options.workerGeneration } : {}),
      }
      if (wait) {
        await options.revertFailedDesired?.()
        // A target nobody is running would wait for nothing: start the worker that boots from it.
        const waiting = options.store.desired()
        if (
          waiting &&
          options.store.pending(options.workerGeneration?.()) &&
          options.workerGeneration?.() === undefined
        )
          await options.deliver?.(waiting).catch(() => undefined)
        await idle(options.store, { ...wait, signal: input.signal })
      }
      await options.revertFailedDesired?.()
      let next: RuntimeTargetArtifact | undefined
      if (input.operation === 'rollback') {
        if (options.lifecycleEligible && !options.lifecycleEligible(input.packageId))
          return { actual: 'failed', error: unavailable }
        next = options.store.previous()
      } else {
        next =
          (await options.desiredFor?.({
            profile: input.profile,
            packageId: input.packageId,
            operation: input.operation,
          })) ?? options.store.desired()
      }
      if (!next) return { actual: 'failed', error: unavailable }
      if (!options.publish) dropUnpinnedLastGood(options.store, input.packageId, next)
      if (options.publish) await options.publish(next, probe)
      else await publishProbedRuntimeTarget({ store: options.store, artifact: next, probe })
      await options.deliver?.(next)
      options.store.clearPackageFailure(input.packageId)
      if (!wait) {
        if (packageStopped(options.store, options.workerGeneration?.(), input.packageId))
          await options.releaseRetiring?.(input.packageId)
        if (packageStopped(options.store, options.workerGeneration?.(), input.packageId))
          await options.collectPins?.()
        return observation(options, input.packageId)
      }
      const outcome = await settle(options.store, next.digest, { ...wait, signal: input.signal })
      // Once the fallback was confirmed the target is only 'superseded', but the failure held against
      // this package still names it.
      const failedTarget =
        outcome === 'failed' ||
        (outcome === 'superseded' && options.store.packageFailure(input.packageId)?.digest === next.digest)
      if (failedTarget) {
        await options.revertFailedDesired?.()
        return { ...observation(options, input.packageId), error: unavailable }
      }
      if (packageStopped(options.store, options.workerGeneration?.(), input.packageId))
        await options.releaseRetiring?.(input.packageId)
      if (packageStopped(options.store, options.workerGeneration?.(), input.packageId))
        await options.collectPins?.()
      return observation(options, input.packageId)
    },
  })
}

export function createCompositeReferenceFacts(
  store: CompositeTargetStore,
  workerGeneration?: () => number | undefined,
): PackageReferenceFactReader {
  return async ({ packageId }) => {
    const desired = store.desired()
    const pins = store.pins()
    // The desired tree only holds a package while it may still run. Holding every package for as long
    // as any tree exists would make removal impossible for good.
    const stopped = packageStopped(store, workerGeneration?.(), packageId)
    return Object.freeze({
      dependencies: [],
      profile: [],
      deployments: [],
      runtime: Object.freeze([
        ...(desired && !stopped
          ? [{ kind: 'drainable' as const, reference: `target:${desired.digest}` }]
          : []),
        ...pins.map((pin) => ({ kind: 'pin' as const, reference: pin })),
      ]),
    })
  }
}

export function createCompositeRuntimePins(
  input: Readonly<{
    store: CompositeTargetStore
    profile: string
    manager: PackageManager
    profileDirectory: string
    coordinator?: ReturnType<typeof createRuntimePinCoordinator>
  }>,
): RuntimePinsAdapter {
  const referenced = () => referencedRuntimePins(input.store)
  return Object.freeze({
    async inspect(profile) {
      if (profile !== input.profile) return { error: unavailable }
      const all = input.coordinator
        ? await input.coordinator.inspectOrphans()
        : await input.manager.listRuntimePins(input.profileDirectory)
      return {
        orphans: all
          .filter((pin) => !referenced().has(pin.pinId))
          .map(
            (pin): RuntimePinDescriptor => ({
              pinId: pin.pinId,
              purpose: pin.purpose,
              packageId: pin.snapshot.packageId,
              version: pin.snapshot.version,
              snapshotId: pin.snapshot.snapshotId,
              operationId: pin.operationId,
            }),
          ),
      }
    },
    async release(profile, pinIds) {
      if (profile !== input.profile) return { error: unavailable }
      if (input.coordinator) {
        try {
          const outcomes = await input.coordinator.releaseOrphans(pinIds)
          return {
            results: outcomes.map(
              ({ pinId, released }): RuntimePinReleaseResult => ({
                pinId,
                outcome: released ? 'released' : 'skipped-no-longer-orphaned',
              }),
            ),
          }
        } catch {
          return {
            results: pinIds.map(
              (pinId): RuntimePinReleaseResult => ({
                pinId,
                outcome: 'failed',
                error: unavailable,
              }),
            ),
          }
        }
      }
      const results: RuntimePinReleaseResult[] = []
      for (const pinId of pinIds) {
        if (referenced().has(pinId)) {
          results.push({ pinId, outcome: 'skipped-no-longer-orphaned' })
          continue
        }
        try {
          const pin = (await input.manager.listRuntimePins(input.profileDirectory)).find(
            (p) => p.pinId === pinId,
          )
          if (!pin) {
            results.push({ pinId, outcome: 'released' })
            continue
          }
          await input.manager.releaseRuntimePin(input.profileDirectory, {
            pinId,
            expectedSnapshotId: pin.snapshot.snapshotId,
          })
          results.push({ pinId, outcome: 'released' })
        } catch (error) {
          if (error instanceof PackageError && error.detail.reason === 'pin-not-found')
            results.push({ pinId, outcome: 'released' })
          else
            results.push({
              pinId,
              outcome: 'failed',
              error: unavailable,
            })
        }
      }
      return { results }
    },
  })
}
