import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import {
  type BeforeCompactPayload,
  type CompactionPlan,
  type Enforcement,
  type Operation,
  type RemoteTransport,
  type SandboxExecBackend,
  type SandboxSeam,
  type SandboxWorkspaceBackend,
  SEAM_NAMES,
  type SeamName,
  type WorkspaceHookSandbox,
} from '@agnes/core'
import type {
  ExtensionAPI,
  ExtensionFactory,
  ExtensionManifest,
  HookInvocationSnapshot,
  Logger,
} from '@agnes/extension-api'
import {
  type AgnesPluginManifestEntry,
  loadPackagePlugins,
  parseAgnesPluginEntries,
  type RuntimePluginSnapshot,
} from '@agnes/package-manager'
import type { PackageSnapshotCandidateRef } from '@agnes/plugin-runtime/host'
import { normalizePluginExport, type VerifiedRowEntry } from '@agnes/plugin-runtime/host'
import type { JsonValue } from '@agnes/protocol'
import type { SandboxHostServices, SeamAdapters } from '../adapters/index.js'
import type { ComputerUseBackendProvider } from '../computer-use/windows-driver-backend.js'
import { HostError, type HostErrorCode } from '../errors.js'
import { resolveEntry } from '../ext-host/manifest.js'
import type { Lockfile } from '../packages/lockfile.js'
import { packageDir } from '../packages/sources.js'
import type { PresetDoc } from '../presets/types.js'
import type { ResolvedProfile } from '../profile/types.js'
import type { SkillRuntimeInput } from '../resources/skills.js'
import type { PrivacyTrajectoryCapability } from '../trajectory-contract.js'

// Seven profile fields, spelled the way the seam packages consume them. The sandbox seam derives
// ~/.ssh from homeDir, every seam reads its own keys out of preset, and checkpoint and budget stamp
// rows with resolvedProfileHash. A shorter context is not a smaller contract, it is three undefineds.
export type SeamProfileView = {
  name: string
  resolvedProfileHash: string | null
  dataDir: string
  workspaceRoot: string
  homeDir: string
  limits: Record<string, number>
  preset: Record<string, unknown>
}
type BoundSkillRuntimeInput = SkillRuntimeInput & Required<Pick<SkillRuntimeInput, 'runInWorkspace'>>
/** Safe cross-extension Skill discovery view; it intentionally excludes the body read port. */
export type SkillRuntimeDiscovery = Readonly<Pick<BoundSkillRuntimeInput, 'list' | 'runInWorkspace'>>

export type SeamInitContext = {
  /** Deployment grants, supplied only to the exact bundled hooks-runner factory. */
  trustedHookCommands?: Readonly<{
    allowsUnconfined(source: 'data' | 'workspace', configDigest: string): boolean
  }>
  secrets(ref: string): string
  adapters: SeamAdapters
  profile: SeamProfileView
  log: Logger
  signal: AbortSignal
  /** Exact bundled artifacts seam only; Host constructs the path from the digest. */
  privateArtifactStore?: Readonly<{
    put(sha256: string, bytes: Uint8Array): Promise<void>
    putComputerUseMetadata(sha256: string, bytes: Uint8Array): Promise<void>
  }>
  /** Host startup bound for a package seam factory. */
  seamTimeoutMs?: number
  /** Privileged resource snapshot, supplied only to the bundled skills ecosystem factory. */
  skillResources?: BoundSkillRuntimeInput
  /** Safe descriptors, supplied to agnes/mcp-search without Skill-body access. A live view of the
   *  Skills generation agnes/skills currently serves (design §3.9, D123). */
  skillDiscovery?: SkillRuntimeDiscovery
  /** Host-owned fixed operation, populated only for the exact agnes/privacy factory. */
  privacyTrajectory?: PrivacyTrajectoryCapability
  /** Exact trusted computer-use extension only; never supplied to another package or extension. */
  computerUseBackendProvider?: ComputerUseBackendProvider
  computerUseOptions?: Readonly<{
    captureAfterMode?: 'som' | 'vision' | 'ax'
    autoCaptureAfterActions?: boolean
    maxImageDimension?: number
    maxBytesPerImage?: number
    maxCapturesPerHour?: number
    maxRecentPerSession?: number
  }>
  /** Available to ecosystem extensions after the seam phase, never a raw exec substitute. */
  sandbox?: SandboxSeam
  /** Present only in the context handed to the sandbox factory; other seams never see it. */
  sandboxHost?: SandboxHostServices
}
export type SeamFactory<S = unknown> = (ctx: SeamInitContext) => Promise<S>

