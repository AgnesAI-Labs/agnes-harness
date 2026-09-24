import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ProfileFragment } from '@agnes/protocol'
import { PackageError } from './errors.js'
import { capabilityHash } from './integrity.js'
import type { LockState, PolicySnapshotInput } from './inventory-types.js'
import { type LockEntry, type Lockfile, readLock, withLock, writeLock } from './lockfile.js'
import { hashDirectory, packageDir } from './sources.js'
import { readDeployManifest, readProfileFragment, verifyWorkspace } from './workspace.js'

export type LockAudit = {
  kind: 'workspace.rejected' | 'workspace.verified'
  detail: Record<string, unknown>
}

/**
 * The offline integrity check available at boot. Registry packages retain the registry tarball
 * digest in the lock, so without fetching the archive again their installed identity is pinned by
 * package name and exact version. Directory-backed packages retain a digest of the installed tree
 * itself and can therefore be re-hashed locally. Builtins are part of the signed/released host and
 * workspace entries are covered by verifyWorkspace's whole-deployment digest.
 */
export function defaultVerifyIntegrity(
  dataDir: string,
  profile: string,
): (id: string, entry: LockEntry) => void {
  return (id, entry) => {
    if (entry.trust === 'builtin' || entry.source.type === 'workspace') return
    const dir = packageDir(dataDir, profile, id)
    try {
      if (!existsSync(dir)) throw new Error('package directory missing')
      if (entry.treeIntegrity !== undefined && hashDirectory(dir, { exclude: [] }) !== entry.treeIntegrity)
        throw new Error('package tree changed')
      if (entry.source.type === 'npm' || entry.source.type === 'market') {
        const value: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        if (
          value === null ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          (value as { name?: unknown }).name !== id ||
          (value as { version?: unknown }).version !== entry.version
        )
          throw new Error('package identity changed')
        return
      }
      if (hashDirectory(dir) !== entry.integrity) throw new Error('package tree changed')
    } catch {
      throw new PackageError('E_LOCK_MISMATCH', `${id} installed package differs from agnes-lock.json`, {
        detail: { id, reason: 'integrity' },
      })
    }
  }
}

/** Verify every lock entry before any package module is evaluated. */
export function verifyLockIntegrity(lock: Lockfile, opts: { dataDir: string; profile: string }): void {
  const verify = defaultVerifyIntegrity(opts.dataDir, opts.profile)
  for (const [id, entry] of Object.entries(lock.packages)) verify(id, entry)
}

/**
 * The lockfile's view of the world, projected into the `ProfileInputs.lock` shape resolveProfile
 * consumes. `enabled` is the lock's own verdict -- the manifest's per-package `enabled` can only
 * narrow it further down in finalize.
 *
 * The `verifyIntegrity` hook is injected because the default check (package directory version and
 * hash comparison) belongs to the source layer, which does not exist in this build. Workspace
 * inputs have their own whole-tree hash pin and are projected only after it verifies.
 */
export function lockState(
  lock: Lockfile,
  opts: { profileDir: string; verifyIntegrity?: (id: string, entry: LockEntry) => void },
): { lock: LockState; audit: LockAudit[]; workspaceOverlay?: ProfileFragment } {
  const packages: LockState['packages'] = {}
  for (const [id, e] of Object.entries(lock.packages)) {
    opts.verifyIntegrity?.(id, e)
    if (
      e.contributions !== undefined &&
      e.state.trusted !== null &&
      (e.trustDecision?.integrity !== e.integrity || e.trustDecision.capabilityHash !== capabilityHash(e))
    )
      throw new PackageError('E_WORKSPACE_UNTRUSTED', 'package trust snapshot differs from lock', {
        detail: { id },
      })
    packages[id] = {
      version: e.version,
      integrity: e.integrity,
      trust: e.trust,
      enabled: e.state.enabled && e.state.trusted !== null,
      ...(e.provides ? { provides: [...e.provides] } : {}),
      ...(e.capabilities !== undefined ? { capabilities: e.capabilities } : {}),
      ...(e.releasedAt ? { releasedAt: e.releasedAt } : {}),
    }
  }
  if (lock.workspace === undefined) return { lock: { packages }, audit: [] }

  const verified = verifyWorkspace(lock, opts.profileDir)
  if (!verified.ok)
    throw new PackageError('E_LOCK_MISMATCH', 'workspace no longer matches agnes-lock.json', {
      source: { file: 'agnes-lock.json' },
      detail: verified.detail,
    })

  let workspaceOverlay: ProfileFragment | undefined
  try {
    workspaceOverlay = readProfileFragment(verified.deployDir, readDeployManifest(verified.deployDir))
  } catch {
    throw new PackageError('E_LOCK_MISMATCH', 'verified workspace configuration changed while loading', {
      source: { file: 'agnes-lock.json' },
      detail: { reason: 'workspace-read-changed' },
    })
  }
  const rechecked = verifyWorkspace(lock, opts.profileDir)
  if (!rechecked.ok)
    throw new PackageError('E_LOCK_MISMATCH', 'workspace changed while loading its profile fragment', {
      source: { file: 'agnes-lock.json' },
      detail: rechecked.detail,
    })

  const workspace = {
    path: lock.workspace.path,
    hash: lock.workspace.hash,
    manifestId: lock.workspace.manifestId,
  }
  return {
    lock: { packages, workspace },
    audit: [
      {
        kind: 'workspace.verified',
        detail: { manifestId: workspace.manifestId, hash: workspace.hash },
      },
    ],
    ...(workspaceOverlay === undefined ? {} : { workspaceOverlay }),
  }
}

/**
 * The boot-time writeback: once a profile resolved, the policy it resolved with, the hash that
 * attests it, its seam assignment and its provider choice are stamped into the lockfile, so the
 * three places that must agree (profile inputs, resolved profile, lock) are one write apart.
 */
export async function snapshotPolicy(
  profileDir: string,
  profile: PolicySnapshotInput,
  agnesVersion: string,
): Promise<void> {
  await withLock(profileDir, async () => {
    const lock = readLock(profileDir, { profile: basename(profileDir), agnesVersion })
    lock.policySnapshot = {
      capabilityCeiling: [...profile.policy.capabilityCeiling],
      workspacePackages: profile.policy.workspacePackages,
    }
    lock.resolvedProfileHash = profile.hash
    lock.seams = { ...profile.seams }
    lock.provider = { package: profile.provider.package, adapters: [...profile.provider.adapters] }
    writeLock(profileDir, lock)
  })
}
