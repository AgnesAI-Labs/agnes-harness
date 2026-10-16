import type { ManagedServiceInit, ManagedServiceRuntime } from '@agnes/extension-api'
import { BatchError, type Executor } from './contracts.js'
import { BatchEngine } from './engine.js'
import type { SnapshotArtifacts } from './enumerate.js'
import { Repository } from './repository.js'
import { BatchService } from './service.js'

/** Native authority and workspace/attachment bindings are admitted outside the batch plugin. */
export type ManagedBatchPorts = {
  executor: Executor
  workspaceRoot: string
  artifacts: SnapshotArtifacts
}
type ShutdownResult = { state: 'settled' | 'unknown' }
/** One driver per managed instance. The generic supervisor owns process/profile singleton fencing. */
export async function startManagedBatch(
  runtime: ManagedServiceInit & ManagedServiceRuntime,
  ports: ManagedBatchPorts,
) {
  runtime.signal.throwIfAborted()
  if (Object.keys(runtime.listeners).length) throw new BatchError('E_BATCH_LISTENER_BINDING')
  const admission = new AbortController()
  let stopping = false
  const executor: Executor = {
    ...(ports.executor.sessionBacked ? { sessionBacked: true as const } : {}),
    get authority() {
      return stopping ? { ...ports.executor.authority, durableIdempotency: false } : ports.executor.authority
    },
    lookup: (key) => ports.executor.lookup(key),
    cancel: (key) => ports.executor.cancel(key),
    dispatch(input) {
      if (stopping) throw new BatchError('E_BATCH_STOPPING')
      return ports.executor.dispatch(input)
    },
  }
  const engine = new BatchEngine(new Repository(runtime.store), executor)
  const service = new BatchService({ ...ports, engine, signal: admission.signal })
  let current: Promise<void> | undefined
  let lastError: unknown
  let timer: ReturnType<typeof setInterval> | undefined
  const tick = (): Promise<void> => {
    if (stopping) return Promise.resolve()
    current ??= service.tick().finally(() => {
      current = undefined
    })
    return current
  }
  let shutdown: Promise<ShutdownResult> | undefined
  const stop = (reason: 'disable' | 'upgrade' | 'exit', signal?: AbortSignal): Promise<ShutdownResult> => {
    stopping = true
    admission.abort(new BatchError('E_BATCH_STOPPING'))
    clearInterval(timer)
    shutdown ??= (async (): Promise<ShutdownResult> => {
      await current?.catch(() => undefined)
      // Scan completely before cancellations mutate the versioned owner store.
      const ids: string[] = []
      let cursor: string | undefined
      do {
        signal?.throwIfAborted()
        const page = await engine.repo.list(cursor)
        ids.push(
          ...page.rows.filter((m) => m.status === 'running' || m.status === 'unknown').map((m) => m.id),
        )
        cursor = page.nextCursor
      } while (cursor)
      if (reason === 'exit') return { state: ids.length ? 'unknown' : 'settled' }
      let unknown = false
      for (const id of ids) {
        signal?.throwIfAborted()
        const result = await engine.cancel(id)
        if (result.status === 'running' || result.status === 'unknown') unknown = true
      }
      return { state: unknown ? 'unknown' : 'settled' }
    })().catch(() => ({ state: 'unknown' }))
    const work = shutdown
    // A native shutdown deadline must remain effective even if the executor cannot reply.
    if (!signal) return work
    if (signal.aborted) return Promise.resolve({ state: 'unknown' })
    return new Promise((resolve) => {
      const aborted = () => resolve({ state: 'unknown' })
      signal.addEventListener('abort', aborted, { once: true })
      void work.then(resolve).finally(() => signal.removeEventListener('abort', aborted))
    })
  }
  runtime.onShutdown(stop)
  const aborted = () => {
    stopping = true
    admission.abort(runtime.signal.reason)
    clearInterval(timer)
  }
  runtime.signal.addEventListener('abort', aborted, { once: true })
  try {
    await runtime.store.transaction(() => undefined)
    runtime.signal.throwIfAborted()
    timer = setInterval(() => {
      void tick().catch((error) => {
        lastError = error
      })
    }, 1000)
    timer.unref()
    await runtime.ready({ apiVersion: '1.0.0', listeners: [] })
    return {
      service,
      tick,
      async drain() {
        await current?.catch(() => undefined)
      },
      stop,
      get lastError() {
        return lastError
      },
    }
  } catch (error) {
    aborted()
    throw error
  }
}