export type OperationDeps = {
  log: Logger
  signal: AbortSignal
  adapters: SeamAdapters
  secrets(ref: string): string
  ext: Record<string, unknown>
  profile: SeamProfileView
}
/** ERRATA B4: an Operation needs assembly-time dependencies, so a package exports factories. */
export type OperationTable = Record<string, (deps: OperationDeps) => Operation>

export type RuntimeFactory = (ctx: { log: Logger; signal: AbortSignal }) => Promise<unknown>
export const RUNTIME_LANGUAGES = ['python', 'typescript'] as const
export type RuntimeLanguage = (typeof RUNTIME_LANGUAGES)[number]
export type BuildCompactionPlan = (
  payload: BeforeCompactPayload,
  config: Readonly<{ keepRecentTokens: number }>,
) => CompactionPlan | null | Promise<CompactionPlan | null>

export type SandboxWorkspaceProbeFactory = (input: {
  level: 'L0' | 'L1'
  required: boolean
  onUnavailable: 'deny' | 'allow'
  shell: 'posix' | 'powershell'
  options: {
    cwd: string
    allowPaths: readonly string[]
    denyPaths: readonly string[]
    networkAllow: readonly string[]
  }
  probeExec: (
    argv: string[],
    options: { cwd: string; timeoutMs: number; signal?: AbortSignal; maxOutputBytes: number },
  ) => Promise<{
    code: number
    stdout: string
    stderr: string
    truncated: boolean
    timedOut: boolean
    signal?: string
  }>
  log: Logger
  signal?: AbortSignal
}) => Promise<
  SandboxWorkspaceBackend &
    Readonly<{
      name: 'none' | 'bwrap' | 'seatbelt'
      execBackend: SandboxExecBackend
      enforcement: Enforcement
      degraded: boolean
    }>
>

/**
 * Trusted, package-owned preparation for the one fixed out-of-process adapter. The data crosses
 * the runner boundary; the capability dispatcher stays in Host and receives the checked API.
 * This is deliberately not a remote ExtensionAPI or a dynamic registration protocol.
 */
export type IsolatedEcosystemPreparation = {
  data: Record<string, unknown>
  capability(
    api: ExtensionAPI,
    method: string,
    input: unknown,
    signal: AbortSignal,
    invocation: {
      event: string
      payload: unknown
      session: { key: string; workspaceRoot: string; turn?: number; step?: number }
      workspaceHooks?: HookInvocationSnapshot
      sandbox?: WorkspaceHookSandbox
    },
  ): Promise<unknown>
}
export type IsolatedEcosystemFactory = (ctx: SeamInitContext) => Promise<IsolatedEcosystemPreparation>

export type PackageModule = {
  /** Opens a channel only when this package is selected as the sandbox seam. */
  openTransport?: (
    config: Record<string, JsonValue>,
    ctx: {
      secret(ref: string): string
      dataDir: string
      signal: AbortSignal
    },
  ) => Promise<RemoteTransport>
  /** Package-owned backend compiler; Host supplies and retains the only raw probe capability. */
  sandboxWorkspaceProbe?: SandboxWorkspaceProbeFactory
  id: string
  /** Host-private Cordis exports declared by this package's unique static plugin manifest. */
  plugins?: readonly Readonly<{
    declaration: Readonly<AgnesPluginManifestEntry>
    entry: VerifiedRowEntry
    /** Present only when this export came from an immutable PackageManager runtime snapshot. */
    candidate?: Readonly<PackageSnapshotCandidateRef>
    snapshotDigest?: string
  }>[]
  seams?: Partial<Record<SeamName, SeamFactory>>
  operations?: OperationTable
  presets?: Record<string, PresetDoc>
  runtimes?: Partial<Record<RuntimeLanguage, RuntimeFactory>>
  ecosystem?: Record<string, (ctx: SeamInitContext) => ExtensionFactory>
  isolatedEcosystem?: Record<string, IsolatedEcosystemFactory>
  /** Trusted default policy; dynamic alternatives register `before_compact` instead. */
  buildCompactionPlan?: BuildCompactionPlan
  /** Release-embedded manifests. Only a loader owned by the executable can populate these. */
  embeddedExtensions?: readonly ExtensionManifest[]
  extensionEntry?: string
}
export interface PackageLoader {
  importPackage(id: string, dir: string): Promise<PackageModule>
}

export type LoadedRuntimePackage = Readonly<{
  source: Readonly<RuntimePluginSnapshot>
  module: PackageModule
}>

