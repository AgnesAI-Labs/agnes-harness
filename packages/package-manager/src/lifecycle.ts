import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { type PackageBlocker, validatePackageAdminData } from '@agnes/protocol'
import { parse as parseYaml } from 'yaml'
import { surfaceReferences } from './deployment-refs.js'
import { PackageError } from './errors.js'
import { capabilityHash, type InstalledPackage, readInventory } from './inventory.js'
import type { LockEntry, Lockfile } from './lockfile.js'
import { readManifestIn } from './manifest.js'
import type { PackageStore } from './store.js'
import { runTrustGate } from './trust-gate.js'
import { verifyWorkspace } from './workspace.js'

export type TrustDecision = Readonly<{ integrity: string; capabilityHash: string }>
export type PackageLifecycleActivation = Readonly<{
  expectedInstalledIntegrity: string
  trust: TrustDecision
}>
/** The owner must hold generation/deployment admission until the operation returns. */
export type PackageReferences = (
  profile: string,
  id: string,
  operation: 'disable' | 'update' | 'rollback' | 'remove',
  extensions?: readonly string[],
) => Promise<readonly PackageBlocker[]>
export function previousSnapshot(entry: LockEntry): NonNullable<LockEntry['previous']> {
  const { previous: _previous, ...snapshot } = entry
  return structuredClone(snapshot)
}
/** Runtime pins are PackageManager-owned references and cannot be waived by an external adapter. */
export function assertNoRuntimePins(blockers: readonly PackageBlocker[]): void {
  if (blockers.length)
    throw new PackageError('E_API_RANGE', 'package has pinned runtime snapshots', {
      detail: { blockers: structuredClone(blockers) },
    })
}
export function installed(
  s: PackageStore,
  lock: Lockfile,
  id: string,
  allowBlocked = false,
  ceiling?: readonly string[],
): InstalledPackage {
  const row = readInventory(lock, { ...s, ...(ceiling ? { ceiling } : {}) }).packages.find((p) => p.id === id)
  if (!row) throw new PackageError('E_DEP_MISSING', 'package is not installed')
  if (row.blockers.length && !allowBlocked)
    throw new PackageError('E_API_RANGE', 'package inventory is blocked', {
      detail: { blockers: row.blockers },
    })
  return row
}
export function confirmTrust(
  s: PackageStore,
  lock: Lockfile,
  id: string,
  decision: TrustDecision | undefined,
  minimumReleaseAgeMin: number,
  ceiling: readonly string[],
): LockEntry {
  const row = installed(s, lock, id, false, ceiling)
  return trustPackageEntry(s, id, row.entry, row.directory, decision, minimumReleaseAgeMin, ceiling)
}
/** Caller has already verified the candidate directory and holds the unique Profile lock. */
export function trustPackageEntry(
  s: PackageStore,
  id: string,
  candidate: LockEntry,
  directory: string | null,
  decision: TrustDecision | undefined,
  minimumReleaseAgeMin: number,
  ceiling: readonly string[],
): LockEntry {
  if (
    !decision ||
    !validatePackageAdminData('PackageTrustDecision', { ...decision, decidedAt: s.now() }).ok ||
    decision.integrity !== candidate.integrity ||
    decision.capabilityHash !== capabilityHash(candidate)
  )
    throw new PackageError('E_WORKSPACE_UNTRUSTED', 'trust decision differs from the package snapshot')
  const trusted = s.now(),
    entry = structuredClone(candidate)
  runTrustGate({ id, entry, ceiling, now: trusted, minimumReleaseAgeMin })
  for (const c of entry.contributions ?? [])
    if (c.kind === 'extension') {
      if (!directory) throw new PackageError('E_EXT_LOAD', 'package directory missing')
      const manifest = readManifestIn(dirname(resolve(directory, c.path)))
      if (!manifest) throw new PackageError('E_EXT_LOAD', 'extension manifest missing')
      runTrustGate({ id, entry, manifest, ceiling, now: trusted, minimumReleaseAgeMin })
    }
  entry.trustDecision = { ...decision, decidedAt: trusted }
  entry.state.trusted = trusted
  return entry
}
function named(value: unknown, id: string, seen = new Set<object>()): boolean {
  if (value === id) return true
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  if (seen.size >= 10000) throw new PackageError('E_EXT_LOAD', 'profile reference document exceeds limits')
  seen.add(value)
  return Object.entries(value).some(([key, child]) => key === id || named(child, id, seen))
}
export async function assertNoReferences(
  s: PackageStore,
  lock: Lockfile,
  id: string,
  operation: 'disable' | 'update' | 'rollback' | 'remove',
  authority?: PackageReferences,
): Promise<void> {
  const blockers: PackageBlocker[] = []
  const dependents = Object.entries(lock.packages)
    .filter(([other, e]) => other !== id && Object.hasOwn(e.dependencies, id))
    .map(([other]) => other)
    .sort()
  if (dependents.length) blockers.push({ code: 'dependency', references: dependents })
  const profileRefs = [
    ...Object.entries(lock.seams)
      .filter(([, pkg]) => pkg === id)
      .map(([name]) => `seam:${name}`),
    ...(lock.provider.package === id ? ['provider'] : []),
    ...(lock.provider.adapters.includes(id) ? ['provider.adapter'] : []),
  ]
  const file = join(s.profileDir, 'profile.yaml')
  if (existsSync(file)) {
    if (statSync(file).size > 1048576)
      throw new PackageError('E_EXT_LOAD', 'profile reference document exceeds limits')
    let document: unknown
    try {
      document = parseYaml(readFileSync(file, 'utf8'))
    } catch {
      throw new PackageError('E_EXT_LOAD', 'profile references are invalid')
    }
    if (named(document, id)) profileRefs.push('profile.yaml')
  }
  if (profileRefs.length) blockers.push({ code: 'profile', references: profileRefs })
  const extensions = (lock.packages[id]?.contributions ?? []).flatMap((c) =>
    c.kind === 'extension' ? [c.id] : [],
  )
  if (lock.workspace) {
    const workspace = verifyWorkspace(lock, s.profileDir)
    if (!workspace.ok)
      throw new PackageError('E_LOCK_MISMATCH', 'deployment workspace differs from trusted snapshot')
    const references = surfaceReferences(workspace.deployDir, id, extensions)
    if (references.length) blockers.push({ code: 'deployment', references })
  }
  if (!authority) blockers.push({ code: 'generation', references: ['reference-authority-unavailable'] })
  else
    for (const value of await authority(s.profile, id, operation, Object.freeze(extensions))) {
      const checked = validatePackageAdminData('PackageBlocker', value)
      if (!checked.ok) throw new PackageError('E_EXT_LOAD', 'reference authority returned invalid blockers')
      blockers.push(checked.value as PackageBlocker)
    }
  if (blockers.length)
    throw new PackageError('E_API_RANGE', 'package has active references', { detail: { blockers } })
}
