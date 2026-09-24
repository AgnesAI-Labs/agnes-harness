import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  type DeployManifest,
  type ProfileFragment,
  validateDeployManifest,
  validateProfileFragment,
} from '@agnes/protocol'
import { parse as parseYaml } from 'yaml'
import { PackageError } from './errors.js'
import type { Lockfile } from './lockfile.js'
import { hashDirectory } from './sources.js'

const MAX_CONFIG_BYTES = 1024 * 1024

export type WorkspaceVerification =
  | { ok: true; deployDir: string }
  | {
      ok: false
      code: 'E_WORKSPACE_UNTRUSTED' | 'E_LOCK_MISMATCH'
      detail: Record<string, unknown>
    }

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function portableRelative(value: string, prefix?: string): boolean {
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes(':') ||
    (prefix !== undefined && !value.startsWith(prefix))
  )
    return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function readBounded(file: string): string {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error('not a small file')
    return readFileSync(file, 'utf8')
  } catch {
    throw new PackageError('E_WORKSPACE_UNTRUSTED', 'workspace configuration is not readable', {
      source: { file },
      detail: { reason: 'unreadable' },
    })
  }
}

/** Read the protocol-owned deploy manifest without accepting path traversal hidden behind its prefixes. */
export function readDeployManifest(deployDir: string): DeployManifest {
  const file = resolve(deployDir, 'manifest.json')
  let raw: unknown
  try {
    raw = JSON.parse(readBounded(file))
  } catch (error) {
    if (error instanceof PackageError) throw error
    throw new PackageError('E_EXT_LOAD', 'workspace manifest is not valid JSON', {
      source: { file },
      detail: { reason: 'not-json' },
    })
  }
  const checked = validateDeployManifest(raw)
  if (!checked.ok)
    throw new PackageError('E_EXT_LOAD', 'workspace manifest does not validate', {
      source: { file },
      detail: { reason: 'invalid-manifest', path: checked.errors[0]?.path },
    })
  const manifest = checked.value
  const paths = [
    ...manifest.extensions.map((entry) => entry.path),
    manifest.profileFragment,
    ...manifest.presets,
    manifest.fixtures,
  ]
  if (paths.some((path) => !portableRelative(path)))
    throw new PackageError('E_EXT_LOAD', 'workspace manifest contains an unsafe relative path', {
      source: { file },
      detail: { reason: 'path-escape' },
    })
  const ids = new Set<string>()
  const extensionPaths = new Set<string>()
  for (const extension of manifest.extensions) {
    if (ids.has(extension.id) || extensionPaths.has(extension.path))
      throw new PackageError('E_EXT_LOAD', 'workspace manifest contains a duplicate extension', {
        source: { file },
        detail: { reason: 'duplicate-extension', id: extension.id, path: extension.path },
      })
    ids.add(extension.id)
    extensionPaths.add(extension.path)
  }
  return manifest
}

/** Hash the signed deploy tree, excluding only generated/vendor trees fixed by the design. */
export function hashWorkspace(deployDir: string): string {
  return hashDirectory(deployDir, { exclude: ['node_modules', '.git', 'fixtures/out'] })
}

/** Parse the manifest-selected profile fragment against protocol's current, narrow fragment schema. */
export function readProfileFragment(
  deployDir: string,
  manifest: DeployManifest,
): ProfileFragment | undefined {
  const file = resolve(deployDir, manifest.profileFragment)
  if (!portableRelative(manifest.profileFragment, 'profile/') || !isContained(resolve(deployDir), file))
    throw new PackageError('E_EXT_LOAD', 'workspace profile fragment escapes the deploy directory', {
      source: { file },
      detail: { reason: 'path-escape' },
    })
  if (!existsSync(file)) return undefined
  try {
    if (!isContained(realpathSync(deployDir), realpathSync(file)))
      throw new PackageError('E_EXT_LOAD', 'workspace profile fragment escapes through a symbolic link', {
        source: { file },
        detail: { reason: 'path-escape' },
      })
  } catch (error) {
    if (error instanceof PackageError) throw error
    throw new PackageError('E_EXT_LOAD', 'workspace profile fragment cannot be resolved', {
      source: { file },
      detail: { reason: 'unreadable' },
    })
  }
  let raw: unknown
  try {
    raw = parseYaml(readBounded(file))
  } catch (error) {
    if (error instanceof PackageError) throw error
    throw new PackageError('E_EXT_LOAD', 'workspace profile fragment is not valid YAML', {
      source: { file },
      detail: { reason: 'not-yaml' },
    })
  }
  const checked = validateProfileFragment(raw)
  if (!checked.ok)
    throw new PackageError('E_PROFILE_FRAGMENT_KEY', 'workspace profile fragment does not validate', {
      source: { file, layer: 'workspace' },
      detail: { reason: 'invalid-fragment', path: checked.errors[0]?.path },
    })
  return checked.value
}

/** Verify the lock's hash pin before any workspace file is allowed to influence profile resolution. */
export function verifyWorkspace(lock: Lockfile, profileDir: string): WorkspaceVerification {
  const signed = lock.workspace
  if (!signed)
    return {
      ok: false,
      code: 'E_WORKSPACE_UNTRUSTED',
      detail: { reason: 'not-signed-off' },
    }
  if (!portableRelative(signed.path))
    return {
      ok: false,
      code: 'E_LOCK_MISMATCH',
      detail: { reason: 'invalid-workspace-path', path: signed.path },
    }
  const root = resolve(profileDir)
  const deployDir = resolve(root, signed.path)
  if (!isContained(root, deployDir))
    return {
      ok: false,
      code: 'E_LOCK_MISMATCH',
      detail: { reason: 'workspace-path-escape', path: signed.path },
    }
  if (!existsSync(deployDir))
    return {
      ok: false,
      code: 'E_LOCK_MISMATCH',
      detail: { reason: 'deploy-directory-missing', path: signed.path },
    }
  let actual: string
  let manifest: DeployManifest
  try {
    actual = hashWorkspace(deployDir)
    manifest = readDeployManifest(deployDir)
  } catch (error) {
    return {
      ok: false,
      code: 'E_LOCK_MISMATCH',
      detail: {
        reason: 'workspace-unreadable',
        ...(error instanceof PackageError ? { cause: error.legacyCode } : {}),
      },
    }
  }
  if (actual !== signed.hash)
    return {
      ok: false,
      code: 'E_LOCK_MISMATCH',
      detail: { reason: 'workspace-hash-changed', expected: signed.hash, actual },
    }
  if (manifest.id !== signed.manifestId)
    return {
      ok: false,
      code: 'E_LOCK_MISMATCH',
      detail: {
        reason: 'workspace-manifest-changed',
        expected: signed.manifestId,
        actual: manifest.id,
      },
    }
  return { ok: true, deployDir }
}
