import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type {
  Enforcement,
  FsPolicy,
  FsRule,
  FsRuleSource,
  RemoteTransport,
  SandboxSeam,
  SeamWorkspace,
} from '@agnes/core'
import { validateFsPolicy, WORKSPACE_SECRET_DIRS } from '@agnes/core'

/**
 * This package's own restatement of the assembler's consumption contract - the same pattern
 * `@agnes/base`'s `src/seam-init.ts` already uses for the exact same reason, and the pattern
 * `@agnes/host`'s `src/assemble/packages.ts` uses for the canonical version both restatements
 * describe. `@agnes/core` does not export a `SeamFactory` type or a `SeamInitContext` type - those
 * are host/base-owned assembly concepts, not a core effect - so a package that (by design, see
 * Step 1 of this task's brief) depends on nothing but `@agnes/core` cannot import either name.
 * Restating the handful of fields this seam actually reads keeps the contract checked (the real
 * object the host hands over only has to be *assignable* to this, not identical to it) without
 * pulling in `@agnes/base` or `@agnes/host`, which would both violate the "one package per
 * provider, no host-internal types" requirement (RA16) this package exists to satisfy.
 */
export type RemoteSandboxProfile = Readonly<{
  workspaceRoot: string
  dataDir: string
  homeDir: string
  preset: Record<string, unknown>
}>

/** The exec-gate posture this seam declares. Restated structurally; the host's own definition is
 *  `ExecGateState` in packages/host/src/adapters/exec.ts. */
export type RemoteExecGateState = Readonly<{
  backend: 'none' | 'l1' | 'remote'
  onUnavailable: 'deny' | 'allow'
}>
/** Restated structurally; the host's own definition is `SandboxBackendReport` in
 *  packages/host/src/adapters/platform.ts. */
export type RemoteBackendReport = Readonly<{
  name: 'none' | 'bwrap' | 'seatbelt' | 'remote'
  enforcement: Enforcement
}>

export type RemoteSandboxContext = Readonly<{
  profile: RemoteSandboxProfile
  /** The host's policy-bound exec (`SeamAdapters.exec`, which is `createPolicyExec`'s result). Under
   *  a remote deployment the host has already swapped that gate's `inner` for a transport-backed
   *  runner, so calling this both keeps all four gate checks and lands on the remote host. This seam
   *  must never call the transport's own `exec` for a tool's request: that route has no binding
   *  check, no digest pin and, decisively, no `authorizeCwd` - the compiled file policy below would
   *  then apply to nothing. */
  adapters: Readonly<{
    exec(
      cmd: string[],
      opts: {
        cwd: string
        env?: Record<string, string>
        stdin?: string
        timeoutMs?: number
        signal?: AbortSignal
        maxOutputBytes?: number
        sandbox?: Readonly<{ policyDigest: string; backend: 'none' | 'l1' | 'remote' }>
      },
    ): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }>
  }>
  /** Present only in the context handed to the sandbox factory; consumed structurally (RA16) -
   *  the real value's shape is `SandboxHostServices` (packages/host/src/adapters/index.ts), but
   *  this package never imports that type, only the members it uses. `transport` is a
   *  `RemoteTransport`; it is read here as proof that the host really is in remote mode, not as an
   *  exec route. */
  sandboxHost?: Readonly<{
    transport?: RemoteTransport
    declareExecGate(state: RemoteExecGateState): void
    reportBackend(report: RemoteBackendReport): void
  }>
}>

export type SeamFactory<S> = (ctx: RemoteSandboxContext) => Promise<S>

const fault = (message: string): Error & { code: 'E_SEAM_INIT' } =>
  Object.assign(new Error(`E_SEAM_INIT: ${message}`), { code: 'E_SEAM_INIT' as const })

function assertAbsoluteRemotePath(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
    throw fault(`${what} is not a usable path`)
  // Stage A's remote io is posix-only (spec §7 "远端路径风味"); this compiler shares that
  // assumption rather than inventing a second one.
  if (!posix.isAbsolute(value)) throw fault(`${what} must be an absolute remote path, got ${value}`)
  return posix.normalize(value)
}

function stringList(value: unknown, name: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
    throw fault(`sandbox.${name} is not a string list`)
  return [...value]
}

type RemoteSandboxConfig = Readonly<{
  extraPaths: readonly string[]
  denyPaths: readonly string[]
  networkAllow: readonly string[]
}>

/**
 * Reads this deployment's remote file-policy inputs out of the preset's `sandbox` block. Only the
 * three keys that shape a file policy are read here (`extra_paths` / `deny_paths` /
 * `network_allow`); `level` / `required` / `on_unavailable` govern exec-gate posture (RA7 / RA14 -
 * the adapter layer's `inner` swap and its posture enums), not this seam's file policy compiler,
 * so this function leaves them alone rather than re-validating a block it does not own end to end.
 */
