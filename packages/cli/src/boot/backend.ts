import type { ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import {
  acquireDaemonStartup,
  type DaemonDiscovery,
  type DaemonDiscoveryWeb,
  type DaemonScope,
  DaemonStartupBusyError,
  daemonSocketPaths,
  daemonStatus,
  prepareDaemonSocketPaths,
  readDaemonDiscovery,
  readDaemonWebCredential,
  resolveDaemonScope,
  stopDaemon,
} from '@agnes/daemon'
import {
  createPlatform,
  type DetachedChild,
  defaultProcessIdentity,
  releaseDetachedProcess,
  spawnDetachedProcess,
} from '@agnes/host'
import { type Client, type CreateClientOptions, createClient, memoryJournal } from '@agnes/sdk'
import { type LaunchResources, resolveLaunchResources } from '../../launch/resources.js'
import { BootError } from '../errors.js'

/** A private Web capability returned by the validated daemon discovery handshake. */
export type LocalBackendWeb = DaemonDiscoveryWeb & { token: string }

/**
 * The result intentionally has no long-lived SDK client. CLI boot creates its own client with
 * `bootConnect`; Web reads the endpoint and private bearer here and owns its HTTP server lifecycle.
 */
export type LocalBackend = {
  scope: DaemonScope
  discovery: DaemonDiscovery
  socketPath: string
  web?: LocalBackendWeb
  /** Compatibility name for Web launchers that only need to release their client-side resources. */
  closeClient(): Promise<void>
  close(): Promise<void>
}

type LocalWebOptions = { addr: string; origin: string }

export type EnsureLocalBackendOptions = {
  env?: NodeJS.ProcessEnv
  cwd?: string
  home?: string
  profile?: string
  workspace?: string
  dataDir?: string
  agnesVersion?: string
  /** Management Web may start read-only recovery without evaluating a damaged package lock. */
  allowPackageRecovery?: boolean
  signal?: AbortSignal
  /** Request the daemon's authenticated loopback Web listener for this exact origin. */
  webOrigin?: string
  localWeb?: LocalWebOptions
  /** Used only when this invocation starts a daemon; never constrains IPC attachment. */
  startupWeb?: LocalWebOptions
  resources?: LaunchResources
  /** Test seam for the SDK handshake; production uses the Node SDK factory. */
  createClientImpl?: (options: CreateClientOptions) => Client
  /** Bounded readiness deadline. The default is deliberately finite. */
  readinessTimeoutMs?: number
  readinessPollMs?: number
  /** Test/embedding seam for the detached child launch. */
  spawnDaemon?: (input: SpawnDaemonInput) => ChildProcess
}

export type SpawnDaemonInput = {
  entry: string
  argv: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  execPath: string
}

const DEFAULT_READINESS_TIMEOUT_MS = 30_000
const DEFAULT_READINESS_POLL_MS = 50
/** Cleanup is best effort after a bounded startup failure; it must not defeat the readiness bound. */
const CLIENT_CLEANUP_TIMEOUT_MS = 250

function asBootError(stage: string, error: unknown): BootError {
  if (error instanceof BootError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new BootError(`local daemon ${stage} failed: ${message}`, error)
}

function signalError(signal: AbortSignal | undefined): BootError | undefined {
  if (signal?.aborted) return new BootError('local daemon startup was cancelled')
  return undefined
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  const cancelled = signalError(signal)
  if (cancelled) throw cancelled
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signalError(signal) ?? new BootError('local daemon startup was cancelled'))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/** Run one readiness operation under the same finite deadline as the outer bootstrap. */
async function withinDeadline<T>(
  work: () => Promise<T>,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<T> {
  const left = deadlineAt - Date.now()
  if (left <= 0) throw new BootError('local daemon readiness deadline exceeded')
  const cancelled = signalError(signal)
  if (cancelled) throw cancelled
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const operation = Promise.resolve().then(work)
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new BootError('local daemon readiness deadline exceeded')), left)
  })
  const aborted = signal
    ? new Promise<T>((_, reject) => {
        onAbort = () => reject(signalError(signal) ?? new BootError('local daemon startup was cancelled'))
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
    : undefined
  try {
    return await Promise.race(aborted ? [operation, timeout, aborted] : [operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
}

async function closeClientBounded(client: Client): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(() => client.close()),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLIENT_CLEANUP_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function expectedWeb(options: EnsureLocalBackendOptions): LocalWebOptions | undefined {
  if (options.localWeb && options.webOrigin && options.localWeb.origin !== options.webOrigin)
    throw new BootError('local daemon Web origin does not match the selected origin')
  const origin = options.localWeb?.origin ?? options.webOrigin
  if (origin === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new BootError('local daemon Web origin must be an exact loopback HTTP origin')
  }
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    parsed.port === '' ||
    Number(parsed.port) < 1 ||
    Number(parsed.port) > 65_535 ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.origin !== origin
  )
    throw new BootError('local daemon Web origin must be an exact loopback HTTP origin')
  return options.localWeb ?? { addr: '127.0.0.1:0', origin }
}

function validateWeb(discovery: DaemonDiscovery, requested: LocalWebOptions | undefined): void {
  if (!requested) return
  if (!discovery.web) throw new BootError('local daemon has no Web capability; stop/restart the local daemon')
  if (discovery.web.origin !== requested.origin)
    throw new BootError('local daemon Web origin does not match the selected origin')
}

async function readReady(
  scope: DaemonScope,
  requested: LocalWebOptions | undefined,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<DaemonDiscovery | null> {
  try {
    const identityTimeoutMs = Math.min(1_000, Math.max(1, deadlineAt - Date.now()))
    const discovery = await withinDeadline(
      () => readDaemonDiscovery(scope, { identityTimeoutMs }),
      deadlineAt,
      signal,
    )
    if (discovery) validateWeb(discovery, requested)
    return discovery
  } catch (error) {
    throw asBootError('discovery read', error)
  }
}

async function waitReady(
  scope: DaemonScope,
  options: EnsureLocalBackendOptions,
  requested: LocalWebOptions | undefined,
  childFailure: () => Error | undefined,
  deadlineAt: number,
): Promise<DaemonDiscovery> {
  const poll = options.readinessPollMs ?? DEFAULT_READINESS_POLL_MS
  if (!Number.isSafeInteger(poll) || poll <= 0)
    throw new BootError('local daemon readiness timing is invalid')
  while (Date.now() < deadlineAt) {
    const cancelled = signalError(options.signal)
    if (cancelled) throw cancelled
    const childError = childFailure()
    if (childError) throw asBootError('startup', childError)
    const discovery = await readReady(scope, requested, deadlineAt, options.signal)
    if (discovery) return discovery
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) break
    await delay(Math.min(poll, remaining), options.signal)
  }
  const childError = childFailure()
  if (childError) throw asBootError('startup', childError)
  throw new BootError('local daemon did not become ready within the readiness deadline')
}

function productionResources(options: EnsureLocalBackendOptions): LaunchResources {
  if (options.resources) return options.resources
  try {
    return resolveLaunchResources()
  } catch (error) {
    throw asBootError('launch resources', error)
  }
}

function isSea(): boolean {
  try {
    return process.getBuiltinModule('node:sea').isSea()
  } catch {
    return false
  }
}

function launchWorkspace(scope: DaemonScope, options: EnsureLocalBackendOptions): string {
  // `workspace` is a launcher input, not part of the daemon identity: two cwd values selecting
  // one profile/dataDir must reuse one owner. Older daemon builds expose it on the scope object, so
  // consume it only as a compatibility hint and keep the bootstrap usable when it is removed.
  const selected = (scope as DaemonScope & { workspace?: string }).workspace
  return selected ?? resolve(options.workspace ?? options.cwd ?? process.cwd())
}

function launchChild(
  scope: DaemonScope,
  options: EnsureLocalBackendOptions,
  requested: LocalWebOptions | undefined,
): DetachedChild {
  const resources = productionResources(options) as LaunchResources & { runtimeNode?: string }
  const entry = resources.daemonEntry
  if (resources.mode === 'sea' && !isSea())
    throw new BootError('local daemon launch resources are for a packaged executable')
  if (/\.(?:ts|tsx)$/u.test(entry) && isSea())
    throw new BootError('packaged local startup cannot use a source daemon entry')

  const argv: string[] = []
  // Source mode is explicit and exists only for the repository development launcher. A packaged
  // runtime must provide daemon.mjs next to its immutable build output; it never reaches into src.
  if (/\.(?:ts|tsx)$/u.test(entry)) argv.push('--import', 'tsx')
  const workspace = launchWorkspace(scope, options)
  argv.push(entry, '--profile', scope.profile, '--workspace', workspace, '--data-dir', scope.dataDir)
  if (requested) {
    argv.push('--local-web-addr', requested.addr, '--local-web-origin', requested.origin)
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.env ?? {}),
    AGH_HOME: scope.home,
    AGNES_PROFILE: scope.profile,
  }
  const runtimeOverride = options.env?.AGNES_NODE_EXEC_PATH ?? process.env.AGNES_NODE_EXEC_PATH
  const execPath = isSea() ? runtimeOverride || resources.runtimeNode : process.execPath
  if (execPath === undefined || execPath.length === 0)
    throw new BootError('packaged local startup cannot find its bundled Node runtime')
  const spawnInput: SpawnDaemonInput = { entry, argv, cwd: workspace, env, execPath }
  if (options.spawnDaemon) return options.spawnDaemon(spawnInput)
  return spawnDetachedProcess(execPath, argv, { cwd: workspace, env })
}

async function sdkReady(
  scope: DaemonScope,
  discovery: DaemonDiscovery,
  options: EnsureLocalBackendOptions,
  deadlineAt: number,
): Promise<DaemonDiscovery> {
  const makeClient = options.createClientImpl ?? createClient
  const remaining = Math.max(1, deadlineAt - Date.now())
  const client = makeClient({
    transport: {
      kind: 'unix',
      path: discovery.socketPath,
      ...(discovery.socketPath.startsWith('\\\\.\\pipe\\')
        ? {
            serverIdentity: {
              pid: discovery.owner.pid,
              processStartId: discovery.owner.processStartId,
            },
          }
        : {}),
    },
    auth: { kind: 'local' },
    journal: memoryJournal(),
    timeouts: { initialize: remaining, request: remaining },
  })
  try {
    await withinDeadline(() => client.initialize(), deadlineAt, options.signal)
    // Configuration is part of the readiness contract: a listening socket and initialize alone do
    // not prove this is the same fully assembled daemon that CLI/Web settings will use.
    await withinDeadline(() => client.config.get(), deadlineAt, options.signal)
    const apis = await withinDeadline(() => client.apis(), deadlineAt, options.signal)
    // The discovery hash attests the daemon's startup profile. Runtime configuration saves may
    // intentionally update defaults while this daemon generation remains alive, so a later API
    // projection is allowed to carry a different mutable profile hash.
    if (apis.profile.name !== scope.profile)
      throw new BootError('local daemon profile does not match the selected scope')
    const current = await readReady(scope, expectedWeb(options), deadlineAt, options.signal)
    if (!current) throw new BootError('local daemon stopped during readiness verification')
    if (
      current.owner.generation !== discovery.owner.generation ||
      current.socketPath !== discovery.socketPath ||
      current.scopeID !== discovery.scopeID
    )
      throw new BootError('local daemon changed during readiness verification')
    return current
  } catch (error) {
    throw asBootError('SDK readiness handshake', error)
  } finally {
    await closeClientBounded(client).catch(() => undefined)
  }
}

type DiscoveryResult = {
  discovery: DaemonDiscovery
  /** Set only when this invocation spawned the daemon, for failure cleanup. */
  child?: DetachedChild
  childStartId?: string
  /** Startup-lock path has already completed the SDK readiness proof. */
  verified?: boolean
}

async function discoverOrStart(
  scope: DaemonScope,
  options: EnsureLocalBackendOptions,
  requested: LocalWebOptions | undefined,
  deadlineAt: number,
): Promise<DiscoveryResult> {
  let discovery = await readReady(scope, requested, deadlineAt, options.signal)
  if (discovery) return { discovery }

  // An owner record without a descriptor may be a daemon still starting. Ask the daemon-owned
  // status primitive whether its identity is alive before deciding to acquire startup rights; a
  // dead owner is allowed to go through the normal reclaiming owner lock path.
  let startup: { release(): void } | undefined
  while (Date.now() < deadlineAt) {
    let status: Awaited<ReturnType<typeof daemonStatus>>
    try {
      const identityTimeoutMs = Math.min(1_000, Math.max(1, deadlineAt - Date.now()))
      status = await withinDeadline(
        () => daemonStatus(scope.dataDir, { identityTimeoutMs, socketTimeoutMs: identityTimeoutMs }),
        deadlineAt,
        options.signal,
      )
    } catch (error) {
      throw asBootError('status read', error)
    }
    if (status.running) {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) break
      await delay(Math.min(options.readinessPollMs ?? DEFAULT_READINESS_POLL_MS, remaining), options.signal)
      discovery = await readReady(scope, requested, deadlineAt, options.signal)
      if (discovery) return { discovery }
      continue
    }
    try {
      startup = acquireDaemonStartup(scope)
      break
    } catch (error) {
      if (!(error instanceof DaemonStartupBusyError)) throw asBootError('startup coordination', error)
      // A competing launcher may fail after taking this lock but before publishing an owner. Retry
      // the liveness/lock decision within the same bounded deadline so it can be taken over safely.
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) break
      await delay(Math.min(options.readinessPollMs ?? DEFAULT_READINESS_POLL_MS, remaining), options.signal)
      discovery = await readReady(scope, requested, deadlineAt, options.signal)
      if (discovery) return { discovery }
    }
  }
  if (!startup) throw new BootError('local daemon did not become ready within the readiness deadline')
  const startupLock = startup
  let child: DetachedChild | undefined
  let childStartId: string | undefined
  let childError: Error | undefined
  try {
    // Recheck after taking the launcher lock: another process may have published while this caller
    // was resolving its scope or waiting for the lock.
    discovery = await readReady(scope, requested, deadlineAt, options.signal)
    if (!discovery) {
      try {
        prepareDaemonSocketPaths(
          daemonSocketPaths({
            dataDir: scope.dataDir,
            ipc: createPlatform().snapshot().os === 'win32' ? 'pipe' : 'unix',
          }),
        )
        child = launchChild(scope, options, requested ?? options.startupWeb)
      } catch (error) {
        throw asBootError('spawn', error)
      }
      child.once('error', (error) => {
        childError = error instanceof Error ? error : new Error(String(error))
      })
      child.once('exit', (code, signal) => {
        childError = new Error(
          `daemon child exited before readiness (${code === null ? 'signal' : code}${signal ? `/${signal}` : ''})`,
        )
      })
      // Register lifecycle listeners before the identity probe: a very short-lived child can exit
      // while the platform helper is checking its start id, and that exit still must fail startup.
      childStartId = await captureChildStartId(child, deadlineAt, options.signal)
      child.unref()
      discovery = await waitReady(scope, options, requested, () => childError, deadlineAt)
    }
    // Keep the startup lock held through the SDK proof. If this child published a descriptor but
    // cannot serve initialize/config/apis, cleanup below still addresses this generation before a
    // competing launcher can observe and reuse it.
    const verified = await sdkReady(scope, discovery, options, deadlineAt)
    return {
      discovery: verified,
      ...(child ? { child } : {}),
      ...(childStartId ? { childStartId } : {}),
      verified: true,
    }
  } catch (error) {
    try {
      await stopOwnChild(scope, child, childStartId)
    } finally {
      releaseDetachedProcess(child)
    }
    throw error
  } finally {
    startupLock.release()
  }
}