/** Load executable plugin exports only from a PackageManager-owned immutable snapshot directory. */
export async function loadRuntimePackage(
  source: Readonly<RuntimePluginSnapshot>,
  loader: { import(file: string): Promise<Record<string, unknown>> },
): Promise<LoadedRuntimePackage | undefined> {
  let namespace: Readonly<Record<string, unknown>> | undefined
  let entry = ''
  const loaded = await loadPackagePlugins({
    snapshot: source.snapshot,
    generation: source.generation,
    async importModule(snapshot) {
      entry = packageEntry(snapshot.packageId, snapshot.directory)
      namespace = await loader.import(entry)
      return namespace
    },
  })
  if (!loaded.length) return undefined
  if (!namespace || !entry) throw new Error('runtime plugin loader did not return a module namespace')
  const module = readNamedExports(source.snapshot.packageId, entry, namespace as Record<string, unknown>, [])
  module.plugins = Object.freeze(
    loaded.map((plugin) =>
      Object.freeze({
        declaration: plugin.declaration,
        entry: plugin.entry,
        candidate: plugin.candidate,
        snapshotDigest: source.snapshot.integrity,
      }),
    ),
  )
  return Object.freeze({ source, module })
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * What each factory-valued named export has to look like. One row per export, so the three checks
 * cannot drift into three different ideas of what "a table of factories" means - which is how the
 * previous version ended up with a predicate ("every value is a function") that was true for `[]`,
 * true for `{}`, and never looked at a key at all.
 *
 * `keys` is the closed set a key must belong to, or null when any key is allowed. `field` is what
 * the offending key is called in the refusal's detail, so the message points at the package that got
 * it wrong rather than at the seam that later came up empty three steps away.
 */
const FACTORY_EXPORTS = [
  { name: 'seams', code: 'E_SEAM_EXPORT_MISSING', field: 'seam', keys: SEAM_NAMES, nonEmpty: true },
  { name: 'operations', code: 'E_EXT_LOAD', field: 'operation', keys: null, nonEmpty: false },
  { name: 'runtimes', code: 'E_EXT_LOAD', field: 'language', keys: RUNTIME_LANGUAGES, nonEmpty: false },
  { name: 'ecosystem', code: 'E_EXT_LOAD', field: 'extension', keys: null, nonEmpty: false },
  {
    name: 'isolatedEcosystem',
    code: 'E_EXT_LOAD',
    field: 'extension',
    keys: null,
    nonEmpty: false,
  },
] as const satisfies ReadonlyArray<{
  name: 'seams' | 'operations' | 'runtimes' | 'ecosystem' | 'isolatedEcosystem'
  code: HostErrorCode
  field: string
  keys: readonly string[] | null
  nonEmpty: boolean
}>
type FactorySpec = (typeof FACTORY_EXPORTS)[number]

function readFactoryTable(id: string, value: unknown, spec: FactorySpec): Record<string, unknown> {
  const bad = (why: string, detail: Record<string, unknown>): never => {
    throw new HostError(spec.code, `${id}: ${spec.name} export ${why}`, { detail: { id, ...detail } })
  }
  if (!isPlainObject(value)) bad('must be an object of factories, not an array', { reason: 'not-an-object' })
  const table = value as Record<string, unknown>
  if (spec.nonEmpty && Object.keys(table).length === 0) bad('is empty', { reason: 'empty' })
  // Widened deliberately: the tuples are `as const`, so a literal-typed includes() would only accept
  // a key that is already known to be valid - which is the question being asked.
  const keys: readonly string[] | null = spec.keys
  for (const [k, v] of Object.entries(table)) {
    if (keys && !keys.includes(k))
      bad(`has key ${k}, which is not a known ${spec.field}`, { reason: 'unknown-key', key: k })
    if (typeof v !== 'function')
      bad(`.${k} must be a factory function`, { reason: 'not-a-factory', [spec.field]: k })
  }
  return table
}

/** The package named exports, checked before anything is assembled. */
export function readNamedExports(
  id: string,
  entry: string,
  mod: Record<string, unknown>,
  pluginDeclarations: readonly Readonly<AgnesPluginManifestEntry>[] = [],
): PackageModule {
  const out: PackageModule = { id, extensionEntry: entry }
  if (pluginDeclarations.length) {
    out.plugins = Object.freeze(
      pluginDeclarations.map((declaration) => {
        if (!Object.hasOwn(mod, declaration.export))
          throw new HostError('E_EXT_LOAD', `${id}: plugin export ${declaration.export} is missing`, {
            detail: { id, reason: 'plugin-export-missing', export: declaration.export },
          })
        try {
          return Object.freeze({
            declaration,
            entry: normalizePluginExport(mod[declaration.export] as never),
          })
        } catch {
          throw new HostError('E_EXT_LOAD', `${id}: plugin export ${declaration.export} is invalid`, {
            detail: { id, reason: 'plugin-export-shape', export: declaration.export },
          })
        }
      }),
    )
  }
  for (const spec of FACTORY_EXPORTS) {
    const value = mod[spec.name]
    if (value === undefined) continue
    const table = readFactoryTable(id, value, spec)
    if (spec.name === 'seams') out.seams = table as NonNullable<PackageModule['seams']>
    else if (spec.name === 'operations') out.operations = table as OperationTable
    else if (spec.name === 'runtimes') out.runtimes = table as NonNullable<PackageModule['runtimes']>
    else if (spec.name === 'ecosystem') out.ecosystem = table as NonNullable<PackageModule['ecosystem']>
    else out.isolatedEcosystem = table as NonNullable<PackageModule['isolatedEcosystem']>
  }
  // presets is data rather than factories, so it is the one export the table above does not cover.
  if (mod.presets !== undefined) {
    const bad = (why: string, detail: Record<string, unknown>): never => {
      throw new HostError('E_EXT_LOAD', `${id}: presets export ${why}`, { detail: { id, ...detail } })
    }
    if (!isPlainObject(mod.presets)) bad('must be an object', { reason: 'not-an-object' })
    for (const [k, v] of Object.entries(mod.presets as Record<string, unknown>))
      if (!isPlainObject(v) || typeof v.name !== 'string')
        bad(`.${k} must be a preset document with a name`, { reason: 'no-name', preset: k })
    out.presets = mod.presets as Record<string, PresetDoc>
  }
  if (mod.openTransport !== undefined) {
    if (typeof mod.openTransport !== 'function')
      throw new HostError('E_EXT_LOAD', `${id}: openTransport export must be a function`, {
        detail: { id, reason: 'not-a-function' },
      })
    out.openTransport = mod.openTransport as NonNullable<PackageModule['openTransport']>
  }
  if (mod.sandboxWorkspaceProbe !== undefined) {
    if (typeof mod.sandboxWorkspaceProbe !== 'function')
      throw new HostError('E_EXT_LOAD', `${id}: sandboxWorkspaceProbe export must be a function`, {
        detail: { id, reason: 'not-a-function' },
      })
    out.sandboxWorkspaceProbe = mod.sandboxWorkspaceProbe as SandboxWorkspaceProbeFactory
  }
  if (mod.buildCompactionPlan !== undefined) {
    if (typeof mod.buildCompactionPlan !== 'function')
      throw new HostError('E_EXT_LOAD', `${id}: buildCompactionPlan export must be a function`, {
        detail: { id, reason: 'not-a-function' },
      })
    out.buildCompactionPlan = mod.buildCompactionPlan as BuildCompactionPlan
  }
  return out
}

export class MemoryPackageLoader implements PackageLoader {
  constructor(private readonly modules: Record<string, PackageModule>) {}
  async importPackage(id: string): Promise<PackageModule> {
    const m = this.modules[id]
    if (!m) throw new HostError('E_DEP_MISSING', `${id}: not in memory loader`, { detail: { id } })
    return m
  }
}

/**
 * The real loader: resolves a package's entry file from its package.json (`exports['.']`, a
 * string `exports`, or `main`, in that order, defaulting to `./index.js`) and evaluates it
 * through the given module loader (in practice, ext-host's jiti-backed `createLoader`).
 */
export function createJitiPackageLoader(loader: {
  import(file: string): Promise<Record<string, unknown>>
}): PackageLoader {
  return {
    async importPackage(id, dir) {
      const pkgJson = join(dir, 'package.json')
      if (!existsSync(pkgJson))
        throw new HostError('E_DEP_MISSING', `${id}: package.json not found`, { detail: { id } })
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as {
        name?: unknown
        exports?: Record<string, string> | string
        main?: string
        agnes?: unknown
      }
      if (pkg.name !== undefined && pkg.name !== id)
        throw new HostError('E_EXT_LOAD', `${id}: package manifest name does not match`, {
          detail: { id, reason: 'package-name' },
        })
      let pluginDeclarations: readonly Readonly<AgnesPluginManifestEntry>[]
      try {
        if (
          pkg.agnes !== undefined &&
          (!pkg.agnes || typeof pkg.agnes !== 'object' || Array.isArray(pkg.agnes))
        )
          throw new TypeError('agnes must be an object')
        pluginDeclarations = parseAgnesPluginEntries(
          id,
          (pkg.agnes as Readonly<Record<string, unknown>> | undefined)?.plugins,
        )
      } catch {
        throw new HostError('E_EXT_LOAD', `${id}: plugin manifest is invalid`, {
          detail: { id, reason: 'plugin-manifest' },
        })
      }
      const rel =
        typeof pkg.exports === 'string' ? pkg.exports : (pkg.exports?.['.'] ?? pkg.main ?? './index.js')
      if (typeof rel !== 'string')
        throw new HostError('E_EXT_LOAD', `${id}: package entry must be a string`, {
          detail: { id, reason: 'bad-package-entry' },
        })
      const entry = resolveEntry(dir, rel)
      return readNamedExports(id, entry, await loader.import(entry), pluginDeclarations)
    },
  }
}

function packageEntry(id: string, dir: string): string {
  const pkgJson = join(dir, 'package.json')
  if (!existsSync(pkgJson))
    throw new HostError('E_DEP_MISSING', `${id}: package.json not found`, { detail: { id } })
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as {
    name?: unknown
    exports?: Record<string, string> | string
    main?: string
  }
  if (pkg.name !== id)
    throw new HostError('E_EXT_LOAD', `${id}: package manifest name does not match`, {
      detail: { id, reason: 'package-name' },
    })
  const rel = typeof pkg.exports === 'string' ? pkg.exports : (pkg.exports?.['.'] ?? pkg.main ?? './index.js')
  if (typeof rel !== 'string')
    throw new HostError('E_EXT_LOAD', `${id}: package entry must be a string`, {
      detail: { id, reason: 'bad-package-entry' },
    })
  return resolveEntry(dir, rel)
}

/**
 * Where a builtin package lives. The plan sketch resolved `${id}/package.json`, but no package in
 * this repository exports that subpath, so the resolve always threw ERR_PACKAGE_PATH_NOT_EXPORTED
 * and every builtin silently fell through to the data-dir fallback -- a wrong directory, not a
 * refusal. Resolve the package entry instead (the `.` export; jiti eats the ts this lands on) and
 * walk up to the nearest package.json whose `name` is the id. A builtin that cannot be located is
 * E_DEP_MISSING: booting against the wrong directory is worse than refusing to boot.
 */
function builtinDir(require: ReturnType<typeof createRequire>, id: string): string {
  let entry: string
  try {
    entry = require.resolve(id)
  } catch {
    throw new HostError('E_DEP_MISSING', `${id}: builtin package is not installed`, { detail: { id } })
  }
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    const pkgJson = join(dir, 'package.json')
    if (existsSync(pkgJson)) {
      try {
        if ((JSON.parse(readFileSync(pkgJson, 'utf8')) as { name?: string }).name === id) return dir
      } catch {
        // A package.json that does not parse cannot attest a name; keep walking.
      }
    }
    if (dirname(dir) === dir) break
  }
  throw new HostError('E_DEP_MISSING', `${id}: no package.json named ${id} above its resolved entry`, {
    detail: { id },
  })
}

