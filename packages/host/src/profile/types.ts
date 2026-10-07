import type { SeamName } from '@agnes/core'
import type {
  ApprovalProfile,
  CommandHooksPolicy,
  ExtensionIsolationPolicy,
  ExtensionIsolationRequest,
  JsonValue,
  LoopSelection,
  ReconcilePolicy,
  RouteDecl,
} from '@agnes/protocol'
import type { PresetDoc } from '../presets/types.js'
import type { BundleCatalog, CompositionPatch, CompositionSource } from './composition.js'

/** `^[a-z][a-z0-9.-]{0,63}$` in the profile schema; kept as a string alias here. */
export type Capability = string
export type PackageRef = {
  config?: Record<string, JsonValue>
  id: string
  source: string
  version?: string
  enabled?: boolean
  tombstone?: boolean
}
/** `^secret://<ns>/<name>$`; see adapters/secrets.ts for the pattern that enforces it. */
export type SecretRef = string
export type Transport = {
  kind: 'stdio' | 'unix' | 'ws-tls'
  path?: string
  listen?: string
  tls?: { cert?: SecretRef; key?: SecretRef }
  auth?: {
    sourceAuthSecrets?: SecretRef[]
    rotationGraceMs?: number
    jwt?: { issuer?: string; jwks?: string; secret?: SecretRef }
  }
  artifactsUrl?: string
}
// protocol's own RouteDecl, not a restatement of it. The fields were identical apart from `compat`,
// which this package had typed as Record<string, unknown> while protocol types it as JsonValue - so
// a declaration that resolved here could not be handed to a wire adapter without a cast, and the
// catalogue field (`models`) was simply missing. One declaration, in the package both sides depend
// on, is the whole point of protocol owning it.
export type { ReconcilePolicy, RouteDecl }
export type ProviderConfig = {
  package: string
  adapters?: string[]
  routes?: RouteDecl[]
  /** Additional built-in runtime routes. Omitted keeps the legacy catalogue; [] uses declared routes only. */
  catalog?: { include: string[] }
  contract?: { dir: string; contractIds: string[] }
}
export type AdaptersConfig = {
  storage?: string
  fs?: string
  exec?: string
  platform?: string
  secrets?: { kind: 'file' | 'env' | 'vault'; path?: string }
}
export type Policy = {
  capabilityCeiling?: Capability[]
  workspacePackages?: 'deny' | 'require-project-trust'
}

export type ComputerUseAppIdentity =
  | {
      platform: 'win32'
      executablePath: string
      publisherSha256: string
    }
  | {
      platform: 'win32'
      executablePath: string
      packageFamilyName: string
    }
  | {
      platform: 'darwin'
      bundleId: string
      teamId: string
      signatureSha256: string
    }
  | {
      platform: 'linux'
      desktopId: string
      executablePath: string
      installSource: string
    }

export type ComputerUseCapturePolicy = {
  allowFullDesktop?: boolean
  maxImageDimension?: number
  maxBytesPerImage?: number
  maxImagesPerResult?: number
  maxImagesPerMutationResult?: number
  maxImagesPerModelRequest?: number
  maxCapturesPerHour?: number
}

export type ComputerUseRetentionPolicy = {
  maxRecentPerSession?: number
  ttlMs?: number
  gcIntervalMs?: number
  maxExtendedTtlMs?: number
  globalMaxBytes?: number
}

export type ComputerUseProfile = {
  enabled?: boolean
  appAccess?: 'allowlist' | 'all'
  appAllowlist?: readonly ComputerUseAppIdentity[]
  capture?: ComputerUseCapturePolicy
  retention?: ComputerUseRetentionPolicy
}

export type ResolvedComputerUseProfile = {
  enabled: boolean
  appAccess: 'allowlist' | 'all'
  appAllowlist: readonly ComputerUseAppIdentity[]
  capture: Readonly<Required<ComputerUseCapturePolicy>>
  retention: Readonly<Required<ComputerUseRetentionPolicy>>
}

