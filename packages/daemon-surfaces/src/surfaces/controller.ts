import type { ResolvedDeployment } from '@agnes/host'
import { waitForSurfaceHealth } from './health.js'
import { createLocalNodeRuntime } from './local-runtime.js'
import type {
  ResolvedSurface,
  SurfaceArtifactResolver,
  SurfaceController,
  SurfaceControllerSnapshot,
  SurfaceExit,
  SurfaceInstanceState,
  SurfaceInstanceStatus,
  SurfaceLog,
  SurfaceRuntimeAdapter,
  SurfaceRuntimeHandle,
  SurfaceSecretLease,
  SurfaceSecretResolver,
} from './types.js'

const MAX_SECRET_VALUE_BYTES = 64 * 1_024
const MAX_SECRET_ENV_BYTES = 1 * 1_024 * 1_024

export class SurfaceControllerError extends Error {
  constructor(
    readonly code: 'BUSY' | 'START_FAILED' | 'STOP_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'SurfaceControllerError'
  }
}

export type SurfaceControllerOptions = Readonly<{
  artifacts: SurfaceArtifactResolver
  secrets: SurfaceSecretResolver
  runtime?: SurfaceRuntimeAdapter
  log?: SurfaceLog
  startupMs?: number
  healthIntervalMs?: number
  shutdownGraceMs?: number
  killWaitMs?: number
  cleanupMs?: number
}>

type InstanceRecord = {
  surface: ResolvedSurface
  state: SurfaceInstanceState
  handle?: SurfaceRuntimeHandle
  exit?: SurfaceExit
}