function readRemoteSandboxConfig(preset: Record<string, unknown>): RemoteSandboxConfig {
  const raw = preset.sandbox
  if (raw === undefined) return { extraPaths: [], denyPaths: [], networkAllow: [] }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw fault('sandbox config is not a mapping')
  const cfg = raw as Record<string, unknown>
  return {
    extraPaths: stringList(cfg.extra_paths, 'extra_paths'),
    denyPaths: stringList(cfg.deny_paths, 'deny_paths'),
    networkAllow: stringList(cfg.network_allow, 'network_allow'),
  }
}

function fsRule(effect: FsRule['effect'], path: string, source: FsRuleSource, hard: boolean): FsRule {
  return { effect, path, source, hard }
}

/**
 * Compiles this deployment's remote file policy document - the same rule shape
 * `packages/base/extensions/sandbox/src/policy.ts`'s `resolvePolicy` produces for a local
 * deployment (workspace allow; data dir deny with its tmp subdirectory carved back out as allow;
 * `~/.ssh` and the data secrets directory hard-denied; the workspace's own `.git` and
 * WORKSPACE_SECRET_DIRS hard-denied for host integrity; preset-configured extra allows and deny
 * overrides layered on top) - but over the remote host's absolute paths instead of the local
 * machine's, and without the live filesystem walk `resolvePolicy` uses to canonicalize them.
 *
 * **Remote path contract:** `profile.workspaceRoot` / `dataDir` / `homeDir` are taken
 * to already be canonical absolute paths *on the remote host* once assembly is running this seam
 * in remote mode - the same fields the local seam reads, carrying remote-host meaning instead of
 * local-machine meaning. This seam does not canonicalize them against the live remote filesystem
 * (resolving symlinks, folding case) the way the local seam's `services.pathPolicy.canonicalize`
 * does, for two reasons: first, this package receives no filesystem-capable service in
 * `ctx.sandboxHost` beyond the transport itself (RA15 - the adapter layer opens the channel and
 * derives the remote `FsIo`, this package only gets policy inputs), and second, exactly which
 * remote directory backs `workspaceRoot` is Task 8's session-lifecycle mechanism ("在远端建一个属
 * 于本 session 的目录"), which has not landed as of this task. Where the true remote root comes
 * from is called out in the spec itself as an open boundary for Stage B to resolve; this compiler
 * only guarantees the document it emits is well-formed and internally consistent for whatever
 * already-canonical remote root it is handed.
 *
 * Relative `extra_paths` / `deny_paths` entries are resolved against `workspaceRoot` with a plain
 * POSIX join (`posix.resolve`), not a live-filesystem walk, for the same reason.
 */
function compileRemoteFsPolicy(profile: RemoteSandboxProfile): FsPolicy {
  const workspaceRoot = assertAbsoluteRemotePath(profile.workspaceRoot, 'workspace root')
  const dataDir = assertAbsoluteRemotePath(profile.dataDir, 'data directory')
  const homeDir = assertAbsoluteRemotePath(profile.homeDir, 'home directory')
  const config = readRemoteSandboxConfig(profile.preset ?? {})

  const resolveAgainstWorkspace = (raw: unknown, what: string): string => {
    if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0'))
      throw fault(`${what} is not a usable path`)
    return posix.normalize(posix.resolve(workspaceRoot, raw))
  }

  const rules: FsRule[] = [
    fsRule('allow', workspaceRoot, 'workspace', false),
    fsRule('deny', dataDir, 'data', false),
    fsRule('allow', posix.join(dataDir, 'tmp'), 'data-tmp', false),
    fsRule('deny', posix.join(homeDir, '.ssh'), 'home-ssh', true),
    fsRule('deny', posix.join(dataDir, 'secrets'), 'data-secrets', true),
    fsRule('deny', posix.join(workspaceRoot, '.git'), 'host-integrity', true),
    ...WORKSPACE_SECRET_DIRS.map((dir) =>
      fsRule('deny', posix.join(workspaceRoot, dir), 'host-integrity', true),
    ),
    ...config.extraPaths.map((p) =>
      fsRule('allow', resolveAgainstWorkspace(p, 'an extra path'), 'extra', false),
    ),
    ...config.denyPaths.map((p) =>
      fsRule('deny', resolveAgainstWorkspace(p, 'a deny path'), 'preset', false),
    ),
  ]

  // The document's own content identity. It need not match the local seam's digest algorithm -
  // nothing compares a remote digest against a local one - only be a stable sha256 hex the host
  // can pin once at bind time and this seam can be held to afterwards, the same role
  // `fsPolicy.digest` plays locally.
  const digest = createHash('sha256')
    .update(
      JSON.stringify(['agnes.remote-fs-policy', 1, rules.map((r) => [r.path, r.effect, r.hard, r.source])]),
    )
    .digest('hex')

  const fsPolicy: FsPolicy = {
    workspaceRoot,
    rules,
    networkAllow: config.networkAllow,
    digest,
  }
  // Self-check with core's own contract validator rather than trusting the construction above by
  // inspection alone - the same validator the host runs before any file system is asked to enforce
  // this document.
  validateFsPolicy(fsPolicy)
  return fsPolicy
}

