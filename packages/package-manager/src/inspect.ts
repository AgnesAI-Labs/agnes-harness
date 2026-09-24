import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { API_VERSION, checkManifest, satisfiesApiRange } from '@agnes/extension-api'
import {
  type PackageCapabilityDiff,
  type PackageContributionSummary,
  type PackagePreview,
  validatePackageAdminData,
  validateSurfacePackageMetadata,
} from '@agnes/protocol'
import { normalizeClientContribution, resolveClientAssets } from './client-assets.js'
import { containedEntry } from './entry-path.js'
import { PackageError } from './errors.js'
import { canonical, capabilityHash, freezeData, readStaticJson, snapshotHash } from './integrity.js'
import type { LockEntry } from './lockfile.js'
import { isReservedPluginRowIdError, parseAgnesPluginEntries } from './plugin-manifest.js'
import { checkCancelled } from './ports.js'
import { resolveSkins } from './skin-assets.js'
import { type FetchedSource, hashDirectory, type PackageSource } from './sources.js'

function invalid(reason: string): never {
  throw new PackageError('E_EXT_LOAD', 'package static metadata is invalid', { detail: { reason } })
}
function contribution(value: unknown): PackageContributionSummary {
  const checked = validatePackageAdminData('PackageContributionSummary', value)
  if (!checked.ok) invalid('contribution')
  return checked.value as PackageContributionSummary
}
function array(value: unknown): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 128) invalid('metadata-list')
  return value
}
function capabilitySet(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(capabilitySet).sort((a, b) => compare(canonical(a), canonical(b)))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, capabilitySet(child)]))
  return value
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
function atoms(contributions: PackageContributionSummary[]): Set<string> {
  const result = new Set<string>()
  for (const c of contributions)
    if (c.kind === 'extension')
      for (const [key, value] of Object.entries(c.capabilities))
        result.add(`${key}:${snapshotHash([c.id, capabilitySet(value)])}`)
  return result
}
function difference(next: Set<string>, old: Set<string>): string[] {
  return [...next].filter((key) => !old.has(key)).sort()
}
function diff(
  next: PackageContributionSummary[],
  previous: LockEntry | undefined,
  id: string,
  dependencies: Record<string, string>,
): PackageCapabilityDiff {
  const old =
    previous?.contributions ??
    (previous?.capabilities
      ? [
          {
            kind: 'extension' as const,
            id,
            path: './agnes.extension.json',
            apiRange: previous.apiRange ?? '*',
            capabilities: previous.capabilities,
          },
        ]
      : [])
  const nextAtoms = atoms(next),
    oldAtoms = atoms(old)
  const oldServices = new Set(
    old.flatMap((c) => (c.kind === 'surface' ? c.descriptor.requires.services.map(canonical) : [])),
  )
  const grants = next
    .flatMap((c) => (c.kind === 'surface' ? c.descriptor.requires.services : []))
    .filter((g) => !oldServices.has(canonical(g)))
  return {
    added: difference(nextAtoms, oldAtoms),
    removed: difference(oldAtoms, nextAtoms),
    runtimeSupportRemoved: old
      .flatMap((c) => {
        if (c.kind !== 'extension') return []
        const updated = next.find((n) => n.kind === 'extension' && n.id === c.id)
        const supports = updated?.kind === 'extension' ? (updated.runtimeSupports ?? ['in-process']) : []
        return (c.runtimeSupports ?? ['in-process'])
          .filter((s) => !supports.includes(s))
          .map((s) => `${snapshotHash(c.id)}:${s}`)
      })
      .sort(),
    dependenciesAdded: Object.keys(dependencies)
      .filter((key) => previous?.dependencies[key] !== dependencies[key])
      .sort(),
    serviceGrantsAdded: [...new Map(grants.map((g) => [canonical(g), g])).values()].sort((a, b) =>
      compare(canonical(a), canonical(b)),
    ),
  }
}

