import type {
  BeforeCompactPayload,
  CompactionPlan,
  Enforcement,
  Operation,
  SandboxExecBackend,
  SandboxSeam,
  SandboxWorkspaceBackend,
  SeamName,
  WorkspaceHookSandbox,
} from '@agnes/core'
import type {
  ChildControlStore,
  CompactionEngine,
  ExtensionManifest,
  HookInvocationSnapshot,
  Logger,
  PersistenceProvider,
  SandboxProvider,
} from '@agnes/extension-api'
import type { ExtensionAPI, ExtensionFactory } from '@agnes/extension-api/host'
import type { PrivacyTrajectoryCapability } from '@agnes/host-artifacts/trajectory-contract'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import type { ComputerUseBackendProvider } from '@agnes/host-computer-use/computer-use/windows-driver-backend'
import type { AgnesPluginManifestEntry, RuntimePluginSnapshot } from '@agnes/package-manager'
import type { PackageSnapshotCandidateRef, VerifiedRowEntry } from '@agnes/plugin-runtime/host'
import type { JsonValue } from '@agnes/protocol'
import type { SkillRuntimeInput } from '@agnes/resource-control-runtime'
import type { SeamAdapters } from './adapters.js'

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
export type SkillRuntimeDiscovery = Readonly<
  Pick<BoundSkillRuntimeInput, 'list' | 'runInWorkspace' | 'invocation'>
>

/** Volatile background work; observation never replays history or opens a turn. */
export interface SessionTasks {
  watch(
    session: import('@agnes/extension-api').SessionRef,
    listener: (event: {
      turn: number
      reason: string
      messages: Array<{ role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }> }>
    }) => void,
  ): () => void
  generate(
    session: import('@agnes/extension-api').SessionRef,
    input: {
      turn: number
      label: string
      system: string
      messages: Array<{ role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }> }>
    },
    signal: AbortSignal,
  ): Promise<string | undefined>
  /**
   * Bounded read-only review of the live conversation, allowed while a turn is running (unlike
   * `generate`). Uses the verifier slot, else fast, never the primary model; about 300 output
   * tokens; resolves `undefined` when no auxiliary model is configured, the session is closed, the
   * budget refuses it or the deadline passes. `data` is untrusted text appended to the request.
   */
  review(
    session: import('@agnes/extension-api').SessionRef,
    input: { label: string; system: string; data: string; timeoutMs?: number },
    signal: AbortSignal,
  ): Promise<string | undefined>
}

export type SeamInitContext = {
  sessionTasks?: SessionTasks
  searchProvider?: import('@agnes/extension-api').SearchProvider
  /** Deployment grants, supplied only to the exact bundled hooks-runner factory. */
  trustedHookCommands?: Readonly<{
    allowsUnconfined(source: 'data' | 'workspace', configDigest: string, workspaceRoot?: string): boolean
  }>
  secrets(ref: string): string
  adapters: SeamAdapters
  profile: SeamProfileView
  log: Logger
  signal: AbortSignal
  /** Exact bundled artifacts seam only; Host constructs the path from the digest. */
  privateArtifactStore?: Readonly<{
    put(sha256: string, bytes: Uint8Array): Promise<void>
    putStream?(
      sha256: string,
      size: number,
      source: AsyncIterable<Uint8Array>,
      signal: AbortSignal,
    ): Promise<void>
    putComputerUseMetadata(sha256: string, bytes: Uint8Array): Promise<void>
  }>
  /** Host startup bound for a package seam factory. */
  seamTimeoutMs?: number
  /** Privileged resource snapshot, supplied only to the bundled skills ecosystem factory. */
  skillResources?: BoundSkillRuntimeInput
  /** Safe descriptors, supplied to agnes/mcp-search without Skill-body access. A live view of the
   *  Skills generation agnes/skills currently serves. */
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
  /** Primary-key child-control calls for subagent worktree binding, supplied only to `@agnes/base`. */
  childControl?: Readonly<{
    lookupByKey: ChildControlStore['lookupByKey']
    updateWorkspace: NonNullable<ChildControlStore['updateWorkspace']>
  }>
  /** Available to ecosystem extensions after the seam phase, never a raw exec substitute. */
  sandbox?: SandboxSeam
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
/** An Operation needs assembly-time dependencies, so a package exports factories. */
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
  onUnavailable: 'deny' | 'allow' | 'allow-if-unimplemented'
  platform?: string
  shell: 'posix' | 'powershell'
  options: {
    cwd: string
    allowPaths: readonly string[]
    denyPaths: readonly string[]
    networkAllow: readonly string[]
    loopbackServe?: boolean
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
      implementation?: 'implemented' | 'unimplemented' | 'unknown'
      probeState?: 'ready' | 'failed' | 'unprobed'
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
  /**
   * A sandbox provider this package supplies. The Host reads it before the tree exists, because a
   * provider with `openTransport` must open its channel during adapter assembly, then registers it
   * in the `sandbox` catalog under this package.
   */
  sandboxProvider?: SandboxProvider
  /** Package-owned backend compiler; Host supplies and retains the only raw probe capability. */
  sandboxWorkspaceProbe?: SandboxWorkspaceProbeFactory
  sandboxImplementation?: (platform: string) => 'implemented' | 'unimplemented' | 'unknown'
  id: string
  /** Host-private Cordis exports declared by this package's unique static plugin manifest. */
  plugins?: readonly Readonly<{
    declaration: Readonly<AgnesPluginManifestEntry>
    entry: VerifiedRowEntry
    /** Present only when this export came from an immutable PackageManager runtime snapshot. */
    candidate?: Readonly<PackageSnapshotCandidateRef>
    snapshotDigest?: string
  }>[]
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
