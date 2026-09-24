import type { ApprovalRequest, Enforcement, PlatformSeam, SandboxSeam, Verdict } from '@agnes/core'
import type { FsEntry, FsStat, Logger, SessionRef } from '@agnes/extension-api'
import type { ComputerUseBackendProvider } from '../extensions/computer-use/src/backend.js'
import type { ComputerUseToolOptions } from '../extensions/computer-use/src/tool.js'
import type { EgressGate } from '../extensions/privacy/src/index.js'
import type { SkillRuntimeDiscovery, SkillRuntimeInput } from '../extensions/skills/src/runtime.js'

/**
 * What a seam implementation in this package is handed at assembly. base cannot import the host,
 * so the shape is restated here as a consumption contract: the host's real object has to be
 * assignable to it. That direction is asserted, not assumed - see the host-side compatibility
 * test, which is the only thing keeping the two spellings from drifting.
 *
 * Every member below is narrowed to what a seam is allowed to reach, never widened. The host hands
 * over a platform backend that knows its own OS and can kill a process tree; a seam gets the four
 * question-asking methods of PlatformSeam and nothing else.
 */

/**
 * One table connection's worth of SQL. `name` is the table the handle was asked for; it is
 * advisory, because the statement text names its own table and the underlying connection carries
 * every table the same owner created.
 *
 * `params` is readonly because the host's binder does not write to it, and a seam holding a
 * readonly array should not have to copy to pass it. Strings containing NUL are refused because
 * SQLite defines TEXT expression semantics for them as undefined; use `Uint8Array` for arbitrary
 * bytes.
 */
export type TableHandle = {
  name: string
  exec(sql: string): void
  run(sql: string, params?: readonly unknown[]): { changes: number }
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined
  transaction<T>(fn: () => T): T
}

/**
 * The file methods, each fenced by whoever built the handle. A seam sees no fence policy and
 * cannot widen one: a path outside the handle's root is refused by the implementation.
 */
export type HostFs = {
  realpath(p: string): Promise<string>
  read(p: string, opts?: { offset?: number; limit?: number }): Promise<Uint8Array>
  write(p: string, data: Uint8Array): Promise<void>
  stat(p: string): Promise<FsStat>
  list(p: string): Promise<FsEntry[]>
  mkdir(p: string): Promise<void>
  rm(p: string, opts?: { recursive?: boolean }): Promise<void>
}

export type HostExecResult = {
  code: number
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  signal?: string
}

/**
 * The binding a sandbox seam's exec request carries: the digest of the policy the request was
 * decided under and the backend the seam believes it has. The host's policy-bound exec checks both
 * against its own bound state before spawning; a request without a valid binding is denied.
 */
export type SandboxExecBinding = { policyDigest: string; backend: 'none' | 'l1' }

export type HostExec = (
  argv: string[],
  opts: {
    cwd: string
    env?: Record<string, string>
    stdin?: string
    timeoutMs?: number
    signal?: AbortSignal
    maxOutputBytes?: number
    sandbox?: SandboxExecBinding
  },
) => Promise<HostExecResult>

/** What the seam declared about its process isolation at init; the host enforces it on every spawn. */
export type SandboxGateState = { backend: 'none' | 'l1'; onUnavailable: 'deny' | 'allow' }
export type SandboxBackendReport = Readonly<{
  name: 'none' | 'bwrap' | 'seatbelt'
  enforcement: Enforcement
}>

/**
 * The services only the sandbox factory is ever handed. `pathPolicy.canonicalize` is the host's
 * own filesystem canonicalizer - the same path flavor, case semantics and deepest-existing-parent
 * walk the FsOps fence runs - narrowed to producing a canonical name; it executes and authorizes
 * nothing. `probeExec` is a raw spawner whose lifetime ends when the factory returns; it exists so
 * backend detection never requires keeping a raw exec in the seam. `declareExecGate` is how the
 * seam states its process-isolation posture, and `binding` is how it learns whether the host has
 * actually bound the policy it compiled - enforcement() may not claim what this says has not
 * happened.
 */