export function createSurfaceController(options: SurfaceControllerOptions): SurfaceController {
  const runtime = options.runtime ?? createLocalNodeRuntime()
  const log = options.log ?? SILENT_LOG
  const startupMs = deadline(options.startupMs ?? 30_000, 'surface startup deadline')
  const healthIntervalMs = deadline(options.healthIntervalMs ?? 100, 'surface health interval')
  const shutdownGraceMs = deadline(options.shutdownGraceMs ?? 30_000, 'surface shutdown deadline')
  const killWaitMs = deadline(options.killWaitMs ?? 5_000, 'surface kill deadline')
  const cleanupMs = deadline(options.cleanupMs ?? 5_000, 'surface cleanup deadline')
  const defaultArtifacts = options.artifacts
  const records = new Map<string, InstanceRecord>()
  /** Per-`sourceId` mutex for `coldUpdate`. Deliberately per source rather than whole-controller: an
   * update of one Surface must not block operations on an unrelated one. */
  const perSourceOperation = new Set<string>()
  let phase: SurfaceControllerSnapshot['phase'] = 'idle'
  let deploymentHash: string | undefined
  let operation: Promise<void> | undefined
  let startAbort: AbortController | undefined

  const controller: SurfaceController = Object.freeze({
    start: startController,
    stop: stopController,
    snapshot,
    update: coldUpdate,
  })
  return controller

  function startController(
    deployment: ResolvedDeployment,
    callerSignal = new AbortController().signal,
  ): Promise<SurfaceControllerSnapshot> {
    if (phase !== 'idle' || operation !== undefined) {
      return Promise.reject(new SurfaceControllerError('BUSY', 'surface controller is busy'))
    }
    phase = 'starting'
    deploymentHash = deployment.hash
    const lifecycleAbort = new AbortController()
    const deadlineAbort = new AbortController()
    startAbort = lifecycleAbort
    const signal = AbortSignal.any([callerSignal, lifecycleAbort.signal, deadlineAbort.signal])
    const startupTimer = setTimeout(() => deadlineAbort.abort(), startupMs)
    startupTimer.unref?.()
    const lifecycle = (async () => {
      try {
        await startDeployment(deployment, signal)
        signal.throwIfAborted()
        phase = 'running'
        safeLog(log, 'info', 'surface deployment started', {
          deploymentHash: deployment.hash,
          instances: records.size,
        })
        return snapshot()
      } catch {
        let cleanupFailed = false
        await stopRecords(new AbortController().signal).catch(() => {
          cleanupFailed = true
        })
        if (cleanupFailed) phase = 'degraded'
        else {
          forgetRecords()
          phase = 'idle'
          deploymentHash = undefined
        }
        safeLog(log, 'error', 'surface deployment failed to start')
        throw new SurfaceControllerError('START_FAILED', 'surface deployment failed to start')
      } finally {
        clearTimeout(startupTimer)
        if (startAbort === lifecycleAbort) startAbort = undefined
      }
    })()
    const tracked = lifecycle.then(
      () => undefined,
      () => undefined,
    )
    operation = tracked
    void tracked.finally(() => {
      if (operation === tracked) operation = undefined
    })
    return lifecycle
  }

  async function stopController(signal = new AbortController().signal): Promise<void> {
    if (phase === 'starting') {
      const starting = operation
      startAbort?.abort()
      await starting?.catch(() => undefined)
    }
    if (phase === 'idle' && operation === undefined) return
    if (phase === 'stopping' && operation !== undefined) return operation
    phase = 'stopping'
    const work = stopRecords(signal)
    operation = work
    let stopped = false
    try {
      await work
      stopped = true
      safeLog(log, 'info', 'surface deployment stopped', { deploymentHash })
    } catch {
      phase = 'degraded'
      safeLog(log, 'error', 'surface deployment cleanup did not complete')
      throw new SurfaceControllerError('STOP_FAILED', 'surface deployment did not stop cleanly')
    } finally {
      if (stopped) {
        forgetRecords()
        deploymentHash = undefined
        phase = 'idle'
      }
      if (operation === work) operation = undefined
    }
  }

  async function startDeployment(deployment: ResolvedDeployment, signal: AbortSignal): Promise<void> {
    // `sources` de-duplicates within this one deployment plan.
    const sources = new Set<string>()
    for (const surface of deployment.surfaces) {
      signal.throwIfAborted()
      const sourceId = surface.instance.sourceId
      if (sources.has(sourceId)) throw new Error('duplicate surface source')
      sources.add(sourceId)
      await spawnInstance(deployment, surface, defaultArtifacts, signal)
    }
  }

  /** Spawns exactly one Surface instance and registers it under `sourceId`. Shared by the cold-boot
   * loop and `coldUpdate`; on failure it leaves cleanup to its caller, which is what the cold-boot
   * path has always relied on (`startController` drains through `stopRecords`). */
  async function spawnInstance(
    deployment: ResolvedDeployment,
    surface: ResolvedSurface,
    artifacts: SurfaceArtifactResolver,
    signal: AbortSignal,
  ): Promise<InstanceRecord> {
    const sourceId = surface.instance.sourceId
    if (surface.descriptor.artifact.kind !== 'node') {
      throw new Error('local controller does not execute OCI artifacts')
    }
    const artifact = await abortable(
      Promise.resolve(artifacts.resolveNodeArtifact(deployment, surface, signal)),
      signal,
    )
    signal.throwIfAborted()
    const leases: SurfaceSecretLease[] = []
    let handle: SurfaceRuntimeHandle | undefined
    try {
      try {
        const secrets = await resolveSecrets(surface, leases, signal)
        handle = await abortable(
          Promise.resolve(runtime.start({ deployment, surface, artifact, secrets, signal })),
          signal,
          async (late) => {
            await forceStopHandle(late, cleanupMs)
          },
        )
      } finally {
        await disposeLeases(leases, signal, cleanupMs)
      }
    } catch (error) {
      if (handle !== undefined) {
        await forceStopHandle(handle, cleanupMs).catch(() => undefined)
      }
      throw error
    }
    if (handle.sourceId !== sourceId) {
      await forceStopHandle(handle, cleanupMs).catch(() => undefined)
      throw new Error('surface runtime returned another source identity')
    }
    const record: InstanceRecord = { surface, state: 'starting', handle }
    records.set(sourceId, record)
    watchExit(record, handle)
    await waitForSurfaceHealth(handle, {
      timeoutMs: startupMs,
      intervalMs: healthIntervalMs,
      signal,
    })
    if (records.get(sourceId) !== record) {
      // The record left the table while this child was still starting (a concurrent whole-controller
      // stop clearing it). Nothing holds this handle any more -- not the table, not `discardRecord`,
      // not `watchExit`, whose own guard reads the same table -- so unless it is reaped right here it
      // is a live OS process nothing can ever reach again.
      await forceStopHandle(handle, cleanupMs).catch(() => undefined)
      throw new Error('surface exited during startup')
    }
    if (record.state === 'crashed') {
      // `watchExit` observed the exit and already ran this handle's cleanup.
      throw new Error('surface exited during startup')
    }
    record.state = 'healthy'
    return record
  }

  /** Stops the currently running instance for `sourceId` (if any), then starts the new one. A start
   * failure marks the Surface failed and does not restore the previous instance -- the Surface is
   * briefly unreachable between the stop and the new instance becoming healthy. */
  async function coldUpdate(
    deployment: ResolvedDeployment,
    surface: ResolvedSurface,
    instanceOptions?: Readonly<{ artifacts?: SurfaceArtifactResolver; signal?: AbortSignal }>,
  ): Promise<SurfaceInstanceStatus> {
    const sourceId = surface.instance.sourceId
    if (phase === 'idle') {
      return Promise.reject(new Error('surface controller has not completed an initial boot'))
    }
    const busy = guardSource(sourceId)
    if (busy !== undefined) return Promise.reject(busy)
    const callerSignal = instanceOptions?.signal ?? new AbortController().signal
    const deadlineAbort = new AbortController()
    const signal = AbortSignal.any([callerSignal, deadlineAbort.signal])
    const startupTimer = setTimeout(() => deadlineAbort.abort(), startupMs)
    startupTimer.unref?.()
    return trackSourceOperation(sourceId, async () => {
      await stopRecord(sourceId, signal)
      try {
        const record = await spawnInstance(
          deployment,
          surface,
          instanceOptions?.artifacts ?? defaultArtifacts,
          signal,
        )
        safeLog(log, 'info', 'surface instance updated', { sourceId })
        return projectInstance(record)
      } catch {
        // There is no whole-controller drain behind this update, so a failed start has to clean up
        // after itself without disturbing any other record.
        await discardRecord(sourceId)
        safeLog(log, 'error', 'surface cold update failed without restoring the previous instance', {
          sourceId,
        })
        throw new SurfaceControllerError('START_FAILED', 'surface instance failed to start')
      } finally {
        clearTimeout(startupTimer)
      }
    })
  }

  /** Idempotent: a `sourceId` with no running record needs no work, so a caller never has to
   * remember whether it already stopped this one. */
  async function stopRecord(sourceId: string, signal: AbortSignal): Promise<void> {
    const record = records.get(sourceId)
    if (record === undefined) return
    const failures: unknown[] = []
    await stopOneRecord(record, signal, Date.now() + shutdownGraceMs, failures)
    if (failures.length > 0) {
      // Leave the record in place: its child may still be alive, and the snapshot has to say so.
      safeLog(log, 'error', 'surface instance did not stop cleanly', { sourceId })
      throw new SurfaceControllerError('STOP_FAILED', 'surface instance did not stop cleanly')
    }
    records.delete(sourceId)
    safeLog(log, 'info', 'surface instance stopped', { sourceId })
  }

  /** Drains a half-started instance without touching any other record, and forgets it only if the
   * drain actually reaped the child. A child that survived TERM and KILL keeps its record (and so
   * its snapshot row, in `stopping`) plus an error log, for the same reason the whole-controller drain
   * goes `degraded` instead of clearing: a stuck process that no longer appears anywhere is worse than
   * a stale-looking row. */
  async function discardRecord(sourceId: string): Promise<void> {
    const record = records.get(sourceId)
    if (record === undefined) return
    const failures: unknown[] = []
    await stopOneRecord(record, new AbortController().signal, Date.now() + shutdownGraceMs, failures)
    if (failures.length > 0) {
      safeLog(log, 'error', 'surface instance cleanup did not complete', { sourceId })
      return
    }
    records.delete(sourceId)
  }

  function guardSource(sourceId: string): SurfaceControllerError | undefined {
    if (!perSourceOperation.has(sourceId)) return undefined
    return new SurfaceControllerError('BUSY', `surface instance operation already in flight for ${sourceId}`)
  }

  /** Holds the per-source guard for exactly as long as `run` is in flight. The release sits in this
   * `finally` rather than on a `.then()` chained off the returned promise so that it happens *before*
   * the promise settles: a caller that awaits `coldUpdate` and immediately calls it again must not be
   * told its own finished operation is still in flight. */
  function trackSourceOperation<T>(sourceId: string, run: () => Promise<T>): Promise<T> {
    perSourceOperation.add(sourceId)
    return (async () => {
      try {
        return await run()
      } finally {
        perSourceOperation.delete(sourceId)
      }
    })()
  }

  function forgetRecords(): void {
    records.clear()
  }

  async function resolveSecrets(
    surface: ResolvedSurface,
    leases: SurfaceSecretLease[],
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, string>>> {
    const resolved: Record<string, string> = Object.create(null) as Record<string, string>
    let totalBytes = 0
    for (const [name, ref] of Object.entries(surface.instance.secrets)) {
      signal.throwIfAborted()
      const result = await abortable(
        Promise.resolve(options.secrets.resolve(ref, signal)),
        signal,
        async (late) => {
          if (typeof late !== 'string') {
            await withTimeout(
              Promise.resolve().then(() => late.dispose?.()),
              cleanupMs,
            )
          }
        },
      )
      const lease = typeof result === 'string' ? { value: result } : result
      if (typeof lease.value !== 'string' || lease.value.includes('\0')) {
        throw new Error('surface secret value is invalid')
      }
      const bytes = Buffer.byteLength(lease.value)
      totalBytes += Buffer.byteLength(name) + bytes
      if (bytes > MAX_SECRET_VALUE_BYTES || totalBytes > MAX_SECRET_ENV_BYTES) {
        throw new Error('surface secret material is too large')
      }
      leases.push(lease)
      resolved[name] = lease.value
    }
    return Object.freeze(resolved)
  }

  async function stopRecords(signal: AbortSignal): Promise<void> {
    const failures: unknown[] = []
    // One grace deadline for the whole table, computed before any TERM goes out: N hung Surfaces must
    // cost one shutdown window, not N of them. `map` runs every body up to its first `await`, so all
    // TERMs are still delivered (newest record first) before the first wait resolves.
    const graceDeadline = Date.now() + shutdownGraceMs
    await Promise.all(
      [...records.values()].reverse().map((record) => stopOneRecord(record, signal, graceDeadline, failures)),
    )
    if (failures.length > 0) throw new AggregateError(failures, 'surface shutdown failed')
  }

  /** TERM -> bounded wait -> KILL -> bounded wait -> bounded cleanup for a single record. Collects
   * problems into `failures` instead of throwing so a batch stop reports every one of them at once.
   * The record itself is left in the table; removing it is the caller's call (a whole-controller stop
   * clears the table only on success, so a degraded snapshot can still show what is stuck). */
  async function stopOneRecord(
    record: InstanceRecord,
    signal: AbortSignal,
    graceDeadline: number,
    failures: unknown[],
  ): Promise<void> {
    const handle = record.handle
    if (handle === undefined) return
    record.state = 'stopping'
    try {
      handle.terminate()
    } catch (error) {
      failures.push(error)
    }
    let exit = await waitForExit(handle, graceDeadline, signal)
    if (exit === undefined) {
      try {
        handle.kill()
      } catch (error) {
        failures.push(error)
      }
      exit = await waitForExit(handle, Date.now() + killWaitMs)
      if (exit === undefined) failures.push(new Error('surface process did not exit'))
    }
    if (exit !== undefined) record.exit = exit
    try {
      await withTimeout(
        Promise.resolve().then(() => handle.cleanup()),
        cleanupMs,
      )
      if (exit !== undefined) delete record.handle
    } catch (error) {
      failures.push(error)
    }
  }

  function watchExit(record: InstanceRecord, handle: SurfaceRuntimeHandle): void {
    void handle.exited.then(async (exit) => {
      if (records.get(handle.sourceId) !== record || record.state === 'stopping') return
      record.exit = exit
      record.state = 'crashed'
      try {
        await withTimeout(
          Promise.resolve().then(() => handle.cleanup()),
          cleanupMs,
        )
        delete record.handle
      } catch {
        safeLog(log, 'error', 'surface runtime cleanup failed', { sourceId: handle.sourceId })
      }
      if (phase === 'running') phase = 'degraded'
      safeLog(log, 'error', 'surface runtime exited', {
        sourceId: handle.sourceId,
        code: exit.code,
        signal: exit.signal,
      })
    })
  }

  function projectInstance(record: InstanceRecord): SurfaceInstanceStatus {
    const sourceId = record.surface.instance.sourceId
    return Object.freeze({
      sourceId,
      package: record.surface.package,
      surfaceId: record.surface.descriptor.id,
      mount: record.surface.instance.mount,
      state: record.state,
      revision: record.surface.integrity,
      ...(record.handle === undefined ? {} : { endpoint: Object.freeze({ ...record.handle.endpoint }) }),
      ...(record.exit === undefined ? {} : { exit: Object.freeze({ ...record.exit }) }),
    })
  }

  function snapshot(): SurfaceControllerSnapshot {
    const instances = [...records.values()].map(projectInstance)
    return Object.freeze({
      phase,
      ...(deploymentHash === undefined ? {} : { deploymentHash }),
      instances: Object.freeze(instances),
    })
  }
}

async function forceStopHandle(handle: SurfaceRuntimeHandle, timeoutMs: number): Promise<void> {
  try {
    handle.terminate()
  } catch {
    // Continue to KILL and bounded cleanup.
  }
  try {
    handle.kill()
  } catch {
    // Continue to bounded cleanup.
  }
  await withTimeout(
    Promise.resolve().then(() => handle.cleanup()),
    timeoutMs,
  )
}

async function disposeLeases(
  leases: SurfaceSecretLease[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const failures: unknown[] = []
  for (const lease of leases.reverse()) {
    try {
      await abortable(
        withTimeout(
          Promise.resolve().then(() => lease.dispose?.()),
          timeoutMs,
        ),
        signal,
      )
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'surface secret cleanup failed')
}

async function waitForExit(
  handle: SurfaceRuntimeHandle,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<SurfaceExit | undefined> {
  if (signal?.aborted) return undefined
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: SurfaceExit | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined), Math.max(0, deadlineAt - Date.now()))
    timer.unref?.()
    const onAbort = () => finish(undefined)
    signal?.addEventListener('abort', onAbort, { once: true })
    void handle.exited.then(
      (exit) => finish(exit),
      () => finish(undefined),
    )
  })
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return withDeadline(task, Date.now() + timeoutMs)
}

async function withDeadline<T>(task: Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = Math.max(0, deadlineAt - Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  const hardDeadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('surface lifecycle deadline exceeded')), remaining)
    timer.unref?.()
  })
  try {
    return await Promise.race([task, hardDeadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function deadline(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError(`${label} is invalid`)
  }
  return value
}

function safeLog(
  log: SurfaceLog,
  level: 'info' | 'warn' | 'error',
  message: string,
  meta?: Readonly<Record<string, unknown>>,
): void {
  try {
    log[level](message, meta)
  } catch {
    // Diagnostics cannot affect process lifecycle.
  }
}

const SILENT_LOG: SurfaceLog = Object.freeze({
  info() {},
  warn() {},
  error() {},
})

function abortable<T>(
  task: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void | Promise<void>,
): Promise<T> {
  if (signal.aborted) {
    void task.then((value) => onLateValue?.(value)).catch(() => undefined)
    return Promise.reject(abortError())
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void task.then(
      (value) => {
        if (settled) {
          void Promise.resolve(onLateValue?.(value)).catch(() => undefined)
          return
        }
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function abortError(): Error {
  const error = new Error('surface operation aborted')
  error.name = 'AbortError'
  return error
}
