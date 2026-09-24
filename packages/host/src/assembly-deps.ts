import type { KernelOptions, Provider } from '@agnes/core'
import type { Logger } from '@agnes/extension-api'
import type { RuntimePluginSnapshot } from '@agnes/package-manager'
import type { HostPluginImporterFactory, PackageSnapshotVerifier } from '@agnes/plugin-runtime/host'
import type { SkillCordisService } from '@agnes/resource-control-runtime'
import type { PlatformBackend, Prompter } from './adapters/index.js'
import type { OrdinaryPluginLayers } from './assemble/ordinary-rows.js'
import type { PackageLoader } from './assemble/packages.js'
import type { ProviderBuildOptions } from './assemble/provider.js'
import type { AuditSink } from './audit.js'
import type { HostLockedPackageMutationOptions } from './computer-use/locked-package-mutation-runtime.js'
import type { ExtensionActivationBarrier } from './ext-host/activation-barrier.js'
import type { ExtensionIsolationServices } from './ext-host/extension-isolation-selector.js'
import type { ExtensionIsolationOptions } from './ext-host/hooks-isolation-assembly.js'
import type { ServiceAuthority } from './ext-host/service-invocation.js'
import type { ResolvedProfile } from './profile/types.js'
import type { SkillRuntimeInput } from './resources/skills.js'
import type { TrajectoryAssemblyOptions } from './trajectory-contract.js'
import type { WorkspaceInvocationResolver } from './workspace-invocation-resolver.js'

export type HostPaths = { dataDir: string; profileDir: string; workspaceRoot: string; hostRoot: string }

export type AssembleDeps = HostPaths &
  TrajectoryAssemblyOptions & {
    homeDir?: string
    loader: PackageLoader
    packageDirs?: Map<string, string>
    extensionLoader?: { import(file: string): Promise<Record<string, unknown>> }
    audit: AuditSink
    log: Logger
    prompter?: Prompter
    signal?: AbortSignal
    clock?: () => number
    netFetch?: KernelOptions['netFetch']
    /** Host-owned lookup of the currently published runtime for already-open Core sessions. */
    currentRuntime?: KernelOptions['currentRuntime']
    publicFetch?: KernelOptions['publicFetch']
    seamTimeoutMs?: number
    platform?: PlatformBackend
    /** Trusted Node runtime for Windows process brokers when the host runs inside SEA. */
    windowsNodeExecutable?: string
    crashAt?: string
    providerFactory?: (p: ResolvedProfile, opts: ProviderBuildOptions) => Provider
    /**
     * Session workers may assemble without provider.routes so plugin apply can boot. CLI print/TUI
     * omit this and still fail closed at materializeRoutes.
     */
    allowUnresolvedProvider?: boolean
    /** Package-backed ordinary plugin importer; receives only a restricted third-party factory. */
    pluginImporter?: HostPluginImporterFactory
    /** Host-owned authority for installed immutable package snapshots. */
    pluginSnapshots?: PackageSnapshotVerifier
    /** PackageManager-owned immutable snapshots selected for this Host generation. */
    runtimePluginSnapshots?: readonly Readonly<RuntimePluginSnapshot>[]
    /** Complete immutable snapshot catalogue available to later RuntimeTarget candidates. */
    runtimePluginCatalogue?: readonly Readonly<RuntimePluginSnapshot>[]
    /** Installed snapshots re-read before each target is applied, so a package trusted after boot can load. */
    runtimePluginSources?: () => Promise<readonly Readonly<RuntimePluginSnapshot>[]>
    /** How long one row may take to mount before the delivery is failed. Defaults to 30 seconds. */
    ordinaryStartTimeoutMs?: number
    /** Packages whose legacy extensions are restored by the worker activation pipeline. */
    managedExtensionPackageIds?: readonly string[]
    /** Static deployment/user/workspace config layers compiled by the sole ordinary-row builder. */
    ordinaryPluginLayers?: OrdinaryPluginLayers
    env?: NodeJS.ProcessEnv
    extensionIsolation?: ExtensionIsolationOptions
    extensionIsolationServices?: ExtensionIsolationServices
    serviceAuthority?: ServiceAuthority
    /** Trusted deployment coordinator boundary; never exposed to extension code. */
    activationBarrier?: ExtensionActivationBarrier
    /** Host-private per-session workspace invocation lookup. Direct assemble() tests may omit it. */
    workspaceInvocationFor?: WorkspaceInvocationResolver
    /** Exact active session policy; installation fails closed when unavailable. */
    workspacePolicyDigestFor?: (sessionKey: string) => string | undefined
    /** Host-local resolved Skill snapshot. The daemon supplies it; PackageManager never does. */
    skillResources?: SkillRuntimeInput
    /** Request-only daemon bridge. Never a resource-admin client or authority. */
    mcpManage?: import('./resources/mcp-manage-port.js').McpManageBridge
    pluginManage?: import('./resources/plugin-manage-port.js').PluginManageBridge
    skillInstall?: import('./resources/skill-install-port.js').SkillInstallBridge
    /**
     * Cordis contribution port for the same registry that produced `skillResources`.
     * Plugins call it during apply; consumers keep using `skillResources`.
     */
    skillContribution?: SkillCordisService
    /**
     * Trusted Host-owned media composition. The caller must supply explicit, reviewed byte/pixel
     * limits; Host deliberately has no product defaults until P0 evidence freezes them. Omission
     * preserves the legacy text-only path, and cannot mint auxiliary-vision admission.
     */
    requestMedia?: KernelOptions['requestMedia']
    /** Trusted production mutation ports. Omission leaves locked-package mutation fail closed. */
    lockedPackageMutations?: HostLockedPackageMutationOptions
  }