export type SandboxHostServices = {
  shellCommand?: (command: string) => string[]
  pathPolicy: { canonicalize(path: string, opts?: { base?: string }): Promise<string> }

  probeExec: HostExec
  declareExecGate(state: SandboxGateState): void
  reportBackend(report: SandboxBackendReport): void
  binding(): { policyDigest: string | null }
}

/** The way to put a question to whoever is connected. The deadline travels on the signal. */
export type Prompter = { ask(req: ApprovalRequest, opts: { signal: AbortSignal }): Promise<Verdict> }

/**
 * Two file handles, not one, and they are fenced at different roots. `fs` is the workspace: it is
 * what a tool or a seam reaching for the user's project uses, and it refuses everything outside
 * workspaceRoot. `dataFs` is this installation's own store under dataDir - artifacts, checkpoints,
 * a seam's own files - which on a normal machine is `~/.agh` and therefore outside the workspace
 * and unreachable through `fs`.
 */
export type SeamAdaptersView = {
  fs: HostFs
  dataFs: HostFs
  exec: HostExec
  platform: PlatformSeam
  storage: { table(name: string): TableHandle }
  prompter?: Prompter
}

/** Seven fields. A seam reads the two or three it needs; none of them has a safe default. */
export type SeamProfileView = {
  name: string
  resolvedProfileHash: string | null
  dataDir: string
  workspaceRoot: string
  homeDir: string
  limits: Record<string, number>
  preset: Record<string, unknown>
}

export type SeamInitContext = {
  /** Deployment grants, supplied only to the exact bundled hooks-runner factory. */
  trustedHookCommands?: Readonly<{
    allowsUnconfined(source: 'data' | 'workspace', configDigest: string): boolean
  }>
  secrets(ref: string): string
  adapters: SeamAdaptersView
  profile: SeamProfileView
  log: Logger
  signal: AbortSignal
  /** Exact bundled artifacts seam only: creates immutable CU bytes with native private permissions. */
  privateArtifactStore?: Readonly<{
    put(sha256: string, bytes: Uint8Array): Promise<void>
    putComputerUseMetadata(sha256: string, bytes: Uint8Array): Promise<void>
  }>
  /** Host startup bound for a package seam factory. */
  seamTimeoutMs?: number
  /** Host-owned resource snapshot; Base may consume it but cannot mutate discovery, desired, or trust. */
  skillResources?: SkillRuntimeInput
  /** Safe Skill descriptors for cross-extension discovery (agnes/mcp-search); cannot read a Skill
   *  body. A live view: it follows the Skills generation agnes/skills currently serves. */
  skillDiscovery?: SkillRuntimeDiscovery
  /** Host-owned fixed trajectory operation. The host supplies it only to agnes/privacy. */
  privacyTrajectory?: {
    previous(session: SessionRef, signal: AbortSignal): Promise<string | null>
    upload(
      session: SessionRef,
      gate: EgressGate,
      authority: { assert(gate: EgressGate): void },
      signal: AbortSignal,
    ): Promise<void>
  }
  /** Supplied only to the exact trusted computer-use extension after platform driver admission. */
  computerUseBackendProvider?: ComputerUseBackendProvider
  computerUseOptions?: ComputerUseToolOptions
  /** Present only after seam assembly; ecosystem extensions must not substitute adapters.exec. */
  sandbox?: SandboxSeam
  /** Present only in the context handed to the sandbox factory. A seam that is not sandbox never
   * sees it, and a sandbox seam initialised without it must refuse: the host cannot bind what it
   * cannot canonicalize. */
  sandboxHost?: SandboxHostServices
}

export type SeamFactory<S = unknown> = (ctx: SeamInitContext) => Promise<S>
