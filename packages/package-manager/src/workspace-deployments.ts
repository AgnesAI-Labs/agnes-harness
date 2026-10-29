import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import type { Lockfile } from './lockfile.js'
import { hashWorkspace, readDeployManifest, supportsHarness } from './workspace.js'

/** A profile directory that workspace trust accepts, and whether the lock already vouches for it. */
export type WorkspaceDeployment = {
  /** Absolute path, exactly what `packages.trustWorkspace` takes as `deployDir`. */
  deployDir: string
  /** The same directory relative to the profile, as the lock records it. */
  path: string
  manifestId: string
  trustHash?: string
  pluginCount?: number
  hasHooks?: boolean
  /** Digest of the hooks.json bytes `trustHash` commits to. */
  hooksDigest?: string
  /** `changed`: trusted once, but its files no longer match the hash that was signed. */
  state: 'untrusted' | 'trusted' | 'changed'
}

const MAX_SIBLINGS = 64
const MAX_DEPLOYMENTS = 64

/**
 * The deploy directories a person could trust for this profile: real directories one or two levels
 * below it that hold a valid deploy manifest supporting this harness. Trust itself re-reads and re-checks whichever
 * one is chosen, so this is an offer, never an admission. A profile whose policy refuses workspace
 * packages offers none.
 */
export function listWorkspaceDeployments(
  profileDir: string,
  readLock: () => Pick<Lockfile, 'workspace' | 'policySnapshot'>,
): WorkspaceDeployment[] {
  let lock: Pick<Lockfile, 'workspace' | 'policySnapshot'>
  try {
    lock = readLock()
  } catch {
    // A lock that cannot be read cannot be written either, so trust would fail for every directory.
    return []
  }
  if (lock.policySnapshot.workspacePackages === 'deny') return []
  const directories = (parent: string): string[] => {
    try {
      return readdirSync(parent, { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules',
        )
        .map((entry) => entry.name)
        .sort()
        .slice(0, MAX_SIBLINGS)
    } catch {
      return []
    }
  }
  let root: string
  try {
    root = nativeRealpathSync(profileDir)
  } catch {
    return []
  }
  // `deploy/<id>` is the usual layout; a deploy directory placed directly in the profile is as valid.
  const paths = directories(root).flatMap((name) => [
    name,
    ...directories(join(root, name)).map((child) => `${name}/${child}`),
  ])
  const deployments: WorkspaceDeployment[] = []
  for (const path of paths) {
    const deployDir = join(root, path)
    if (deployments.length >= MAX_DEPLOYMENTS || !existsSync(join(deployDir, 'manifest.json'))) continue
    try {
      // Trust refuses a symlinked directory and anything that resolves outside the profile.
      if (lstatSync(deployDir).isSymbolicLink() || nativeRealpathSync(deployDir) !== deployDir) continue
      const manifest = readDeployManifest(deployDir)
      if (!supportsHarness(manifest)) continue
      const signed = lock.workspace?.path === path ? lock.workspace : undefined
      // Trust binds to this hash, so a confirmation cannot cover files that changed after the offer.
      const trustHash = hashWorkspace(deployDir)
      deployments.push({
        deployDir,
        path,
        manifestId: manifest.id,
        trustHash,
        state: !signed ? 'untrusted' : trustHash === signed.hash ? 'trusted' : 'changed',
      })
    } catch {
      // Not a deploy directory, or one trust would refuse: nothing to offer.
    }
  }
  return deployments
}
