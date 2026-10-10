import type {
  BeforeCompactPayload,
  CompactionPlan,
  Enforcement,
  Operation,
  RemoteTransport,
  SandboxExecBackend,
  SandboxSeam,
  SandboxWorkspaceBackend,
  SeamName,
  WorkspaceHookSandbox,
} from '@agnes/core'
import type {
  CompactionEngine,
  ExtensionAPI,
  ExtensionFactory,
  ExtensionManifest,
  HookInvocationSnapshot,
  Logger,
  PersistenceProvider,
} from '@agnes/extension-api'
import type { PrivacyTrajectoryCapability } from '@agnes/host-artifacts/trajectory-contract'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import type { ComputerUseBackendProvider } from '@agnes/host-computer-use/computer-use/windows-driver-backend'
import type { AgnesPluginManifestEntry, RuntimePluginSnapshot } from '@agnes/package-manager'
import type { PackageSnapshotCandidateRef, VerifiedRowEntry } from '@agnes/plugin-runtime/host'
import type { JsonValue } from '@agnes/protocol'
import type { SkillRuntimeInput } from '@agnes/resource-control-runtime'
import type { SandboxHostServices, SeamAdapters } from './adapters.js'

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
  /** Host-owned Git service, supplied only to the exact bundled subagent factory. */
  gitWorktrees?: import('@agnes/extension-api').GitWorktreeService
  searchProvider?: import('@agnes/extension-api').SearchProvider
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
  /** Daemon job tables, supplied only to agnes/schedule. */
  scheduleTables?: {
    table(name: string): {
      name: string
      exec(sql: string): void
      run(sql: string, params?: readonly unknown[]): { changes: number }
      get<T>(sql: string, params?: readonly unknown[]): T | undefined
      all<T>(sql: string, params?: readonly unknown[]): T[]
      transaction<T>(fn: () => T): T
    }
  }
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
  /** Base planner retained for before_compact compatibility and legacy in-memory package loaders. */
  buildCompactionPlan?: BuildCompactionPlan
  createDefaultCompactionEngine?: (plan: BuildCompactionPlan) => CompactionEngine
  /** Session store published by this package. Host reads it when adapters open, not from `apply()`. */
  persistenceProvider?: PersistenceProvider
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
