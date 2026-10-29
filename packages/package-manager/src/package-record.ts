import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionManifest } from '@agnes/extension-api'
import { PackageError } from './errors.js'
import type { LockEntry } from './lockfile.js'
import type { FetchedSource, PackageSource } from './sources.js'

type PackageJson = {
  name: string
  version: string
  license: string
  dependencies: Record<string, string>
}

const MAX_JSON_BYTES = 1024 * 1024

export function readPackageJson(dir: string): PackageJson {
  const file = join(dir, 'package.json')
  let value: unknown
  try {
    if (statSync(file).size > MAX_JSON_BYTES) throw new Error('too large')
    const text = readFileSync(file, 'utf8')
    if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error('too large')
    value = JSON.parse(text)
  } catch {
    throw new PackageError('E_DEP_MISSING', 'installed package has no valid package.json', {
      source: { file },
      detail: { reason: 'package-json' },
    })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new PackageError('E_DEP_MISSING', 'installed package has no valid package.json', {
      source: { file },
      detail: { reason: 'package-json' },
    })
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || typeof record.version !== 'string')
    throw new PackageError('E_DEP_MISSING', 'installed package identity is incomplete', {
      source: { file },
      detail: { reason: 'package-json' },
    })
  const dependencies: Record<string, string> = {}
  if (record.dependencies !== undefined) {
    if (
      record.dependencies === null ||
      typeof record.dependencies !== 'object' ||
      Array.isArray(record.dependencies)
    )
      throw new PackageError('E_DEP_MISSING', 'installed package dependencies are invalid', {
        source: { file },
        detail: { reason: 'package-json' },
      })
    for (const [id, version] of Object.entries(record.dependencies)) {
      if (typeof version !== 'string')
        throw new PackageError('E_DEP_MISSING', 'installed package dependencies are invalid', {
          source: { file },
          detail: { reason: 'package-json', id },
        })
      dependencies[id] = version
    }
  }
  return {
    name: record.name,
    version: record.version,
    license: typeof record.license === 'string' ? record.license : 'UNLICENSED',
    dependencies,
  }
}

export function entryFrom(
  source: PackageSource,
  fetched: FetchedSource,
  pkg: PackageJson,
  manifest: ExtensionManifest | undefined,
  installed: string,
  previous: LockEntry | undefined,
): LockEntry {
  if (manifest && (manifest.id !== pkg.name || manifest.version !== pkg.version))
    throw new PackageError('E_EXT_LOAD', 'package and extension manifest identities differ', {
      detail: {
        reason: 'identity-mismatch',
        packageId: pkg.name,
        packageVersion: pkg.version,
        manifestId: manifest.id,
        manifestVersion: manifest.version,
      },
    })
  const common = {
    version: fetched.version,
    ...(fetched.provenance
      ? { provenance: { ...fetched.provenance, installedAt: installed, trustDecision: 'pending' as const } }
      : {}),
    integrity: fetched.integrity,
    trust: 'trusted' as const,
    license: pkg.license,
    ...(manifest ? { apiRange: manifest.apiRange, capabilities: manifest.capabilities } : {}),
    ...(manifest?.provides ? { provides: [...manifest.provides] } : {}),
    state: { installed, trusted: null, enabled: false },
    dependencies: { ...fetched.dependencies },
    previous: previous ? { version: previous.version, integrity: previous.integrity } : null,
  }
  if (source.type === 'npm') {
    if (!fetched.releasedAt)
      throw new PackageError('E_DEP_MISSING', 'npm package has no release timestamp', {
        detail: { reason: 'release-time', id: pkg.name },
      })
    return {
      ...common,
      source: { type: 'npm', ref: source.ref },
      releasedAt: fetched.releasedAt,
    }
  }
  if (source.type === 'market')
    throw new PackageError('E_DEP_MISSING', 'market sources are v0.x', {
      detail: { reason: 'market v0.x' },
    })
  return { ...common, source: { type: source.type, ref: source.ref } }
}

/** Copy the data bound by capabilityHash, independently from execution seam declarations. */
export function applyReviewedContract(
  entry: LockEntry,
  preview: import('@agnes/protocol').PackagePreview,
): void {
  for (const key of ['agents', 'application'] as const) {
    if (preview[key] !== undefined) Object.assign(entry, { [key]: structuredClone(preview[key]) })
    else delete entry[key]
  }
  if (preview.provides) entry.declaredProvides = [...preview.provides]
  else delete entry.declaredProvides
}
