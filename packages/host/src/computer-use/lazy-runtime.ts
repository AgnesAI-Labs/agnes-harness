import type { HostComputerUseStatusSource } from '../assemble.js'
import {
  type ComputerUseDriverOperationOutcome,
  createComputerUseDriverOperationRuntime,
} from './driver-operation-runtime.js'
import type { ComputerUseBackendProvider } from './windows-driver-backend.js'

export type ComputerUseAvailability =
  | 'feature-disabled'
  | 'platform-unsupported'
  | 'driver-not-prepared'
  | 'driver-preparing'
  | 'driver-prepare-failed'

type Runtime = Readonly<{
  backend: ComputerUseBackendProvider
  controls: HostComputerUseStatusSource
  preparationOutcome?: ComputerUseDriverOperationOutcome
  dispose(): Promise<void>
}>

/** A driver is an optional local capability, not a prerequisite for starting the chat Host. */
export function createLazyComputerUseRuntime(input: {
  unavailable?: 'feature-disabled' | 'platform-unsupported'
  initialize(signal: AbortSignal): Promise<Runtime>
}): Runtime {
  let runtime: Runtime | undefined
  let closed = false
  let closing: Promise<void> | undefined
  let lifetime: AbortController | undefined
  let availability: ComputerUseAvailability = input.unavailable ?? 'driver-not-prepared'
  let pending:
    | { promise: Promise<Runtime>; abort: AbortController; waiters: number; pinned: boolean; error?: unknown }
    | undefined
  type Session = Parameters<ComputerUseBackendProvider['acquire']>[0]
  const modes = new Map<string, Parameters<ComputerUseBackendProvider['setPermissionMode']>[1]>()
  const probes = new Set<Promise<unknown>>()
  const key = (session: Session) => JSON.stringify([session.key, session.lane])
  const requireRuntime = (): Runtime => {
    if (closed || !runtime) throw new Error(`Computer Use unavailable: ${availability}`)
    return runtime
  }
  const probe = <T>(run: (active: Runtime) => Promise<T>): Promise<T> => {
    const task = Promise.resolve().then(() => run(requireRuntime()))
    probes.add(task)
    void task.then(
      () => probes.delete(task),
      () => probes.delete(task),
    )
    return task
  }
  const wait = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
    let onAbort: () => void = () => undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        }),
      ])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
  const preparation = createComputerUseDriverOperationRuntime({
    async install(_kind, task) {
      const attempt = pending
      if (!attempt) throw new Error('Computer Use preparation has no pending initializer')
      const abort = () => attempt.abort.abort(task.signal.reason)
      task.signal.addEventListener('abort', abort, { once: true })
      if (task.signal.aborted) abort()
      task.phase('installing')
      try {
        attempt.abort.signal.throwIfAborted()
        const candidate = await input.initialize(attempt.abort.signal)
        if (closed || attempt.abort.signal.aborted) {
          await candidate.dispose()
          throw new DOMException('Computer Use preparation cancelled', 'AbortError')
        }
        lifetime = attempt.abort
        runtime = candidate
        return candidate.preparationOutcome ?? 'already-current'
      } catch (error) {
        availability = 'driver-prepare-failed'
        attempt.error = error
        throw error
      } finally {
        task.signal.removeEventListener('abort', abort)
      }
    },
    async restart() {
      throw new Error('Prepare Computer Use before restarting its driver')
    },
  })
  const begin = (kind: 'install' | 'update', pinned: boolean) => {
    let resolve!: (value: Runtime) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<Runtime>((yes, no) => {
      resolve = yes
      reject = no
    })
    const attempt = { promise, abort: new AbortController(), waiters: 0, pinned, error: undefined as unknown }
    pending = attempt
    availability = 'driver-preparing'
    const operation = preparation.start(kind)
    // Join the operation's final publication and cleanup before allowing another installer.
    void preparation.settled().then(() => {
      if (pending === attempt) pending = undefined
      if (runtime) resolve(runtime)
      else reject(attempt.error ?? new Error('Computer Use preparation failed'))
    })
    // Explicit preparation has no tool caller waiting on its promise.
    void promise.catch(() => undefined)
    return operation
  }
  const prepare = async (signal: AbortSignal): Promise<Runtime> => {
    signal.throwIfAborted()
    if (closed || input.unavailable) throw new Error(`Computer Use unavailable: ${availability}`)
    if (runtime) return runtime
    if (pending?.abort.signal.aborted) {
      await wait(
        pending.promise.catch(() => undefined),
        signal,
      )
      return prepare(signal)
    }
    if (!pending) begin('install', false)
    const attempt = pending
    if (!attempt) throw new Error('Computer Use preparation did not start')
    attempt.waiters += 1
    try {
      return await wait(attempt.promise, signal)
    } finally {
      attempt.waiters -= 1
      if (!runtime && pending === attempt && attempt.waiters === 0 && !attempt.pinned) attempt.abort.abort()
    }
  }
  const close = async (): Promise<void> => {
    closed = true
    lifetime?.abort()
    pending?.abort.abort()
    await preparation.close()
    await pending?.promise.catch(() => undefined)
    await Promise.allSettled(probes)
    const active = runtime
    runtime = undefined
    modes.clear()
    await active?.dispose()
  }
  const dispose = (): Promise<void> => (closing ??= close())
  const backend: ComputerUseBackendProvider = {
    async acquire(session, signal) {
      const active = await prepare(signal)
      signal.throwIfAborted()
      if (closed) throw new Error('Computer Use runtime is closed')
      const mode = modes.get(key(session))
      if (mode) await active.backend.setPermissionMode(session, mode)
      signal.throwIfAborted()
      return active.backend.acquire(session, signal)
    },
    async release(session) {
      modes.delete(key(session))
      await runtime?.backend.release(session)
    },
    async setPermissionMode(session, mode) {
      if (closed) throw new Error('Computer Use runtime is closed')
      if (input.unavailable) return
      await runtime?.backend.setPermissionMode(session, mode)
      modes.set(key(session), mode)
    },
    status: () => runtime?.backend.status() ?? { activeSessions: 0, startAttempted: false },
    dispose,
  }
  const controls: HostComputerUseStatusSource = {
    status: () => runtime?.controls.status() ?? { availability },
    doctor: (params) => probe((active) => active.controls.doctor(params)),
    permissionsStatus: () => probe((active) => active.controls.permissionsStatus()),
    permissionsGrant: () => probe((active) => active.controls.permissionsGrant()),
    setSessionYolo: (session, enabled) =>
      backend.setPermissionMode(session, enabled ? 'unrestricted' : 'standard'),
    operationStart(kind) {
      if (closed || input.unavailable) throw new Error(`Computer Use unavailable: ${availability}`)
      const preparing = preparation.status()
      if (pending || (preparing && ['queued', 'running', 'cancelling'].includes(preparing.state)))
        throw new Error('Computer Use preparation is already in progress')
      if (runtime) return runtime.controls.operationStart(kind)
      if (kind === 'restart') throw new Error('Prepare Computer Use before restarting its driver')
      return begin(kind, true)
    },
    operationStatus(operationId) {
      const initial = preparation.status(operationId)
      const active = runtime?.controls.operationStatus(operationId)
      if (operationId) return initial ?? active
      return active && (!initial || active.startedAtMs >= initial.startedAtMs) ? active : initial
    },
    operationCancel: (operationId) =>
      preparation.status(operationId)
        ? preparation.cancel(operationId)
        : runtime?.controls.operationCancel(operationId),
  }
  return { backend, controls, dispose }
}
