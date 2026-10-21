import type { JsonValue } from '@agnes/protocol'
import type { SandboxEnforcement } from './common.js'
import type { RemoteTransport } from './remote-transport.js'

/** Operating systems a provider can actually run on. */
export type SandboxPlatform = 'darwin' | 'linux' | 'win32'

/** One directory a provider will allow a command to write. */
export type SandboxFsWriteScope = Readonly<{
  /** Absolute host path. Descendants are included. */
  path: string
}>

/**
 * What this provider will really do.
 * A missing piece is false or empty. Callers must not treat that as success.
 */
export type SandboxCapabilities = Readonly<{
  /** True only when a call can ask for network access and receive it. */
  network: boolean
  /** Supports bounded JSON request/reply on an owned process pipe. */
  programmatic?: boolean
  /** Understands SHELL_STDIN_SENTINEL in openProcess using its configured shell. */
  shellStdin?: boolean
  /** Write roots this provider enforces. Empty means writes are not confined. */
  fsWrite: readonly SandboxFsWriteScope[]
  platform: readonly SandboxPlatform[]
  /** False when the provider cannot run commands. Exec must refuse. */
  available: boolean
  /** Static support; absence is unknown, never permission to run without isolation. */
  l1Implementation?: 'implemented' | 'unimplemented' | 'unknown'
  unavailableReason?: string
  /** Enforcement the provider can guarantee for requested policies; absent means unproven. */
  enforcement?: SandboxEnforcement
}>

export type SandboxExecLimits = Readonly<{
  timeoutMs?: number
  maxOutputBytes?: number
}>

/** Host-authorized process policy for this call. Denies override allowed roots. */
export type SandboxExecutionPolicy = Readonly<{
  workspaceRoot: string
  digest: string
  fsRead: Readonly<{ allow: readonly string[]; deny: readonly string[] }>
  fsWrite: Readonly<{ allow: readonly string[]; deny: readonly string[] }>
  network: Readonly<{ mode: 'deny' | 'allow' | 'hosts' | 'loopback-serve'; hosts: readonly string[] }>
  /** Minimum enforcement; a provider must refuse before execution when it cannot supply it. */
  requiredEnforcement: SandboxEnforcement
}>

/** One command. The provider spawns it and owns the process. */
export type SandboxExecRequest = Readonly<{
  argv: readonly string[]
  /** Execution directory snapshot at the start of this call (or the explicitly requested operation).
   * May differ from workspaceRoot in a future version; use workspaceRoot for workspace-owned state, policy and config.
   * Session defaults currently equal workspaceRoot; explicit process/child overrides do not change workspace identity.
   */
  cwd: string
  env?: Readonly<Record<string, string>>
  stdin?: string
  /** Optional bounded JSON transport; unsupported providers must refuse before spawning. */
  bridge?: (frame: unknown) => Promise<unknown>
  limits?: SandboxExecLimits
  signal?: AbortSignal
  /** Required on the Host path; direct unbound calls must refuse. */
  policy?: SandboxExecutionPolicy
  /** Enforcement already applied by the Host OS compiler, when present. */
  enforcement?: SandboxEnforcement
  /**
   * Write roots for this call. A provider that cannot enforce a non-empty
   * scope must refuse. It must not run the command and claim the scope held.
   */
  fsWrite?: readonly SandboxFsWriteScope[]
  /** Ask to initiate network connections. Inbound-only loopback serving is carried by policy.
   * A provider with `network: false` must refuse this flag. */
  network?: boolean
}>

export type SandboxExecResult = Readonly<{
  code: number
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  signal?: string
  stoppedProcesses?: number
  /** Actual confinement, never inferred from a provider id. */
  enforcement: SandboxEnforcement
}>

export interface SandboxProviderInstance {
  readonly id: string
  readonly capabilities: SandboxCapabilities
  exec(request: SandboxExecRequest): Promise<SandboxExecResult>
  /** Optional streaming pipe/PTY entry. Missing means unsupported, never an unconfined fallback. */
  openProcess?: import('./process.js').OpenProcess
  /** Stop every process this instance started. */
  dispose(): void | Promise<void>
}

export type SandboxProviderConfig = Readonly<{
  /** Workspace the host already authorized, when it has one. */
  workspaceRoot?: string
  /** Provider-specific strings, such as a container image. */
  options?: Readonly<Record<string, string>>
}>