/** Reads only data files from an already acquired staging tree. No module loader is involved. */
export function inspectStaged(input: {
  dir: string
  source: PackageSource
  fetched: FetchedSource
  previous?: LockEntry
  ceiling: readonly string[]
  signal?: AbortSignal
}): { preview: PackagePreview; treeIntegrity: string } {
  checkCancelled(input.signal)
  const treeIntegrity = hashDirectory(input.dir, {
    exclude: [],
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const pkg = readStaticJson(join(input.dir, 'package.json'))
  const fetched = input.fetched
  if (input.source.type === 'npm') {
    const ref = input.source.ref.slice(4),
      at = ref.lastIndexOf('@')
    if (pkg.name !== ref.slice(0, at) || pkg.version !== ref.slice(at + 1)) invalid('source-identity')
  }
  const dependencies = pkg.dependencies ?? {}
  if (
    fetched.dir !== input.dir ||
    pkg.version !== fetched.version ||
    canonical(dependencies) !== canonical(fetched.dependencies) ||
    (pkg.license ?? 'UNLICENSED') !== (fetched.license ?? 'UNLICENSED')
  )
    invalid('adapter-metadata')
  if (input.source.type !== 'npm' && fetched.integrity !== treeIntegrity) invalid('adapter-integrity')
  const agnes = pkg.agnes ?? {}
  if (
    !agnes ||
    typeof agnes !== 'object' ||
    Array.isArray(agnes) ||
    Object.keys(agnes).some(
      (k) => !['extensions', 'contributions', 'plugins', 'surfaces', 'clientDescriptors'].includes(k),
    )
  )
    invalid('agnes-metadata')
  const metadata = agnes as Record<string, unknown>
  let plugins: ReturnType<typeof parseAgnesPluginEntries>
  try {
    plugins = parseAgnesPluginEntries(String(pkg.name), metadata.plugins)
  } catch (error) {
    if (isReservedPluginRowIdError(error))
      throw new PackageError('E_EXT_LOAD', 'plugin row id prefix web: is reserved; choose another id', {
        detail: { reason: 'reserved-row-id', prefix: 'web:' },
      })
    invalid('plugins')
  }
  if (metadata.extensions !== undefined || existsSync(join(input.dir, 'agnes.extension.json')))
    throw new PackageError(
      'E_EXT_LOAD',
      'third-party agnes.extensions is retired; migrate the backend to agnes.plugins',
      {
        detail: { reason: 'legacy-extension-format' },
      },
    )
  if (metadata.clientDescriptors !== undefined && !Array.isArray(metadata.clientDescriptors))
    invalid('client-descriptors')
  const contributions: PackageContributionSummary[] = []
  const blockers: PackagePreview['blockers'] = []
  const clientRows = new Set<string>()
  const clientPaths = new Set<string>()
  for (const raw of array(metadata.clientDescriptors)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('client-descriptor-entry')
    const item = raw as Record<string, unknown>
    if (Object.keys(item).some((key) => key !== 'rowId' && key !== 'path'))
      invalid('client-descriptor-fields')
    if (typeof item.rowId !== 'string' || typeof item.path !== 'string') invalid('client-descriptor-entry')
    if (clientRows.has(item.rowId) || clientPaths.has(item.path)) invalid('duplicate-client-descriptor')
    clientRows.add(item.rowId)
    clientPaths.add(item.path)
    const plugin = plugins.find((entry) => entry.id === item.rowId)
    if (plugin?.runtime !== 'in-process') invalid('client-descriptor-row')
    if (
      !/^\.\/(?!\.{1,2}(?:\/|$))[^/\\:\0]+(?:\/(?!\.{1,2}(?:\/|$))[^/\\:\0]+)*\/agnes\.client\.json$/.test(
        item.path,
      )
    )
      invalid('client-descriptor-path')
    const descriptorPath = containedEntry(input.dir, item.path, 'file', 'package.json')
    const descriptor = readStaticJson(descriptorPath)
    if (
      Object.keys(descriptor).some((key) => key !== 'client' && key !== 'skins') ||
      (!descriptor.client && (!Array.isArray(descriptor.skins) || descriptor.skins.length === 0))
    )
      invalid('client-descriptor-content')
    const synthetic = checkManifest({
      id: 'client/descriptor',
      version: pkg.version,
      apiRange: '*',
      entry: './index.mjs',
      capabilities: { ui: descriptor.client ? ['client'] : ['skin'] },
      contributes: {
        ...(descriptor.client === undefined ? {} : { client: descriptor.client }),
        ...(descriptor.skins === undefined ? {} : { skins: descriptor.skins }),
      },
    })
    if (!synthetic.ok) invalid('client-descriptor-content')
    const manifest = synthetic.value
    const client = manifest.contributes?.client
    const directory = dirname(descriptorPath)
    if (client) resolveClientAssets(directory, manifest)
    resolveSkins(directory, manifest)
    const id = `plugin/${createHash('sha256').update(item.rowId).digest('hex').slice(0, 16)}`
    contributions.push(
      contribution({
        kind: 'client',
        id,
        rowId: item.rowId,
        path: item.path,
        ...(client ? { client: normalizeClientContribution(client) } : {}),
        ...(manifest.contributes?.skins ? { skins: manifest.contributes.skins } : {}),
      }),
    )
  }
  for (const raw of array(metadata.contributions)) {
    const c = contribution(raw)
    if (c.kind === 'extension' || c.kind === 'surface') invalid('contribution-kind')
    containedEntry(input.dir, c.path, 'file', 'package.json')
    contributions.push(c)
  }
  const surfaces = validateSurfacePackageMetadata({ surfaces: metadata.surfaces ?? [] })
  if (!surfaces.ok) invalid('surface')
  for (const descriptor of surfaces.value.surfaces) {
    const c = contribution({
      kind: 'surface',
      id: descriptor && typeof descriptor === 'object' && 'id' in descriptor ? descriptor.id : undefined,
      descriptor,
    })
    if (c.kind !== 'surface') invalid('surface')
    if (c.descriptor.artifact.kind === 'node')
      containedEntry(input.dir, c.descriptor.artifact.entry, 'file', 'package.json')
    contributions.push(c)
  }
  contributions.sort((a, b) => compare(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`))
  if (new Set(contributions.map((c) => `${c.kind}:${c.id}`)).size !== contributions.length)
    invalid('duplicate-contribution')
  if (
    (contributions.length === 0 && plugins.length === 0) ||
    ((pkg.main !== undefined || pkg.exports !== undefined) &&
      metadata.extensions === undefined &&
      metadata.contributions === undefined &&
      metadata.plugins === undefined)
  )
    blockers.push({ code: 'unknown-contribution', references: ['static-declaration-required'] })
  for (const c of contributions) {
    const range = c.kind === 'surface' ? c.descriptor.apiRange : 'apiRange' in c ? c.apiRange : undefined
    if (range !== undefined && !satisfiesApiRange(range, API_VERSION))
      blockers.push({ code: 'incompatible', references: [c.id] })
  }
  if (input.source.type === 'workspace')
    blockers.push({ code: 'policy', references: ['use-trust-workspace'] })
  const capabilityDiff = diff(contributions, input.previous, String(pkg.name), fetched.dependencies)
  const warnings: PackagePreview['warnings'] = [
    { code: 'unverified-provenance', safeMessage: 'Package signature has not been verified.' },
  ]
  if (!pkg.license || pkg.license === 'UNLICENSED')
    warnings.push({ code: 'unlicensed', safeMessage: 'No package license was declared.' })
  if (capabilityDiff.added.length)
    warnings.push({ code: 'capability-change', safeMessage: 'Capabilities require a new trust decision.' })
  if (capabilityDiff.runtimeSupportRemoved.length)
    warnings.push({
      code: 'runtime-support-change',
      safeMessage: 'Previously declared runtime support was removed.',
    })
  if (capabilityDiff.dependenciesAdded.length)
    warnings.push({ code: 'dependency-change', safeMessage: 'Package dependencies were added or changed.' })
  if (capabilityDiff.serviceGrantsAdded.length)
    warnings.push({
      code: 'service-grant-change',
      safeMessage: 'Surface service requirements were added or changed.',
    })
  const result = validatePackageAdminData('PackagePreview', {
    id: pkg.name,
    version: pkg.version,
    source: input.source,
    integrity: fetched.integrity,
    license: pkg.license ?? 'UNLICENSED',
    provenance: {
      source: input.source,
      integrity: fetched.integrity,
      signatureVerified: false,
      ...(fetched.releasedAt ? { releasedAt: fetched.releasedAt } : {}),
    },
    contributions,
    dependencies,
    capabilityDiff,
    capabilityHash: capabilityHash({ contributions, dependencies: fetched.dependencies }),
    warnings,
    blockers,
  })
  if (!result.ok) invalid('preview-contract')
  checkCancelled(input.signal)
  return { preview: freezeData(result.value as PackagePreview), treeIntegrity }
}
