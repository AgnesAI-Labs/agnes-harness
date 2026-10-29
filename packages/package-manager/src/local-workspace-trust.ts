import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { PackageError } from './errors.js'
import { canonical, own, readStaticJson } from './integrity.js'
import { discoverLocalPlugins, type LocalPluginRoots } from './local-source.js'
import type { Lockfile } from './lockfile.js'
import type { WorkspaceDeployment } from './workspace-deployments.js'

const trustFile = (profileDir: string) => join(profileDir, 'workspace-code-trust.json')
export const localWorkspaceRoot = (roots: LocalPluginRoots) =>
  nativeRealpathSync(dirname(dirname(roots.workspace)))
export function workspaceHooksDigest(workspace: string): string | undefined {
  const file = join(workspace, AGH_DIR, 'hooks.json')
  if (!existsSync(file)) return undefined
  if (
    nativeRealpathSync(file) !== file ||
    lstatSync(file).isSymbolicLink() ||
    !lstatSync(file).isFile() ||
    lstatSync(file).size > 256 * 1024
  )
    throw new TypeError('workspace hooks must be a bounded regular file')
  return `sha256-${createHash('sha256').update(readFileSync(file)).digest('hex')}`
}
type Decision = { packages: Record<string, string>; hooksDigest?: string }
function decisions(profileDir: string): Record<string, Decision> {
  try {
    return readStaticJson(trustFile(profileDir)) as Record<string, Decision>
  } catch {
    return {}
  }
}
function packageDigests(lock: Lockfile, roots: LocalPluginRoots): Record<string, string> {
  const present = new Set(discoverLocalPlugins(roots).map((candidate) => candidate.source.ref))
  return Object.fromEntries(
    Object.entries(lock.packages)
      .filter(
        ([, entry]) =>
          entry.source.type === 'local' &&
          entry.source.ref.startsWith('local:workspace/') &&
          present.has(entry.source.ref),
      )
      .map(([id, entry]) => [id, entry.integrity]),
  )
}
export function localWorkspaceTrustHash(roots: LocalPluginRoots, lock: Lockfile): string {
  const workspace = localWorkspaceRoot(roots),
    hooksDigest = workspaceHooksDigest(workspace)
  return `sha256-${createHash('sha256')
    .update(
      canonical({
        workspace,
        packages: packageDigests(lock, roots),
        ...(hooksDigest ? { hooksDigest } : {}),
      }),
    )
    .digest('hex')}`
}

/** Writes only to the user's profile, while the PackageManager owns its write lock. */
export function confirmLocalWorkspace(
  profileDir: string,
  roots: LocalPluginRoots,
  lock: Lockfile,
  expectedHash: string,
): string {
  const workspace = localWorkspaceRoot(roots),
    hooksDigest = workspaceHooksDigest(workspace)
  const decision = { packages: packageDigests(lock, roots), ...(hooksDigest ? { hooksDigest } : {}) }
  const hash = `sha256-${createHash('sha256')
    .update(canonical({ workspace, ...decision }))
    .digest('hex')}`
  if (hash !== expectedHash)
    throw new PackageError('E_LOCK_MISMATCH', 'workspace code changed since confirmation', {
      code: 'E_PACKAGE_PREVIEW_STALE',
    })
  const file = trustFile(profileDir),
    pending = `${file}.${randomUUID()}.tmp`
  writeFileSync(pending, JSON.stringify({ ...decisions(profileDir), [workspace]: decision }), { mode: 0o600 })
  renameSync(pending, file)
  return hash
}
/** A snapshot digest, not the presence of a repository file, authorizes automatic hooks. */
export function isWorkspaceHooksTrusted(profileDir: string, workspace: string, digest: string): boolean {
  try {
    return decisions(profileDir)[nativeRealpathSync(workspace)]?.hooksDigest === digest
  } catch {
    return false
  }
}
export function localWorkspaceDeployment(
  profileDir: string,
  roots: LocalPluginRoots,
  lock: Lockfile,
): WorkspaceDeployment[] {
  if (lock.policySnapshot.workspacePackages === 'deny') return []
  try {
    const workspace = localWorkspaceRoot(roots)
    const packages = packageDigests(lock, roots)
    const hooksDigest = workspaceHooksDigest(workspace)
    const pluginCount = Object.keys(packages).length
    if (!pluginCount && !hooksDigest) return []
    const signed = decisions(profileDir)[workspace]
    const trusted =
      signed &&
      signed.hooksDigest === hooksDigest &&
      Object.entries(packages).every(
        ([id, digest]) => signed.packages?.[id] === digest && own(lock.packages, id)?.state.trusted !== null,
      ) &&
      Object.keys(signed.packages ?? {}).length === pluginCount
    return [
      {
        deployDir: workspace,
        path: workspace,
        manifestId: 'local-workspace',
        trustHash: localWorkspaceTrustHash(roots, lock),
        pluginCount,
        ...(hooksDigest ? { hasHooks: true, hooksDigest } : {}),
        state: trusted ? 'trusted' : signed ? 'changed' : 'untrusted',
      },
    ]
  } catch {
    return []
  }
}