export type RuntimeProfileManifest = {
  bundles?: string[]
  composition?: CompositionPatch
  name: string
  schemaVersion?: number
  loop?: LoopSelection
  extends?: string
  packages?: PackageRef[]
  seams?: Partial<Record<SeamName, string>>
  provider?: ProviderConfig
  adapters?: AdaptersConfig
  transports?: Transport[]
  dataDir?: string
  cacheDir?: string
  limits?: Record<string, number>
  presets?: { default?: string; allowed?: string[] }
  policy?: Policy
  reconcile?: ReconcilePolicy
  approvals?: ApprovalProfile
  computerUse?: ComputerUseProfile
  compaction?: { engine: string }
  commandHooks?: CommandHooksPolicy
  extensionIsolation?: ExtensionIsolationPolicy
  /** Session store id. Only the user profile may set it. The running process keeps the store it opened. */
  persistence?: { provider: string }
  /** Startup sandbox provider. Omitted means the local host sandbox. Restart required. */
  sandbox?: { provider?: string }
}
export type ProfileFragment = {
  packages?: PackageRef[]
  policy?: { capabilityCeiling?: Capability[] }
  /** Repository/workspace layers may only keep or tighten the resolved approval mode. */
  approvals?: { mode: 'manual' | 'smart' }
  /** Repository/workspace layers may only disable or tighten the resolved Computer Use policy. */
  computerUse?: ComputerUseProfile
  extensionIsolation?: ExtensionIsolationRequest
}
export type ManagedPolicy = {
  version: number
  policy: Policy
  packagesDeny?: string[]
  extensionIsolation?: ExtensionIsolationPolicy
}

export type LockPackageState = {
  version: string
  integrity: string
  trust: 'builtin' | 'trusted'
  enabled: boolean
  provides?: readonly SeamName[]
  capabilities?: unknown
  releasedAt?: string
}
export type LockState = {
  packages: Record<string, LockPackageState>
  workspace?: { path: string; hash: string; manifestId: string }
}

export type ProfileInputs = {
  adminBundles?: readonly string[]
  bundleCatalog?: BundleCatalog
  builtin: string
  user?: RuntimeProfileManifest
  workspaceOverlay?: ProfileFragment
  local?: Partial<RuntimeProfileManifest>
  flags?: Partial<RuntimeProfileManifest>
  managed?: ManagedPolicy
  /** Projected from the profile's agnes-lock.json at boot; absent or empty, only builtin packages resolve. */
  lock?: LockState
  /** The package ids shipped with agnes itself; defaults to templates.ts BUILTIN_PACKAGES. */
  builtinPackages?: readonly string[]
}

export type PlatformSnapshot = {
  os: 'darwin' | 'linux' | 'win32'
  arch: string
  capabilities: Record<string, 'full' | 'partial' | 'unavailable'>
}
export type ResolveEnv = {
  platform: PlatformSnapshot
  agnesVersion: string
  now: string
  /**
   * What a leading `~` in a profile path means. Defaults to the account's home directory; passed in
   * so a test can exercise the unconfigured default without writing into the developer's own home,
   * which is the one place a test must never touch.
   */
  homeDir?: string
}

export type ResolvedPackage = {
  config?: Record<string, JsonValue>
  id: string
  version: string
  source: string
  integrity: string
  trust: 'builtin' | 'trusted'
  enabled: boolean
  provides?: SeamName[]
}
export type ResolvedProfile = Readonly<{
  adminBundles?: readonly string[]
  bundles?: string[]
  composition?: CompositionPatch
  compositionSources?: Readonly<Record<string, CompositionSource>>
  bundleCatalog?: BundleCatalog
  bundlePresets?: Record<string, PresetDoc>
  name: string
  schemaVersion: number
  loop?: LoopSelection
  chain: string[]
  packages: ResolvedPackage[]
  seams: Record<SeamName, string>
  provider: Required<Pick<ProviderConfig, 'package' | 'adapters'>> &
    Pick<ProviderConfig, 'routes' | 'catalog' | 'contract'>
  adapters: {
    storage: string
    fs: string
    exec: string
    platform: string
    secrets: { kind: 'file' | 'env' | 'vault'; path?: string }
  }
  transports: Transport[]
  dataDir: string
  cacheDir: string
  limits: Record<string, number>
  presets: { default: string; allowed: string[] }
  policy: { capabilityCeiling: Capability[]; workspacePackages: 'deny' | 'require-project-trust' }
  reconcile: ReconcilePolicy
  approvals: ApprovalProfile
  computerUse: ResolvedComputerUseProfile
  compaction?: { engine: string }
  commandHooks?: CommandHooksPolicy
  extensionIsolation?: ExtensionIsolationPolicy
  /** Present only when the selected provider is not the built-in `sqlite` id. Changing it is restart-required. */
  persistence?: { provider: string }
  /** Present only when the profile names a provider. The default local id is applied at startup. */
  sandbox?: Readonly<{ provider: string }>
  runtimes: ('python' | 'typescript')[]
  hash: string
}>
