import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type { PackageCatalogDescriptor } from '@agnes/protocol'
import { validatePackageAdminData } from '@agnes/protocol'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { readApplicationAssets } from './application-assets.js'
import { BUNDLED_EXAMPLES, bundledExampleSource } from './bundled-plugin-source.js'
import { type CatalogRead, createCatalog, staticCatalogSource } from './catalog.js'
import { PackageError } from './errors.js'
import { mapFileChecks } from './file-read-pool.js'
import { inspectStaged } from './inspect.js'
import { fetchSource, hashDirectoryAsync } from './sources.js'

const SOURCE_ID = 'local-examples'
const TTL_MS = 86_400_000
const FAMILIES = [
  { family: 'hot-service', releases: ['v1', 'v2'], includeBroken: true },
  { family: 'skins-builtin', releases: ['v1', 'v2'], includeBroken: false },
  { family: 'client-panel', releases: ['v1', 'v2'], includeBroken: false },
  { family: 'client-multi-panel', releases: ['v1', 'v2'], includeBroken: false },
  { family: 'client-service-panel', releases: ['v1', 'v2'], includeBroken: false },
  { family: 'acme-dashboard', releases: ['v1', 'v2'], includeBroken: false },
  { family: 'skin-example', releases: ['v1'], includeBroken: false },
  { family: 'dsh-input-controls', releases: ['v1', 'v2'], includeBroken: true },
  { family: 'dsh-model-picker-a', releases: ['v1', 'v2'], includeBroken: true },
  { family: 'dsh-model-picker-b', releases: ['v1', 'v2'], includeBroken: true },
  { family: 'dsh-tool-view', releases: ['v1', 'v2'], includeBroken: true },
] as const
const FLAT_PLUGIN_EXAMPLES = ['hot-tool-plugin', 'hook-context-note', 'hook-runner-takeover'] as const

export type LocalExamplesCatalog = Readonly<{
  read(input?: { offline?: boolean; signal?: AbortSignal }): Promise<CatalogRead>
}>

export type LocalExamplesCatalogOptions = Readonly<{
  /** Workspace containing the repository-controlled examples/packages tree. */
  workspace: string
  /** Test-only failure candidates never appear in the normal discovery catalog. */
  includeTestOnlyBroken?: boolean
  now?: () => number
  signal?: AbortSignal
}>

