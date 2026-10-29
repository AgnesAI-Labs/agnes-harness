import { satisfiesApiRange } from '@agnes/extension-api'
import { PackageError } from './errors.js'
import { exampleParentBlockers } from './example-parent.js'
import { inspectStaged } from './inspect.js'
import { own } from './integrity.js'
import { readInventory } from './inventory.js'
import {
  assertNoReferences,
  installed,
  type PackageReferences,
  previousSnapshot,
  trustPackageEntry,
} from './lifecycle.js'
import type { LockEntry, Lockfile } from './lockfile.js'
import type { PackageManager } from './manager.js'
import { applyReviewedContract, entryFrom, readPackageJson } from './package-record.js'
import { readPluginCapabilityPolicy } from './plugin-capabilities.js'
import { checkCancelled, type OperationOptions, progress } from './ports.js'
import { type FetchedSource, hashDirectory, type PackageSource } from './sources.js'
import { clearStage } from './staging.js'
import { commitPackages, commitPackagesAdmitted, type PackageChange, type PackageStore } from './store.js'

type Options = Parameters<PackageManager['update']>[3]
/** Called under the profile lock and the daemon's publication admission barrier. */
export async function updatePackages(deps: {
  profileDir: string
  id: string
  source: PackageSource
  op: Options
  lock: Lockfile
  store: PackageStore
  ceiling: readonly string[]
  minimumReleaseAgeMin: number
  references?: PackageReferences
  acquire(
    source: PackageSource,
    stage: string,
    op: OperationOptions,
    profileDir: string,
  ): Promise<FetchedSource>
  stageFor(profileDir: string): string
}): Promise<LockEntry> {
  const { profileDir, id, op, lock, store } = deps
  const requests = [
    {
      ...op,
      ...(op.activation ? { activation: structuredClone(op.activation) } : {}),
      id,
      source: { ...deps.source },
    },
    ...structuredClone(op.dependents ?? []),
  ]
  if (
    requests.length > 33 ||
    new Set(requests.map((r) => r.id)).size !== requests.length ||
    (op.dependents?.length && !op.activation)
  )
    throw new PackageError('E_EXT_LOAD', 'group update requires unique reviewed packages and activation')
  const changes: (PackageChange & { next: LockEntry; stage: string })[] = []
  const stages: string[] = []
  try {
    for (const request of requests) {
      if (request.id !== id && !Object.hasOwn(own(lock.packages, request.id)?.dependencies ?? {}, id))
        throw new PackageError('E_EXT_LOAD', 'group member is not an installed dependent')
      const current = installed(store, lock, request.id, true).entry
      const baseline =
        request.id === id ? op.expectedInstalledIntegrity : request.activation?.expectedInstalledIntegrity
      if (
        (baseline !== undefined && current.integrity !== baseline) ||
        (request.activation && current.integrity !== request.activation.expectedInstalledIntegrity)
      )
        throw new PackageError('E_LOCK_MISMATCH', 'installed package changed since candidate review', {
          code: 'E_PACKAGE_PREVIEW_STALE',
        })
      const source = { ...request.source },
        stage = deps.stageFor(profileDir)
      stages.push(stage)
      const acquired = await deps.acquire(source, stage, op, profileDir)
      const fetched = op.installer
        ? {
            ...acquired,
            provenance: {
              ...acquired.provenance!,
              installer: op.installer,
              ...(op.authoring ? { authoring: op.authoring } : {}),
            },
          }
        : acquired
      if (fetched.integrity !== request.expectedIntegrity)
        throw new PackageError('E_LOCK_MISMATCH', 'package preview is stale', {
          code: 'E_PACKAGE_PREVIEW_STALE',
        })
      const { preview, treeIntegrity } = await inspectStaged({
        dir: stage,
        source: fetched.source ?? source,
        fetched,
        previous: current,
        ceiling: deps.ceiling,
        capabilityPolicy: readPluginCapabilityPolicy(profileDir),
        ...(op.signal ? { signal: op.signal } : {}),
      })
      if (preview.id !== request.id)
        throw new PackageError('E_LOCK_MISMATCH', 'update package identity differs')
      if (preview.blockers.length)
        throw new PackageError('E_API_RANGE', 'package update is blocked', {
          detail: { blockers: preview.blockers },
        })
      const entry = entryFrom(
        fetched.source ?? source,
        fetched,
        readPackageJson(stage),
        undefined,
        store.now(),
        current,
      )
      applyReviewedContract(entry, preview)
      entry.contributions = preview.contributions
      if (preview.metadata) entry.metadata = preview.metadata
      if (preview.declaredCapabilities !== undefined)
        entry.declaredCapabilities = preview.declaredCapabilities
      entry.treeIntegrity = treeIntegrity
      entry.surfaces = preview.contributions.flatMap((c) => (c.kind === 'surface' ? [c.descriptor] : []))
      entry.previous = previousSnapshot(current)
      if (request.activation) {
        if (current.state.trusted === null)
          throw new PackageError('E_WORKSPACE_UNTRUSTED', 'untrusted package cannot activate during update')
        const trusted = trustPackageEntry(
          store,
          request.id,
          entry,
          stage,
          request.activation.trust,
          deps.minimumReleaseAgeMin,
          [...deps.ceiling],
        )
        trusted.state.enabled = request.id === id ? true : current.state.enabled
        Object.assign(entry, trusted)
      }
      changes.push({ id: request.id, next: entry, stage, operation: 'update' })
    }
    const candidates = Object.fromEntries(changes.map((c) => [c.id, c.next]))
    const inventory = readInventory(lock, store).packages.map((row) => {
      const entry = own(candidates, row.id)
      return entry
        ? { ...row, entry, enabled: entry.state.enabled, trusted: entry.state.trusted !== null, blockers: [] }
        : row
    })
    for (const change of changes) {
      const blockers = change.next.state.enabled ? exampleParentBlockers(change.next, inventory) : []
      if (blockers.length)
        throw new PackageError('E_API_RANGE', 'Example requires an enabled, trusted parent package.', {
          detail: { blockers },
        })
      await assertNoReferences(store, lock, change.id, 'update', deps.references, change.next, candidates)
    }
    progress(op, 'committing')
    // All awaited observers precede the final tree verification and the atomic lock publication.
    for (const change of changes)
      if (
        hashDirectory(change.stage, { exclude: [], ...(op.signal ? { signal: op.signal } : {}) }) !==
        change.next.treeIntegrity
      )
        throw new PackageError('E_LOCK_MISMATCH', 'staging changed before commit')
    checkCancelled(op.signal)
    if (store.admission) await commitPackagesAdmitted(store, lock, changes)
    else commitPackages(store, lock, changes)
    try {
      op.onProgress?.(Object.freeze({ phase: 'completed', percent: 100 }))
    } catch {}
    return changes[0]!.next
  } finally {
    for (const stage of stages) clearStage(stage)
  }
}

/** Preview only: the commit repeats this against verified staged candidates under the lock. */
export function dependentUpdateBlockers(
  lock: Lockfile,
  id: string,
  version: string,
): import('@agnes/protocol').PackageBlocker[] {
  return Object.entries(lock.packages).flatMap(([other, entry]) =>
    other !== id &&
    Object.hasOwn(entry.dependencies, id) &&
    !satisfiesApiRange(entry.dependencies[id]!, version)
      ? [{ code: 'dependency' as const, references: [other] }]
      : [],
  )
}