/**
 * Policy only. The channel is opened by the adapter layer - the one layer allowed to spawn, and the
 * one that runs before seams are fitted - and arrives here already live, the same shape DeepAgents
 * uses when a backend wraps an already-connected vendor sandbox.
 */
export const remoteSandboxSeam: SeamFactory<SandboxSeam> = async (ctx) => {
  const services = ctx.sandboxHost
  if (services?.transport === undefined)
    throw new Error('remote sandbox seam requires a transport from the host; none was supplied')

  const fsPolicy = compileRemoteFsPolicy(ctx.profile)

  // The posture, declared at init exactly as the local seam declares its own - the two calls that
  // make Agnes's three sandbox answers (spec §4.5's table) say true things about a remote
  // deployment instead of leaving them at their unprobed defaults:
  //
  //  - `reportBackend({name:'remote'})` is what makes `capability('sandbox.l1')` answer with RA11's
  //    honest reason ("remote host boundary: isolation inside the remote host is not attested by
  //    this harness") rather than 'not probed'. §4.7's `sandbox.required` refusal quotes that
  //    reason, so without this call the refusal is real but its stated cause is not.
  //  - `declareExecGate({backend:'remote'})` is what lets a remote exec past the gate's fourth
  //    check at all. §4.6.1 spells out the trap: 'l1' would assert local isolation nobody measured,
  //    'none' would deadlock (the fourth check refuses, and RA7 forbids escaping it through
  //    `onUnavailable: 'allow'`), so the widened 'remote' value is the only honest one.
  //
  // `onUnavailable` is 'deny' and stays 'deny': under RA7 a remote deployment never falls back to
  // unconfined local execution, and the gate's `onUnavailable` branch is unreachable for a
  // 'remote' posture anyway (it only fires for 'none'). A dead channel is refused by the host's
  // remote runner itself, which is where §4.6.1 puts that decision.
  services.reportBackend({ name: 'remote', enforcement: { level: 'none', scope: [] } })
  services.declareExecGate({ backend: 'remote', onUnavailable: 'deny' })

  let seam!: SandboxSeam
  seam = {
    forWorkspace: async (workspace: SeamWorkspace): Promise<SandboxSeam> => {
      if (
        workspace.execBackend !== 'remote' ||
        workspace.policy.workspaceRoot !== workspace.root ||
        workspace.binding().policyDigest !== workspace.policy.digest
      )
        throw fault('the remote workspace is not bound to its Host policy')
      await workspace.readiness.ready(workspace.signal)
      const fitted: SandboxSeam = {
        forWorkspace: async (next) => seam.forWorkspace(next),
        exec: (cmd, opts) =>
          workspace.exec(cmd, {
            ...opts,
            sandbox: { policyDigest: workspace.policy.digest, backend: 'remote' },
          }),
        confine: async () => {
          throw new Error(
            'confine() is unavailable under a remote sandbox: use exec(), which runs on the remote host',
          )
        },
        fsPolicy: () => workspace.policy,
        enforcement: () => ({
          level: workspace.enforcement.level,
          scope: [...workspace.enforcement.scope],
        }),
      }
      return fitted
    },
    // Through the host's gate, never around it. The binding this stamps on the request is checked
    // against what the host actually bound (`fsPolicy` must be the bound document) and against the
    // posture declared above; the gate then authorizes `opts.cwd` against that policy over the
    // remote fence before the command is shipped.
    exec: (cmd, opts) =>
      ctx.adapters.exec(cmd, { ...opts, sandbox: { policyDigest: fsPolicy.digest, backend: 'remote' } }),

    // Not a degraded local wrapper - a refusal. confine() exists for callers that spawn their own
    // process; under a remote deployment such a caller would spawn on this machine, which is not a
    // weaker version of running remotely but an entirely different destination. Returning the argv
    // unchanged would let that code look correct in local tests and silently run in the wrong place.
    confine: async () => {
      throw new Error(
        'confine() is unavailable under a remote sandbox: use exec(), which runs on the remote host',
      )
    },

    fsPolicy: () => fsPolicy,

    // What this harness itself enforces, which is nothing: it ships the command elsewhere. Whatever
    // isolation the remote host does or does not provide is not something this process can attest to.
    enforcement: (): Enforcement => ({ level: 'none', scope: [] }),
  }
  return seam
}
