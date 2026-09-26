import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join, posix, resolve } from 'node:path'
import type { ApprovalRequest, FsPolicy, FsRule, Verdict } from '@agnes/core'
import { validateFsPolicy } from '@agnes/core'
import { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'
import { RemoteWorkspacePool } from '@agnes/sandbox-remote'
import type { PackageModule } from '../assemble/packages.js'
import { HostError } from '../errors.js'
import type { ResolvedProfile } from '../profile/types.js'
import { assertSessionTreeStorePath } from '../session-tree-schema.js'
import {
  createExec,
  createPolicyExec,
  createProbeExec,
  type ExecAdapter,
  type ExecGateState,
} from './exec.js'
import { createRemoteExec } from './exec-remote.js'
import { createFs, type FencedFs, type FsBinding, type HostFs } from './fs.js'
import type { FsIo } from './fs-io.js'
import { localFsIo, localRealpathSync } from './fs-io-local.js'
import { createRemoteFsIo } from './fs-io-remote.js'
import { createPlatform, type PlatformBackend, type SandboxBackendReport } from './platform.js'
import { type PowerShellDescriptor, resolveConfiguredPowerShell } from './powershell.js'
import { powerShellCommand, powerShellDescription } from './powershell-command.js'
import type { RemoteTransport } from './remote-transport.js'
import { composeSecrets, createSecretsEnv, createSecretsFile, type SecretResolver } from './secrets.js'
import {
  createSessionWorkspaceAdapterFactory,
  type SessionWorkspaceAdapterFactory,
} from './session-workspace.js'
import { createSqliteStorage, type SqliteStorage, type TableStore } from './storage-sqlite.js'

// The deadline is carried by the signal rather than by a field grafted onto the request, so one
// prompter serves both a timeout and an explicit cancellation.
export type Prompter = { ask(req: ApprovalRequest, opts: { signal: AbortSignal }): Promise<Verdict> }
export type AdapterBundle = {
  storage: SqliteStorage
  fs: FencedFs
  dataFs: FencedFs
  exec: ExecAdapter
  platform: PlatformBackend
  readonly powerShell?: PowerShellDescriptor
  secrets: SecretResolver
  /**
   * Atomically replaces the bootstrap fence with the sandbox seam's full policy. Validates the
   * contract, requires the host-integrity floor to be present, pins the digest the exec gate then
   * enforces, and refuses - poisoning the fence to deny-all - on any mismatch, because a half-bound
   * policy is worse than none.
   */
  bindFsPolicy(policy: FsPolicy): void
  /** The digest of the policy the workspace FsOps is enforcing, or null before binding. */
  fsBinding(): { policyDigest: string | null }
  /** The sandbox seam states its process posture here; the policy-bound exec enforces it. */
  declareExecGate(state: ExecGateState): void
  /** Feeds only the sandbox seam's completed runtime probe back into platform capabilities. */
  reportSandboxBackend(report: SandboxBackendReport): void
  execGate(): ExecGateState
  /** A raw spawner for the sandbox factory's init window only; revoke ends it. */
  createProbeExec(): { run: ExecAdapter['run']; revoke(): void }
  /** The policy-bound exec every seam is handed. The raw spawner never leaves this bundle. */
  policyExec: ExecAdapter['run']
  /**
   * Present only when this deployment is in remote mode (RA17): `undefined` in every local
   * deployment, unchanged from before this field existed. `sandboxHostServices()` hands the same
   * handle to the sandbox factory; nothing else in this bundle opens or closes it.
   */
  transport?: RemoteTransport
  /** Per-session workspace resources. No assembly-wide workspace directory is created. */
  openWorkspace: SessionWorkspaceAdapterFactory['openWorkspace']
  openFence: SessionWorkspaceAdapterFactory['openFence']
  close(): Promise<void>
}
// Two file handles, fenced at two different roots, because they answer two different questions.
// `fs` is the user's workspace. `dataFs` is this installation's own store under dataDir, where the
// artifacts seam writes content-addressed bytes and the checkpoint seam keeps its shadow git - and
// dataDir defaults to ~/.agh/data, which is outside the workspace and so is refused by `fs`. Handing
// seams only `fs` did not make them safer; it made every write to their own store an E_FS_DENIED.
export type SeamAdapters = {
  shell?: Readonly<{ description: string }>
  fs: HostFs
  dataFs: HostFs
  exec: ExecAdapter['run']
  platform: PlatformBackend
  storage: TableStore
  prompter?: Prompter
}

/**
 * The digest of a policy the host itself compiled (the bootstrap fence, the data-directory fence).
 * A seam-supplied policy arrives with the digest its own compiler computed; the host treats that
 * as opaque and never rewrites it, so the two digest families never have to agree on an algorithm.
 */
function hostDigest(policy: { workspaceRoot: string; rules: readonly FsRule[] }): string {
  const canonical = JSON.stringify([
    'agnes.host-fs-policy',
    1,
    policy.workspaceRoot,
    policy.rules.map((r) => [r.path, r.effect, r.hard, r.source]),
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

const segmentsOf = (path: string): string[] => path.split(/[\\/]+/).filter((s) => s !== '')

export const samePlatformPath = (left: string, right: string, caseSensitive: boolean): boolean => {
  const normalize = (value: string): string => {
    const identity = segmentsOf(value).join('/')
    return caseSensitive ? identity : identity.toLowerCase()
  }
  return normalize(left) === normalize(right)
}

/** Canonical, or the lexical spelling when the path does not exist yet to be realpath'ed. */
const canonicalRoot = (path: string): string => {
  try {
    return localRealpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Host-owned workspace settings; all other package config remains opaque. */
function remoteWorkspaceConfig(config: Record<string, unknown>): {
  rootTemplate: string
  keepOnClose: boolean
  providerTtlMs: number
} {
  const root = config.rootTemplate
  if (
    typeof root !== 'string' ||
    !posix.isAbsolute(root) ||
    root.includes('\0') ||
    root.includes('\\') ||
    root.split('{session}').length !== 2 ||
    root.split('/').some((p) => p === '.' || p === '..')
  )
    throw new HostError('E_SEAM_INIT', 'rootTemplate must be an absolute remote path with one {session}', {
      detail: { seam: 'sandbox', reason: 'malformed-remote-config' },
    })
  if (config.keepOnClose !== undefined && typeof config.keepOnClose !== 'boolean')
    throw new HostError('E_SEAM_INIT', 'keepOnClose must be a boolean')
  const providerTtlMs = config.providerTtlMs ?? 86_400_000
  if (!Number.isSafeInteger(providerTtlMs) || (providerTtlMs as number) < 0)
    throw new HostError('E_SEAM_INIT', 'providerTtlMs must be a non-negative safe integer')
  return {
    rootTemplate: root,
    keepOnClose: config.keepOnClose ?? false,
    providerTtlMs: providerTtlMs as number,
  }
}

function assertTransport(value: unknown): asserts value is RemoteTransport {
  for (const method of ['exec', 'upload', 'download', 'alive', 'close'])
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof (value as Record<string, unknown>)[method] !== 'function'
    )
      throw new HostError('E_SEAM_INIT', `transport is missing ${method}`, { detail: { method } })
}

export async function openAdapters(
  profile: ResolvedProfile,
  opts: {
    dataDir: string
    workspaceRoot: string
    secretsDir?: string
    platform?: PlatformBackend
    windowsNodeExecutable?: string
    env?: NodeJS.ProcessEnv
    /** The storage the workspace fence runs over; the local disk unless a caller supplies another io. */
    workspaceIo?: FsIo
    modules?: ReadonlyMap<string, PackageModule>
    signal?: AbortSignal
    /** Skill directories the workspace fence may read; ignored in remote mode. */
    skillReadRoots?: () => readonly string[]
  },
): Promise<AdapterBundle> {
  assertSessionTreeStorePath(opts.dataDir)
  mkdirSync(opts.dataDir, { recursive: true })
  const platform = opts.platform ?? createPlatform()
  await platform.probe({ root: opts.workspaceRoot })
  let transport: RemoteTransport | undefined
  let remotePool: RemoteWorkspacePool | undefined
  let storage: SqliteStorage | undefined
  try {
    let secrets: SecretResolver
    switch (profile.adapters.secrets.kind) {
      case 'file':
        secrets = composeSecrets(
          createSecretsFile({
            dir: profile.adapters.secrets.path ?? opts.secretsDir ?? join(opts.dataDir, 'secrets'),
          }),
          createSecretsEnv(),
        )
        break
      case 'env':
        secrets = createSecretsEnv()
        break
      default:
        throw new HostError('E_SEAM_INIT', 'secrets kind vault is v0.x', {
          detail: { seam: 'secrets', reason: 'vault v0.x' },
        })
    }
    const signal = opts.signal ?? new AbortController().signal
    signal.throwIfAborted()
    const openTransport = opts.modules?.get(profile.seams.sandbox)?.openTransport
    if (openTransport !== undefined) {
      const config = profile.packages.find((p) => p.id === profile.seams.sandbox && p.enabled)?.config
      if (!config || typeof openTransport !== 'function')
        throw new HostError('E_SEAM_INIT', 'selected transport requires package config and a function export')
      const workspace = remoteWorkspaceConfig(config)
      const opened: unknown = await openTransport(config, {
        secret: (ref) => secrets.resolve(ref),
        dataDir: opts.dataDir,
        signal,
      })
      try {
        assertTransport(opened)
      } catch (error) {
        if (
          opened !== null &&
          typeof opened === 'object' &&
          'close' in opened &&
          typeof opened.close === 'function'
        )
          try {
            await opened.close()
          } catch {
            /* Preserve the shape failure. */
          }
        throw error
      }
      transport = opened
      signal.throwIfAborted()
      remotePool = new RemoteWorkspacePool({
        transport,
        ...workspace,
        closeTransport: false,
      })
    }
    const sea = process.getBuiltinModule('node:sea').isSea()
    const windowsNodeExecutable = opts.windowsNodeExecutable ?? (sea ? undefined : process.execPath)
    if (
      platform.os === 'win32' &&
      platform.matches() &&
      (!windowsNodeExecutable ||
        !isAbsolute(windowsNodeExecutable) ||
        (sea && samePlatformPath(windowsNodeExecutable, process.execPath, false)))
    )
      throw new HostError(
        'E_DEP_MISSING',
        'Windows execution requires an absolute Node runtime separate from the SEA executable',
      )
    const shellEnv = { ...process.env, ...opts.env }
    const powerShell =
      platform.os === 'win32' && platform.matches() ? await resolveConfiguredPowerShell(shellEnv) : undefined
    const exec = createExec({
      killTree: (pid) => platform.killTree(pid),
      detached: platform.os !== 'win32',
      ...(platform.os === 'win32' && platform.matches() && windowsNodeExecutable
        ? { windowsNodeExecutable }
        : {}),
      ...(powerShell ? { windowsPowerShell: powerShell } : {}),
    })
    const openedStorage = createSqliteStorage({
      file: join(opts.dataDir, 'sessions.db'),
      tablesDir: join(opts.dataDir, 'tables'),
    })
    storage = openedStorage
    // Under a remote deployment the workspace is a volume on another machine, so the case semantics
    // below cannot be measured here: `platform.fs().caseSensitive` probes THIS machine's volume at
    // `opts.workspaceRoot`, which is a remote spelling. The value has to be chosen, and `false`
    // ("fold case") is the fail-safe choice, because folding makes `decideFsPath` match MORE
    // spellings on every rule and the two rule kinds want that in opposite ways:
    //   - An `allow` rule (the workspace root) exists to grant coverage. Matching more spellings of
    //     it grants coverage to a name that is the same directory anyway - no new reach.
    //   - A `deny`/hard-deny rule (`.git`, the credential store) exists to withhold. Matching FEWER
    //     spellings of it is the dangerous direction: with `caseSensitive: true`, `<root>/.GIT` does
    //     not match the `.git` deny (exact-string comparison) yet still matches the workspace allow
    //     (ancestry is case-blind), so on a remote volume that really is case-insensitive the fence
    //     and the gated exec both admit the very file the deny names.
    // The residual risk folding does NOT cover: on a genuinely case-sensitive remote host holding
    // two different files whose names differ only by case, the fence treats them as one path and may
    // refuse the one that should have been allowed. That is over-blocking - a functionality cost, not
    // a safety gap - and Stage A accepts it in exchange for keeping the denies effective. Measuring
    // the real remote volume is Stage B's job (see the open boundary list in the execution record).
    const caseSensitive = transport ? false : platform.fs().caseSensitive
    // workspaceRoot is required, not defaulted to the process working directory: a session opened
    // elsewhere would otherwise read and write outside its own workspace, because the fence would be
    // pinned to wherever the host process happened to start.
    //
    // In remote mode it is a remote-absolute path (RA15), so `canonicalRoot`'s local realpath is
    // wrong twice over: it is a local syscall about a remote path, and where that spelling happens to
    // exist locally too (`/tmp`, `/home/<same name>`, a symlinked `/var`) it silently rewrites the
    // fence's root to the LOCAL realpath of a remote directory. The remote spelling is normalized
    // lexically instead and otherwise taken as given.
    const canonicalWorkspace = (path: string): string =>
      transport ? posix.normalize(path) : canonicalRoot(path)
    const workspaceRoot = canonicalWorkspace(opts.workspaceRoot)
    // `.git` and the credential store are this installation's own integrity, not the deployment's
    // preference. The bootstrap fence carries exactly them plus the workspace allow, it exists so
    // trusted seam factories can run before the sandbox seam's full policy is compiled, and it is
    // replaced - atomically, floor-checked, digest-pinned - when that policy binds. It never narrows
    // into nothing: a failed bind leaves a fence that refuses everything.
    const floorRules = (root: string): FsRule[] => [
      { effect: 'deny', path: join(root, '.git'), source: 'host-integrity', hard: true },
      ...WORKSPACE_SECRET_DIRS.map(
        (dir): FsRule => ({ effect: 'deny', path: join(root, dir), source: 'host-integrity', hard: true }),
      ),
    ]
    const bootstrapRules: FsRule[] = [
      { effect: 'allow', path: workspaceRoot, source: 'workspace', hard: false },
      ...floorRules(workspaceRoot),
    ]
    const bootstrapPolicy: FsPolicy = {
      workspaceRoot,
      rules: bootstrapRules,
      networkAllow: [],
      digest: hostDigest({ workspaceRoot, rules: bootstrapRules }),
    }

    // The single cell the fence reads on every operation. Binding swaps the whole object; there is
    // no intermediate state in which some rules are old and some are new.
    const holder: { current: FsBinding; bound: string | null } = {
      current: { policy: bootstrapPolicy, caseSensitive },
      bound: null,
    }
    let gate: ExecGateState = { backend: 'none', onUnavailable: 'deny' }
    // The fence itself is not new for remote mode - it is the same createFs from step 0, reading the
    // same holder - only the io underneath it changes: derived from the live transport when this
    // deployment is remote, the caller's io (or the local disk) when it is not (spec §4.1, P1).
    const fs = createFs(
      () => holder.current,
      transport ? createRemoteFsIo(transport) : (opts.workspaceIo ?? localFsIo),
      transport ? undefined : opts.skillReadRoots,
    )

    const dataRoot = canonicalRoot(opts.dataDir)
    // The data directory's own fence. A seam living in dataDir has no business reading the secret
    // store, the session database or another package's table files through a file handle - it reaches
    // its own tables through storage.table() - and the audit log is the host's, not a seam's.
    const dataRules: FsRule[] = [
      { effect: 'allow', path: dataRoot, source: 'data', hard: false },
      { effect: 'deny', path: join(dataRoot, 'secrets'), source: 'host-integrity', hard: true },
      { effect: 'deny', path: join(dataRoot, 'tables'), source: 'host-integrity', hard: true },
      { effect: 'deny', path: join(dataRoot, 'audit'), source: 'host-integrity', hard: true },
      { effect: 'deny', path: join(dataRoot, 'sessions.db'), source: 'host-integrity', hard: true },
    ]
    const dataPolicy: FsPolicy = {
      workspaceRoot: dataRoot,
      rules: dataRules,
      networkAllow: [],
      digest: hostDigest({ workspaceRoot: dataRoot, rules: dataRules }),
    }
    // The installation's own store is never anywhere but the local disk, whatever the workspace is on.
    const dataFs = createFs(() => ({ policy: dataPolicy, caseSensitive }), localFsIo)

    // The one exec gate, for every deployment. Spec §4.6: remote mode keeps all four checks and
    // swaps only `inner`, so a seam's exec still has to carry a live binding, still has its cwd
    // authorized against the bound file policy (here over the remote fence, since `fs` above sits on
    // `createRemoteFsIo`), and still meets the backend gate - it simply lands on the remote host
    // instead of this one. Handing the sandbox seam the raw transport to call directly would put
    // every one of those checks out of the path; the seam reaches this function through
    // `toSeamAdapters`, exactly like every other seam.
    const innerExec = transport ? createRemoteExec(transport) : exec
    const policyExec = createPolicyExec(innerExec, {
      boundDigest: () => holder.bound,
      state: () => gate,
      authorizeCwd: (cwd) => fs.resolveInside(cwd),
    })
    const sessionWorkspaces = createSessionWorkspaceAdapterFactory({
      platform,
      exec: innerExec,
      ...(transport && remotePool ? { transport, remotePool } : {}),
      ...(transport || !opts.skillReadRoots ? {} : { skillReadRoots: opts.skillReadRoots }),
    })

    return {
      storage: openedStorage,
      ...(powerShell ? { powerShell } : {}),
      ...(transport ? { transport } : {}),
      openWorkspace: sessionWorkspaces.openWorkspace,
      openFence: sessionWorkspaces.openFence,
      fs,
      dataFs,
      exec,
      platform,
      secrets,
      fsBinding: () => ({ policyDigest: holder.bound }),
      declareExecGate: (state) => {
        gate = state
      },
      reportSandboxBackend: (report) => platform.recordSandboxBackend(report),
      execGate: () => gate,
      // The factory's init-window spawner runs wherever this deployment runs: probing the local
      // machine to decide a remote deployment's posture would measure the wrong host.
      createProbeExec: () => createProbeExec(innerExec),
      policyExec,
      bindFsPolicy(policy) {
        const refuse = (reason: string): never => {
          // Deny everything from here on: the assembly is about to unwind, and nothing that captured
          // the fs handle may keep using the bootstrap fence in the meantime.
          const shut: FsPolicy = {
            workspaceRoot,
            rules: [],
            networkAllow: [],
            digest: hostDigest({ workspaceRoot, rules: [] }),
          }
          holder.current = { policy: shut, caseSensitive }
          throw new HostError('E_SEAM_INIT', `the sandbox file policy cannot be bound: ${reason}`, {
            detail: { seam: 'sandbox', reason },
          })
        }
        try {
          validateFsPolicy(policy)
        } catch (e) {
          refuse(e instanceof Error ? e.message : String(e))
        }
        // The fence serves one workspace; a policy compiled against another root is not this host's
        // to enforce.
        const claimed = canonicalWorkspace(policy.workspaceRoot)
        if (!samePlatformPath(claimed, workspaceRoot, caseSensitive))
          refuse('the policy names a different workspace root than this host serves')
        // The floor is not negotiable: a policy without the host-integrity hard denies would hand
        // out .git and the credential store, whatever else it says.
        const hasFloor = floorRules(workspaceRoot).every((floor) =>
          policy.rules.some(
            (rule) =>
              rule.hard && rule.effect === 'deny' && samePlatformPath(rule.path, floor.path, caseSensitive),
          ),
        )
        if (!hasFloor) refuse('the policy does not carry the host-integrity floor')
        holder.current = { policy, caseSensitive }
        holder.bound = policy.digest
      },
      async close() {
        // Attempt every owned cleanup, retaining the first failure for the caller.
        const errors: unknown[] = []
        for (const close of [
          () => exec.killAll(),
          () => openedStorage.close(),
          async () => {
            await remotePool?.close()
          },
          async () => {
            await transport?.close()
          },
        ]) {
          try {
            await close()
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length) throw errors[0]
      },
    }
  } catch (e) {
    // What this function opened, this function closes. Cleanup failures are swallowed rather than
    // replacing `e`: the caller needs the failure that actually stopped the assembly, and a
    // transport that cannot be closed is not something the caller can act on differently.
    await storage?.close().catch(() => {})
    await remotePool?.close().catch(() => {})
    await transport?.close().catch(() => {})
    throw e
  }
}

export function lazyPackageTables(storage: SqliteStorage, owner: string): TableStore {
  let opened: TableStore | undefined
  return {
    table(name) {
      opened ??= storage.tables(owner)
      return opened.table(name)
    },
  }
}

export function toSeamAdapters(b: AdapterBundle, opts: { owner: string; prompter?: Prompter }): SeamAdapters {
  return {
    ...(b.powerShell ? { shell: { description: powerShellDescription(b.powerShell) } } : {}),
    fs: b.fs,
    dataFs: b.dataFs,
    // Every seam - not only sandbox - gets the policy-bound exec. The raw spawner is the host's
    // own and, for the sandbox factory's init window alone, the revocable probe.
    exec: b.policyExec,
    platform: b.platform,
    storage: lazyPackageTables(b.storage, opts.owner),
    ...(opts.prompter ? { prompter: opts.prompter } : {}),
  }
}

/**
 * The services only the sandbox factory is ever handed, built over one bundle. The canonicalizer
 * is the FsOps fence's own - same walk, same flavor, same case semantics - narrowed to producing a
 * name. The probe exec is raw and ends with the factory; `revoke` is the assembly's to call the
 * moment the factory settles.
 */
export type SandboxHostServices = {
  shellCommand?: (command: string) => string[]
  pathPolicy: { canonicalize(path: string, opts?: { base?: string }): Promise<string> }

  probeExec: ExecAdapter['run']
  declareExecGate(state: ExecGateState): void
  reportBackend(report: SandboxBackendReport): void
  binding(): { policyDigest: string | null }
  /** Present only under a remote deployment; the seam does not open it, it receives it live. */
  transport?: RemoteTransport
}

export function sandboxHostServices(b: AdapterBundle): {
  services: SandboxHostServices
  revoke(): void
} {
  const probe = b.createProbeExec()
  const powerShell = b.powerShell
  return {
    services: {
      ...(powerShell ? { shellCommand: (command: string) => powerShellCommand(powerShell, command) } : {}),
      ...(b.transport ? { transport: b.transport } : {}),
      pathPolicy: {
        canonicalize: (path, opts) => {
          if (typeof path !== 'string' || path.length === 0 || path.includes('\0'))
            throw new HostError('E_SEAM_INIT', 'the sandbox policy names an unusable path', {
              detail: { seam: 'sandbox', reason: 'unusable-path' },
            })
          return b.fs.canonicalize(path, opts)
        },
      },
      probeExec: probe.run,
      declareExecGate: (state) => b.declareExecGate(state),
      reportBackend: (report) => b.reportSandboxBackend(report),
      binding: () => b.fsBinding(),
    },
    revoke: () => probe.revoke(),
  }
}

export * from './exec.js'
export * from './fs.js'
export * from './net.js'
export * from './platform.js'
export * from './secrets.js'
export * from './session-workspace.js'
export * from './sql-guard.js'
export * from './storage-sqlite.js'