/** What the Host hands a remote provider when it opens the channel. The Host owns the result. */
export type SandboxTransportContext = Readonly<{
  /** Resolves a secret reference the deployment configured; the provider never sees the store. */
  secret(ref: string): string
  dataDir: string
  signal: AbortSignal
}>

/**
 * A replaceable sandbox backend. Register it through a plugin that injects
 * `providers`. The host picks one id at startup. Changing the id needs
 * a process restart. Instances are workspace/configuration scoped; running processes stay where they started.
 */
export interface SandboxProvider {
  readonly id: string
  readonly version: string
  readonly capabilities: SandboxCapabilities
  /** Measure the host again. Do not turn a failed probe into a working flag. */
  probe?(signal?: AbortSignal): Promise<SandboxCapabilities> | SandboxCapabilities
  create(
    config: SandboxProviderConfig,
    signal?: AbortSignal,
  ): SandboxProviderInstance | Promise<SandboxProviderInstance>
  /**
   * Present only on a provider whose commands run on another machine. The Host opens the channel
   * once, early in assembly, from the package config of the package that exports this provider,
   * and keeps it: the Host's own exec gate, file policy and workspace fence run over it, so
   * `create` is not what carries commands for such a provider.
   */
  openTransport?(
    config: Readonly<Record<string, JsonValue>>,
    ctx: SandboxTransportContext,
  ): Promise<RemoteTransport>
  cleanup?(): void | Promise<void>
}

export type SandboxProviderCatalogEntry = Readonly<{
  id: string
  version: string
  sourcePackage: string
  capabilities: SandboxCapabilities
  /** The running process keeps the provider it selected at startup. */
  restartRequired: true
}>

/**
 * First element of the argv a tool hands to `exec`. It is a placeholder, not a program: the sandbox
 * shell replaces it with the interpreter the deployment chose, so the tool's schema stays identical
 * everywhere. The command line stays one argv element, exactly as the model wrote it.
 */
export const SHELL_SENTINEL = '$SHELL'
/** Open a persistent configured shell reading commands from stdin; openProcess only. */
export const SHELL_STDIN_SENTINEL = '$SHELL_STDIN'

/** Built-in host sandbox. Seatbelt, bubblewrap, or the current Windows posture. */
export const LOCAL_SANDBOX_PROVIDER_ID = 'local'

export function sandboxUnavailable(reason: string): Error & { code: 'SANDBOX_UNAVAILABLE' } {
  return Object.assign(new Error(`SANDBOX_UNAVAILABLE: ${reason}`), {
    code: 'SANDBOX_UNAVAILABLE' as const,
  })
}

export const SANDBOX_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const SANDBOX_PLATFORMS: readonly string[] = ['darwin', 'linux', 'win32']

/** Structural check of a capability report; a failed probe must not turn into working flags. */
export function validSandboxCapabilities(capabilities: SandboxCapabilities | undefined): boolean {
  if (
    !capabilities ||
    typeof capabilities.network !== 'boolean' ||
    typeof capabilities.available !== 'boolean' ||
    (capabilities.l1Implementation !== undefined &&
      !['implemented', 'unimplemented', 'unknown'].includes(capabilities.l1Implementation)) ||
    (capabilities.programmatic !== undefined && typeof capabilities.programmatic !== 'boolean') ||
    (capabilities.shellStdin !== undefined && typeof capabilities.shellStdin !== 'boolean')
  )
    return false
  const enforcement = capabilities.enforcement
  if (
    enforcement &&
    (!['none', 'partial', 'full'].includes(enforcement.level) ||
      !Array.isArray(enforcement.scope) ||
      enforcement.scope.some((scope) => !['file', 'network', 'process'].includes(scope)))
  )
    return false
  if (!Array.isArray(capabilities.platform) || !Array.isArray(capabilities.fsWrite)) return false
  if (capabilities.platform.some((platform) => !SANDBOX_PLATFORMS.includes(platform))) return false
  return capabilities.fsWrite.every((scope) => typeof scope?.path === 'string' && scope.path.length > 0)
}

/** Catalog atoms for a capability report: network, writable roots and platforms. */
export function sandboxCapabilityNames(capabilities: SandboxCapabilities): string[] {
  const names: string[] = []
  if (capabilities.network) names.push('network')
  for (const scope of capabilities.fsWrite) names.push(`fsWrite:${scope.path}`)
  for (const platform of capabilities.platform) names.push(`platform:${platform}`)
  return names
}