function invalid(reason: string): never {
  throw new PackageError('E_DEP_MISSING', 'local example catalog is unavailable', {
    detail: { reason },
  })
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function json(file: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return invalid('metadata')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('metadata')
  return value as Record<string, unknown>
}

async function descriptor(
  workspace: string,
  relativeDirectory: string,
  signal?: AbortSignal,
  sourceRef?: string,
): Promise<Omit<PackageCatalogDescriptor, 'sourceId' | 'retrievedAt'>> {
  signal?.throwIfAborted()
  const directory = join(workspace, relativeDirectory)
  let owned: string
  try {
    if (lstatSync(directory).isSymbolicLink()) return invalid('symlink')
    owned = nativeRealpathSync(directory)
  } catch {
    return invalid('directory')
  }
  if (!contained(workspace, owned)) return invalid('containment')
  const pkg = json(join(owned, 'package.json'))
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string' || typeof pkg.license !== 'string')
    return invalid('identity')
  const source = { type: 'file' as const, ref: sourceRef ?? `file:./${relativeDirectory}` }
  // Discovery never executes or publishes code. Clean shipped trees can be inspected
  // in place; workspaces containing excluded development files still need the install payload.
  let needsPayload = ['node_modules', '.git', 'fixtures/out'].some(
    (path) => lstatSync(join(owned, path), { throwIfNoEntry: false }) !== undefined,
  )
  // Install excludes these names at every depth. Do not accidentally publish a
  // different catalog digest for a nested development dependency directory.
  const pending = [owned]
  while (!needsPayload && pending.length) {
    const directory = pending.pop()!
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        needsPayload = true
        break
      }
      if (entry.isDirectory()) pending.push(join(directory, entry.name))
    }
  }
  const staging = needsPayload ? mkdtempSync(join(tmpdir(), 'agnes-catalog-inspect-')) : undefined
  try {
    const staged = staging ? join(staging, 'package') : owned
    const integrity = staging
      ? (
          await fetchSource({ type: 'file', ref: `file:./${relativeDirectory}` }, staged, {
            cwd: workspace,
            ...(signal ? { signal } : {}),
          })
        ).integrity
      : await hashDirectoryAsync(staged, { exclude: [], ...(signal ? { signal } : {}) })
    const { preview } = await inspectStaged({
      dir: staged,
      source,
      fetched: {
        dir: staged,
        version: pkg.version,
        integrity,
        license: pkg.license,
        dependencies: (pkg.dependencies ?? {}) as Record<string, string>,
      },
      ...(signal ? { signal } : {}),
    })
    if (preview.blockers.length) return invalid('blocked-example')
    const assets = preview.application ? await readApplicationAssets(staged, preview.application) : undefined
    const value = {
      id: preview.id,
      version: preview.version,
      source,
      integrity,
      license: preview.license,
      contributions: preview.contributions,
      ...(assets?.mark ? { applicationAssets: { mark: assets.mark } } : {}),
      ...(preview.agents ? { agents: preview.agents } : {}),
      ...(preview.application ? { application: preview.application } : {}),
      ...(preview.presentation ? { presentation: preview.presentation } : {}),
      ...(preview.metadata ? { metadata: preview.metadata } : {}),
      ...(preview.provides === undefined ? {} : { provides: preview.provides }),
      compatibility: 'supported' as const,
    }
    const projected = { ...value, sourceId: SOURCE_ID, retrievedAt: new Date(0).toISOString() }
    if (!validatePackageAdminData('PackageCatalogDescriptor', projected).ok) return invalid('descriptor')
    return value
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Build and pre-warm the daemon's repository-controlled local discovery source.
 *
 * The returned source is discovery metadata only. PackageManager still fetches and re-inspects the
 * selected file source before install, trust, or activation can mutate durable state.
 */
export async function createLocalExamplesCatalog(
  options: LocalExamplesCatalogOptions,
): Promise<LocalExamplesCatalog> {
  let workspace: string
  try {
    workspace = nativeRealpathSync(options.workspace)
  } catch {
    return invalid('workspace')
  }
  const now = options.now ?? Date.now
  const source = staticCatalogSource(SOURCE_ID, async (signal) => {
    const directories = [
      ...FAMILIES.flatMap((family) =>
        family.releases.map((release) => `examples/packages/${family.family}/${release}`),
      ),
      ...BUNDLED_EXAMPLES.filter((example) => example.family === 'fde')
        .filter((example) => existsSync(join(workspace, 'examples', example.family, example.name)))
        .map((example) => `examples/${example.family}/${example.name}`),
      ...FLAT_PLUGIN_EXAMPLES.map((name) => `examples/packages/${name}`),
      ...(options.includeTestOnlyBroken
        ? FAMILIES.filter((family) => family.includeBroken).map(
            ({ family }) => `examples/packages/${family}/broken`,
          )
        : []),
    ]
    const entries = await mapFileChecks(directories, async (directory) => {
      // Bound discovery to the existing four-reader pool; yield around synchronous inspection.
      await setImmediate()
      return descriptor(workspace, directory, signal)
    })
    return {
      issuedAt: new Date(now()).toISOString(),
      ttlMs: TTL_MS,
      entries,
    }
  })
  const catalog = createCatalog([source], { priority: [SOURCE_ID], now })
  const initial = await catalog.read(options.signal ? { signal: options.signal } : {})
  if (initial.sources[0]?.status !== 'fresh') return invalid('read')
  return catalog
}

/** Metadata only: installation still fetches, inspects, reviews, trusts and enables normally. */
export async function bundledExamplesEntries(signal?: AbortSignal) {
  const entries = await mapFileChecks(BUNDLED_EXAMPLES, async (example) => {
    await setImmediate()
    const source = bundledExampleSource(example.ref)
    if (!source) return invalid('bundled-source')
    if (!existsSync(join(source.root, source.path, 'package.json'))) return undefined
    // descriptor already fetches, hashes and inspects the exact install payload.
    // A second staging copy adds no discovery information or authorization.
    return descriptor(nativeRealpathSync(source.root), source.path, signal, example.ref)
  })
  return entries.filter((entry) => entry !== undefined)
}
