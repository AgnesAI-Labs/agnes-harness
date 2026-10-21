import { SEAM_NAMES, type SeamName } from '@agnes/core'
import type { ProviderSelection } from '@agnes/extension-api'
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
import type { Permission } from '../presets/permission.js'
import type { PresetDoc } from '../presets/types.js'
import type {
  BundleCatalog,
  CompositionPatch,
  CompositionSource,
  ResolvedComposition,
} from './composition.js'
import type { ProviderSelections } from './provider-selection.js'

/** `^[a-z][a-z0-9.-]{0,63}$` in the profile schema; kept as a string alias here. */
/**
 * The seven kinds a profile must select. `sandbox` is selected like any other provider kind and
 * `platform` is owned by the Host.
 */
export const PROFILE_SEAM_NAMES = SEAM_NAMES.filter(
  (name): name is ProfileSeamName => name !== 'sandbox' && name !== 'platform',
)
export type ProfileSeamName = Exclude<SeamName, 'sandbox' | 'platform'>

/** Keys that cannot be selected under `providers`, with what to do instead. */
export const REMOVED_SEAM_KEYS = Object.freeze({
  platform: 'platform is owned by the Host and cannot be selected; delete the key',
} as const)

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
  extends?: string
  packages?: PackageRef[]
  /** The one selection table: `providers.<kind>: { provider, version? }` for every provider kind. */
  providers?: ProfileProviders
  provider?: ProviderConfig
  adapters?: AdaptersConfig
  transports?: Transport[]
  dataDir?: string
  cacheDir?: string
  limits?: Record<string, number>
  presets?: { default?: string; allowed?: string[] }
  permissions?: { default?: Permission; allowed?: Permission[] }
  policy?: Policy
  reconcile?: ReconcilePolicy
  approvals?: ApprovalProfile
  computerUse?: ComputerUseProfile
  commandHooks?: CommandHooksPolicy
  extensionIsolation?: ExtensionIsolationPolicy
  /** Options of the selected sandbox provider. The provider itself is `providers.sandbox`. */
  sandbox?: { options?: Readonly<Record<string, string>> }
}
/**
 * What a profile layer may select. The seven seam kinds are required once layers are merged;
 * `persistence` may only be set by the user profile; `persistence` and `sandbox` need a restart.
 */
export type ProfileProviders = Partial<Record<ProfileSeamName, ProviderSelection>> & ProviderSelections
export type ProfileFragment = {
  packages?: PackageRef[]
  policy?: { capabilityCeiling?: Capability[] }
  /** Repository/workspace layers may only keep or tighten the resolved approval mode. */
  approvals?: { mode: 'manual' }
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
  source?: { type: string; ref: string }
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
  /** Host-compiled tool ownership; never a deployment manifest input. */
  compositionToolScope?: ResolvedComposition['toolScope']
  /** Host-compiled session overlays; never a deployment manifest input. */
  sessionComposition?: Readonly<{
    bundles?: readonly string[]
    loop?: import('@agnes/protocol').LoopSelection
  }>
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
  seams: Record<ProfileSeamName, ProviderSelection>
  /** The selections the profile authored for the kinds that are not seams. */
  providers?: ProviderSelections
  provider: { package: string; adapters: string[] } & Pick<ProviderConfig, 'routes' | 'catalog' | 'contract'>
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
  /** Permission defaults and grants, independent of the recipe catalogue. */
  permissions?: { default: Permission; allowed: Permission[] }
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
  sandbox?: Readonly<{ provider: string; options?: Readonly<Record<string, string>> }>
  runtimes: ('python' | 'typescript')[]
  hash: string
}>
