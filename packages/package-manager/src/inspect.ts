import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeAuthoringDiagnostics } from '@agnes/error-sanitization'
import { API_VERSION, checkManifest, ProviderError, satisfiesApiRange } from '@agnes/extension-api'
import {
  type PackageCapabilityDiff,
  type PackageContributionSummary,
  type PackagePreview,
  validatePackageAdminData,
  validatePluginMetadata,
  validateSurfacePackageMetadata,
} from '@agnes/protocol'
import { readApplicationAssets } from './application-assets.js'
import { parseApplicationContract } from './application-contract.js'
import { parsePackageBundleContract, preflightPackageBundles } from './bundle-contract.js'
import { normalizeClientContribution, resolveClientAssets } from './client-assets.js'
import { containedEntry } from './entry-path.js'
import { PackageError } from './errors.js'
import { canonical, capabilityHash, freezeData, own, readStaticJson, snapshotHash } from './integrity.js'
import type { LockEntry } from './lockfile.js'
import { assertCurrentPackageFormat } from './package-format.js'
import { presentPluginRows } from './package-presentation.js'
import {
  capabilityAtoms,
  capabilityPolicyBlockers,
  mergePluginCapabilities,
  type PluginCapabilityPolicy,
  pluginCapabilityCategories,
} from './plugin-capabilities.js'
import {
  isReservedPluginRowIdError,
  parseAgnesPluginEntries,
  parseAgnesPluginProvides,
} from './plugin-manifest.js'
import { checkCancelled } from './ports.js'
import { resolveSkins } from './skin-assets.js'
import { type FetchedSource, hashDirectory, type PackageSource } from './sources.js'

function invalid(reason: string, diagnostics: unknown[] = []): never {
  throw new PackageError('E_EXT_LOAD', 'package static metadata is invalid', {
    detail: { reason, ...(diagnostics.length ? { diagnostics: safeAuthoringDiagnostics(diagnostics) } : {}) },
  })
}
function checkedContribution(value: unknown): PackageContributionSummary {
  assertCurrentPackageFormat(value)
  const checked = validatePackageAdminData('PackageContributionSummary', value)
  if (!checked.ok) invalid('contribution')
  return value as PackageContributionSummary
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
            path: './package.json',
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
      .filter((key) => (previous && own(previous.dependencies, key)) !== dependencies[key])
      .sort(),
    serviceGrantsAdded: [...new Map(grants.map((g) => [canonical(g), g])).values()].sort((a, b) =>
      compare(canonical(a), canonical(b)),
    ),
  }
}

/** Reads only data files from an already acquired staging tree. No module loader is involved. */
type InspectionInput = {
  dir: string
  source: PackageSource
  fetched: FetchedSource
  previous?: LockEntry
  ceiling?: readonly string[]
  capabilityPolicy?: PluginCapabilityPolicy
  signal?: AbortSignal
}

