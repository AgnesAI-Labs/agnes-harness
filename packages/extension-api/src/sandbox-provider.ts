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
  /** Write roots this provider enforces. Empty means writes are not confined. */
  fsWrite: readonly SandboxFsWriteScope[]
  platform: readonly SandboxPlatform[]
  /** False when the provider cannot run commands. Exec must refuse. */
  available: boolean
  unavailableReason?: string
}>

export type SandboxExecLimits = Readonly<{
  timeoutMs?: number
  maxOutputBytes?: number
}>

/** One command. The provider spawns it and owns the process. */
export type SandboxExecRequest = Readonly<{
  argv: readonly string[]
  cwd: string
  env?: Readonly<Record<string, string>>
  stdin?: string
  limits?: SandboxExecLimits
  signal?: AbortSignal
  /**
   * Write roots for this call. A provider that cannot enforce a non-empty
   * scope must refuse. It must not run the command and claim the scope held.
   */
  fsWrite?: readonly SandboxFsWriteScope[]
  /** Ask for network. A provider with `network: false` must refuse. */
  network?: boolean
}>

export type SandboxExecResult = Readonly<{
  code: number
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  signal?: string
}>

export interface SandboxProviderInstance {
  readonly id: string
  readonly capabilities: SandboxCapabilities
  exec(request: SandboxExecRequest): Promise<SandboxExecResult>
  /** Stop every process this instance started. */
  dispose(): void | Promise<void>
}

export type SandboxProviderConfig = Readonly<{
  /** Workspace the host already authorized, when it has one. */
  workspaceRoot?: string
  /** Provider-specific strings, such as a container image. */
  options?: Readonly<Record<string, string>>
}>

/**
 * A replaceable sandbox backend. Register it through a plugin that injects
 * `sandboxProviders`. The host picks one id at startup. Changing the id needs
 * a process restart. Running processes stay where they started.
 */
export interface SandboxProvider {
  readonly id: string
  readonly version: string
  readonly capabilities: SandboxCapabilities
  /** Measure the host again. Do not turn a failed probe into a working flag. */
  probe?(signal?: AbortSignal): Promise<SandboxCapabilities> | SandboxCapabilities
  create(config: SandboxProviderConfig): SandboxProviderInstance | Promise<SandboxProviderInstance>
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

export interface SandboxProviderRegistration {
  /** Duplicate ids are refused. The disposer is owned by the calling plugin fiber. */
  register(provider: SandboxProvider): () => Promise<void>
  catalog(): readonly SandboxProviderCatalogEntry[]
}

/** Built-in host sandbox. Seatbelt, bubblewrap, or the current Windows posture. */
export const LOCAL_SANDBOX_PROVIDER_ID = 'local'

export function sandboxUnavailable(reason: string): Error & { code: 'SANDBOX_UNAVAILABLE' } {
  return Object.assign(new Error(`SANDBOX_UNAVAILABLE: ${reason}`), {
    code: 'SANDBOX_UNAVAILABLE' as const,
  })
}