/** Stop only a child that became the current daemon owner; never signal a reused PID. */
async function captureChildStartId(
  child: DetachedChild,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const pid = child.pid
  if (pid === undefined || pid === null) return undefined
  try {
    const identity = await withinDeadline(() => defaultProcessIdentity(pid), deadlineAt, signal)
    return identity.state === 'alive' ? identity.startId : undefined
  } catch {
    // An unavailable identity is deliberately not treated as permission to signal a PID later.
    return undefined
  }
}

async function stopOwnChild(
  scope: DaemonScope,
  child: DetachedChild | undefined,
  childStartId: string | undefined,
): Promise<void> {
  const ownChild = child
  const pid = ownChild?.pid
  if (ownChild === undefined || pid === undefined || pid === null) return
  if (ownChild.exitCode !== null || ownChild.signalCode !== null) return
  // If the identity probe itself timed out, the ChildProcess handle is still the only safe
  // reference to the process we spawned. Guard its exit state and use that handle directly; a
  // PID-only lookup is never used as a substitute for the handle.
  if (childStartId === undefined) {
    await terminateChildHandle(ownChild)
    return
  }

  let status: Awaited<ReturnType<typeof daemonStatus>> | undefined
  try {
    status = await withinDeadline(
      () => daemonStatus(scope.dataDir, { identityTimeoutMs: 250, socketTimeoutMs: 250 }),
      Date.now() + CLIENT_CLEANUP_TIMEOUT_MS,
    )
  } catch {
    // Fall through to the identity-bound ChildProcess handle if the status probe is unavailable.
  }
  if (status?.owner?.pid === pid && status.owner.processStartId === childStartId) {
    try {
      const result = await withinDeadline(
        () =>
          stopDaemon(scope.dataDir, {
            identityTimeoutMs: 250,
            waitMs: CLIENT_CLEANUP_TIMEOUT_MS,
            pollMs: 25,
          }),
        Date.now() + CLIENT_CLEANUP_TIMEOUT_MS,
      )
      if (result === 'stopped' || ownChild.exitCode !== null || ownChild.signalCode !== null) return
    } catch {
      // The direct handle path below still verifies the process start id before signalling.
    }
  }

  try {
    // A child can time out before it publishes owner.json. Verify the same process identity again
    // before asking Node to terminate the process handle; a reused PID is left untouched.
    const current = await withinDeadline(() => defaultProcessIdentity(pid), Date.now() + 250)
    if (current.state === 'alive' && current.startId === childStartId) await terminateChildHandle(ownChild)
  } catch {
    // Cleanup is best effort. The daemon control path performs the identity and generation checks;
    // a refusal leaves the owner record for the next bounded bootstrap to diagnose safely.
  }
}