export async function inspectStaged(
  input: InspectionInput,
): Promise<{ preview: PackagePreview; treeIntegrity: string }> {
  checkCancelled(input.signal)
  const treeIntegrity = hashDirectory(input.dir, {
    exclude: [],
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const result = inspectVerifiedTree(input, treeIntegrity)
  if (result.preview.application) {
    try {
      await readApplicationAssets(input.dir, result.preview.application)
    } catch (error) {
      invalid(error instanceof Error ? error.message : 'application')
    }
    // Pixel decoding yields; never publish a tree digest captured before changed package bytes.
    if (
      hashDirectory(input.dir, { exclude: [], ...(input.signal ? { signal: input.signal } : {}) }) !==
      treeIntegrity
    )
      invalid('application-assets-changed')
  }
  checkCancelled(input.signal)
  return result
}

/** Internal same-round reuse only: the caller must have just hashed this directory synchronously.
 * Never carry this digest across an await, import, copy or publication boundary. */
export function inspectVerifiedTree(
  input: InspectionInput,
  treeIntegrity: string,
): { preview: PackagePreview; treeIntegrity: string } {
  checkCancelled(input.signal)
  const pkg = readStaticJson(join(input.dir, 'package.json'))
  const contribution = (value: unknown) => checkedContribution(value)
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
  // Non-npm fetch digests skip node_modules, .git and fixtures/out, so a tree carrying them can
  // never verify; say so instead of blaming the adapter. npm keeps its own registry digest.
  if (input.source.type !== 'npm' && fetched.integrity !== treeIntegrity) {
    if (fetched.integrity !== hashDirectory(input.dir)) invalid('adapter-integrity')
    throw new PackageError('E_EXT_LOAD', 'only npm packages may contain node_modules, .git or fixtures/out', {
      detail: { reason: 'excluded-directory' },
    })
  }
  const agnes = pkg.agnes ?? {}
  assertCurrentPackageFormat(agnes)
  if (
    !agnes ||
    typeof agnes !== 'object' ||
    Array.isArray(agnes) ||
    Object.keys(agnes).some(
      (k) =>
        ![
          'metadata',
          'extensions',
          'contributions',
          'plugins',
          'surfaces',
          'clientDescriptors',
          'provides',
          'application',
          'bundles',
          'hostProvidedExternals',
        ].includes(k),
    )
  )
    invalid('agnes-metadata')
  const metadata = agnes as Record<string, unknown>
  const displayMetadata =
    metadata.metadata === undefined ? undefined : validatePluginMetadata(metadata.metadata)
  if (displayMetadata && !displayMetadata.ok) invalid('plugin-metadata')
  const bundles = metadata.bundles
  if (
    bundles !== undefined &&
    (!bundles ||
      typeof bundles !== 'object' ||
      Array.isArray(bundles) ||
      Object.keys(bundles).length === 0 ||
      Object.keys(bundles).length > 64)
  )
    invalid('bundles')
  let provides: ReturnType<typeof parseAgnesPluginProvides>
  let declaredCapabilities: ReturnType<typeof mergePluginCapabilities>
  let plugins: ReturnType<typeof parseAgnesPluginEntries>
  try {
    provides = parseAgnesPluginProvides(metadata.provides)
    plugins = parseAgnesPluginEntries(String(pkg.name), metadata.plugins)
    declaredCapabilities = mergePluginCapabilities(plugins.map((entry) => entry.capabilities))
  } catch (error) {
    if (isReservedPluginRowIdError(error))
      throw new PackageError('E_EXT_LOAD', 'plugin row id prefix web: is reserved; choose another id', {
        detail: { reason: 'reserved-row-id', prefix: 'web:' },
      })
    if (error instanceof ProviderError)
      throw new PackageError('E_API_RANGE', `${error.message}. ${error.hint ?? ''}`, {
        detail: {
          reason:
            error.code === 'E_PROVIDER_INVALID'
              ? 'plugin-api-range-required'
              : 'plugin-api-range-incompatible',
          hint: error.hint,
        },
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
  const blockers: PackagePreview['blockers'] = capabilityPolicyBlockers(
    declaredCapabilities,
    input.capabilityPolicy ?? {},
  )
  if (input.ceiling !== undefined) {
    const allowedCategories = new Set(input.ceiling)
    const extra = [...new Set(plugins.flatMap((entry) => pluginCapabilityCategories(entry.capabilities)))]
      .filter((category) => !allowedCategories.has(category))
      .sort()
    if (extra.length) blockers.push({ code: 'policy', references: ['capability-ceiling', ...extra] })
  }
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
    if (!/^\.\/(?:(?!\.{1,2}(?:\/|$))[^/\\:\0]+\/)*agnes\.client\.json$/.test(item.path))
      invalid('client-descriptor-path')
    const descriptorPath = containedEntry(input.dir, item.path, 'file', 'package.json')
    const descriptor = readStaticJson(descriptorPath)
    if (
      Object.keys(descriptor).some((key) => key !== 'client' && key !== 'skins') ||
      (!descriptor.client && (!Array.isArray(descriptor.skins) || descriptor.skins.length === 0))
    )
      invalid('client-descriptor-content')
    const synthetic = checkManifest(
      {
        id: 'client/descriptor',
        version: pkg.version,
        apiRange: '*',
        entry: './index.mjs',
        // Keep the descriptor binding's implicit UI marker, but validate every declared capability
        // against this exact owner. Neither a sibling row nor the descriptor can supply authority.
        capabilities: { ui: true, ...plugin.capabilities },
        contributes: {
          ...(descriptor.client === undefined ? {} : { client: descriptor.client }),
          ...(descriptor.skins === undefined ? {} : { skins: descriptor.skins }),
        },
      },
      pkg.name as string,
    )
    if (!synthetic.ok)
      invalid(
        'client-descriptor-content',
        synthetic.problems.map((problem) => {
          const token =
            /^(contributes\.skins\.[A-Za-z0-9_-]+\.tokens): (--[A-Za-z0-9_-]+) is not a themeable semantic token$/.exec(
              problem,
            )
          const rawField = problem
            .split(':')[0]!
            .replace(/^contributes\./, '')
            .replace(/^\//, '')
            .replaceAll('/', '.')
          const field = /^[A-Za-z0-9_.$[\]-]{1,160}$/.test(rawField) ? rawField : 'descriptor'
          return token
            ? {
                code: 'unknown-theme-token',
                path: item.path,
                field: token[1]!.replace(/^contributes\./, ''),
                name: token[2],
              }
            : { code: 'invalid-field', path: item.path, field, name: '' }
        }),
      )
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
  if (displayMetadata?.ok && displayMetadata.value.exampleOf !== undefined) {
    const example = displayMetadata.value
    if (
      !example.exampleOf ||
      example.exampleOf === String(pkg.name) ||
      !fetched.dependencies[example.exampleOf]
    )
      invalid('example-dependency')
    if (
      example.pageEntry &&
      !contributions.some(
        (item) =>
          'client' in item &&
          item.client?.lifetime === 'profile' &&
          item.client.examplePages?.includes(example.pageEntry ?? ''),
      )
    )
      invalid('example-page')
  }
  let preflight = preflightPackageBundles({
    packageId: String(pkg.name),
    bundles,
    dependencies: fetched.dependencies,
    pages: contributions.flatMap((item) =>
      'client' in item && item.client?.lifetime === 'profile'
        ? [...(item.client.examplePages ?? []), ...(item.client.homeEntries ?? []).map((page) => page.id)]
        : [],
    ),
    runtime: plugins,
  })
  if (preflight.level === 'refused') invalid(preflight.reasons.join('; '))
  const agents = Object.values(parsePackageBundleContract(String(pkg.name), bundles))
    .flatMap((entry) => (entry.document.launch ? [{ ref: entry.id, launch: entry.document.launch }] : []))
    .sort((a, b) => compare(a.ref, b.ref))

  let application: import('@agnes/protocol').ApplicationTemplate | undefined
  try {
    const parsed = parseApplicationContract(
      metadata.application,
      String(pkg.name),
      parsePackageBundleContract(String(pkg.name), bundles),
      fetched.dependencies,
      contributions,
    )
    application = parsed.application
    if (parsed.deploymentDependent)
      preflight = {
        level: 'deployment-dependent',
        reasons: [...preflight.reasons, 'application-dependency-definitions-required'],
        next: 'validate-deployment',
      }
  } catch (error) {
    invalid(error instanceof Error ? error.message : 'application')
  }
  contributions.sort((a, b) => compare(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`))
  if (new Set(contributions.map((c) => `${c.kind}:${c.id}`)).size !== contributions.length)
    invalid('duplicate-contribution')
  if (
    (contributions.length === 0 && plugins.length === 0 && bundles === undefined) ||
    ((pkg.main !== undefined || pkg.exports !== undefined) &&
      metadata.extensions === undefined &&
      metadata.contributions === undefined &&
      metadata.plugins === undefined &&
      bundles === undefined)
  )
    throw new PackageError('E_DEP_MISSING', 'source has no AGH plugin declarations', {
      detail: { reason: 'static-declaration-required' },
    })
  for (const c of contributions) {
    const range = c.kind === 'surface' ? c.descriptor.apiRange : 'apiRange' in c ? c.apiRange : undefined
    if (range !== undefined && !satisfiesApiRange(range, API_VERSION))
      blockers.push({ code: 'incompatible', references: [c.id] })
  }
  if (input.source.type === 'workspace')
    blockers.push({ code: 'policy', references: ['use-trust-workspace'] })
  const capabilityDiff = diff(contributions, input.previous, String(pkg.name), fetched.dependencies)
  const currentAtoms = new Set(capabilityAtoms(declaredCapabilities)),
    previousAtoms = new Set(capabilityAtoms(input.previous?.declaredCapabilities))
  capabilityDiff.added.push(...difference(currentAtoms, previousAtoms))
  capabilityDiff.removed.push(...difference(previousAtoms, currentAtoms))
  const warnings: PackagePreview['warnings'] = fetched.provenance?.signatureVerified
    ? []
    : [{ code: 'unverified-provenance', safeMessage: 'Package signature has not been verified.' }]
  if (!pkg.license || pkg.license === 'UNLICENSED')
    warnings.push({ code: 'unlicensed', safeMessage: 'No package license was declared.' })
  if (capabilityDiff.added.length)
    warnings.push({ code: 'capability-change', safeMessage: 'Capabilities require a new trust decision.' })
  if (capabilityDiff.runtimeSupportRemoved.length)
    warnings.push({
      code: 'runtime-support-change',
      safeMessage: 'Previously declared runtime support was removed.',
    })
  if (input.previous && capabilityDiff.dependenciesAdded.length)
    warnings.push({ code: 'dependency-change', safeMessage: 'Package dependencies were added or changed.' })
  if (capabilityDiff.serviceGrantsAdded.length)
    warnings.push({
      code: 'service-grant-change',
      safeMessage: 'Surface service requirements were added or changed.',
    })
  const preview = {
    id: pkg.name,
    version: pkg.version,
    source: input.source,
    integrity: fetched.integrity,
    license: pkg.license ?? 'UNLICENSED',
    provenance: {
      source: input.source,
      integrity: fetched.integrity,
      signatureVerified: false,
      ...(fetched.provenance ?? {}),
      ...(fetched.releasedAt ? { releasedAt: fetched.releasedAt } : {}),
    },
    preflight,
    ...(application ? { application } : {}),
    ...(agents.length ? { agents } : {}),
    contributions,
    presentation: presentPluginRows(plugins, {
      packageId: String(pkg.name),
      bundles,
      provides,
      contributions,
    }),
    ...(displayMetadata?.ok ? { metadata: displayMetadata.value } : {}),
    ...(declaredCapabilities === undefined ? {} : { declaredCapabilities }),
    ...(provides === undefined ? {} : { provides }),
    dependencies,
    capabilityDiff,
    capabilityHash: capabilityHash({
      ...(displayMetadata?.ok ? { metadata: displayMetadata.value } : {}),
      contributions,
      agents,
      ...(application ? { application } : {}),
      dependencies: fetched.dependencies,
      ...(declaredCapabilities === undefined ? {} : { declaredCapabilities }),
    }),
    warnings,
    blockers,
  }
  const result = validatePackageAdminData('PackagePreview', preview)
  if (!result.ok) invalid('preview-contract')
  checkCancelled(input.signal)
  return { preview: freezeData(preview as PackagePreview), treeIntegrity }
}