/**
 * The directory every enabled package is imported from (Task 24 Step 8): builtins resolve to the
 * copy shipped with this installation, workspace entries resolve under the lock's workspace path,
 * and everything else lands in the per-profile packages cache. Locations only -- which packages may
 * run is decided by profile.packages, not by this map.
 */
export function packageDirs(
  profile: ResolvedProfile,
  opts: { dataDir: string; profileDir: string; lock: Lockfile; hostRoot: string },
): Map<string, string> {
  const require = createRequire(join(opts.hostRoot, 'package.json'))
  const out = new Map<string, string>()
  for (const p of profile.packages) {
    if (!p.enabled) continue
    const entry = opts.lock.packages[p.id]
    if (p.trust === 'builtin' && (!entry || entry.source.type === 'npm')) {
      out.set(p.id, builtinDir(require, p.id))
      continue
    }
    // Unreachable today: lockState refuses any lock carrying a workspace section (fail-closed), so
    // no boot path can hand packageDirs one. Kept per the plan sketch, against Task 17 landing.
    if (entry?.source.type === 'workspace' && opts.lock.workspace)
      out.set(
        p.id,
        resolve(opts.profileDir, opts.lock.workspace.path, entry.source.ref.slice('workspace:'.length)),
      )
    else out.set(p.id, packageDir(opts.dataDir, profile.name, p.id))
  }
  return out
}
