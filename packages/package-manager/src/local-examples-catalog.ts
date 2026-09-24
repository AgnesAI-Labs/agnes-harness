import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { PackageCatalogDescriptor } from '@agnes/protocol'
import { validatePackageAdminData } from '@agnes/protocol'
import { type CatalogRead, createCatalog, staticCatalogSource } from './catalog.js'
import { PackageError } from './errors.js'
import { inspectStaged } from './inspect.js'
import { hashDirectory } from './sources.js'

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

function descriptor(
  workspace: string,
  relativeDirectory: string,
  signal?: AbortSignal,
): Omit<PackageCatalogDescriptor, 'sourceId' | 'retrievedAt'> {
  signal?.throwIfAborted()
  const directory = join(workspace, relativeDirectory)
  let owned: string
  try {
    if (lstatSync(directory).isSymbolicLink()) return invalid('symlink')
    owned = realpathSync(directory)
  } catch {
    return invalid('directory')
  }
  if (!contained(workspace, owned)) return invalid('containment')
  const pkg = json(join(owned, 'package.json'))
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string' || typeof pkg.license !== 'string')
    return invalid('identity')
  const source = { type: 'file' as const, ref: `file:./${relativeDirectory}` }
  const integrity = hashDirectory(owned, { ...(signal ? { signal } : {}) })
  const { preview } = inspectStaged({
    dir: owned,
    source,
    fetched: {
      dir: owned,
      version: pkg.version,
      integrity,
      license: pkg.license,
      dependencies: (pkg.dependencies ?? {}) as Record<string, string>,
    },
    ceiling: [],
    ...(signal ? { signal } : {}),
  })
  if (preview.blockers.length) return invalid('blocked-example')
  const value = {
    id: preview.id,
    version: preview.version,
    source,
    integrity,
    license: preview.license,
    contributions: preview.contributions,
    compatibility: 'supported' as const,
  }
  const projected = { ...value, sourceId: SOURCE_ID, retrievedAt: new Date(0).toISOString() }
  if (!validatePackageAdminData('PackageCatalogDescriptor', projected).ok) return invalid('descriptor')
  return value
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
    workspace = realpathSync(options.workspace)
  } catch {
    return invalid('workspace')
  }
  const now = options.now ?? Date.now
  const source = staticCatalogSource(SOURCE_ID, async (signal) => ({
    issuedAt: new Date(now()).toISOString(),
    ttlMs: TTL_MS,
    entries: [
      ...FAMILIES.flatMap((family) =>
        family.releases.map((release) =>
          descriptor(workspace, `examples/packages/${family.family}/${release}`, signal),
        ),
      ),
      ...FLAT_PLUGIN_EXAMPLES.map((name) => descriptor(workspace, `examples/packages/${name}`, signal)),
      ...(options.includeTestOnlyBroken
        ? FAMILIES.filter((family) => family.includeBroken).map(({ family }) =>
            descriptor(workspace, `examples/packages/${family}/broken`, signal),
          )
        : []),
    ],
  }))
  const catalog = createCatalog([source], { priority: [SOURCE_ID], now })
  const initial = await catalog.read(options.signal ? { signal: options.signal } : {})
  if (initial.sources[0]?.status !== 'fresh') return invalid('read')
  return catalog
}