/** Terminate a process through the handle created by this invocation, with a short escalation bound. */
async function terminateChildHandle(child: DetachedChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + CLIENT_CLEANUP_TIMEOUT_MS
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
    await delay(Math.min(25, deadline - Date.now()))
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL')
    } catch {
      // The process may have exited between the state check and the escalation.
    }
  }
}

/**
 * Resolve, discover, or start the one detached daemon for a local scope, then prove it through the
 * SDK before returning. The daemon remains owned by its own process; this function releases only
 * the launcher lock and the temporary readiness client.
 */
export async function ensureLocalBackend(options: EnsureLocalBackendOptions = {}): Promise<LocalBackend> {
  const requested = expectedWeb(options)
  if (options.startupWeb) expectedWeb({ localWeb: options.startupWeb })
  const timeout = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const poll = options.readinessPollMs ?? DEFAULT_READINESS_POLL_MS
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || !Number.isSafeInteger(poll) || poll <= 0)
    throw new BootError('local daemon readiness timing is invalid')
  const deadlineAt = Date.now() + timeout
  let scope: DaemonScope
  try {
    scope = await withinDeadline(
      () =>
        resolveDaemonScope({
          ...(options.env ? { env: options.env } : {}),
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.home ? { home: options.home } : {}),
          ...(options.profile ? { profile: options.profile } : {}),
          ...(options.workspace ? { workspace: options.workspace } : {}),
          ...(options.dataDir ? { dataDir: options.dataDir } : {}),
          ...(options.agnesVersion ? { agnesVersion: options.agnesVersion } : {}),
          ...(options.allowPackageRecovery ? { allowPackageRecovery: true } : {}),
        }),
      deadlineAt,
      options.signal,
    )
  } catch (error) {
    throw asBootError('scope resolution', error)
  }
  const started = await discoverOrStart(scope, options, requested, deadlineAt)
  try {
    const discovery = started.verified
      ? started.discovery
      : await sdkReady(scope, started.discovery, options, deadlineAt)
    validateWeb(discovery, requested)
    let web: LocalBackendWeb | undefined
    if (requested && discovery.web) {
      let token: string | null
      try {
        token = await readDaemonWebCredential(scope, discovery.owner.generation)
      } catch (error) {
        throw asBootError('Web credential read', error)
      }
      if (!token)
        throw new BootError('local daemon Web credential is unavailable; stop/restart the local daemon')
      web = { ...discovery.web, token }
    }
    return {
      scope,
      discovery,
      socketPath: discovery.socketPath,
      ...(web ? { web } : {}),
      closeClient: async () => undefined,
      close: async () => undefined,
    }
  } catch (error) {
    await stopOwnChild(scope, started.child, started.childStartId)
    throw error
  } finally {
    releaseDetachedProcess(started.child)
  }
}
