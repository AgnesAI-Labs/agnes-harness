import { randomUUID } from 'node:crypto'

export type ComputerUseDriverOperationKind = 'install' | 'update' | 'restart'
export type ComputerUseDriverOperationPhase = 'queued' | 'installing' | 'restarting' | 'complete'
export type ComputerUseDriverOperationState =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
export type ComputerUseDriverOperationOutcome =
  | 'installed'
  | 'already-current'
  | 'repaired'
  | 'restarted'
  | 'lkg-restored'

export type ComputerUseDriverOperationSnapshot = Readonly<{
  operationId: string
  kind: ComputerUseDriverOperationKind
  state: ComputerUseDriverOperationState
  phase: ComputerUseDriverOperationPhase
  startedAtMs: number
  updatedAtMs: number
  outcome?: ComputerUseDriverOperationOutcome
  failure?: 'operation-failed'
}>

type TaskInput = Readonly<{
  signal: AbortSignal
  phase(value: Exclude<ComputerUseDriverOperationPhase, 'queued' | 'complete'>): void
}>

export type ComputerUseDriverOperationTasks = Readonly<{
  install(kind: 'install' | 'update', input: TaskInput): Promise<ComputerUseDriverOperationOutcome>
  restart(input: TaskInput): Promise<'restarted'>
}>

export type ComputerUseDriverOperationRuntime = Readonly<{
  start(kind: ComputerUseDriverOperationKind): ComputerUseDriverOperationSnapshot
  status(operationId?: string): ComputerUseDriverOperationSnapshot | undefined
  cancel(operationId: string): ComputerUseDriverOperationSnapshot | undefined
  settled(): Promise<void>
  close(): Promise<void>
}>

function terminal(state: ComputerUseDriverOperationState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

function cancelled(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error &&
      (error.name === 'AbortError' ||
        ('code' in error && (error as Error & { code?: unknown }).code === 'ABORT_ERR')))
  )
}

export function createComputerUseDriverOperationRuntime(
  tasks: ComputerUseDriverOperationTasks,
  options: Readonly<{ clock?: () => number; operationId?: () => string; historyLimit?: number }> = {},
): ComputerUseDriverOperationRuntime {
  const clock = options.clock ?? Date.now
  const createId = options.operationId ?? (() => `cu-${randomUUID()}`)
  const historyLimit = options.historyLimit ?? 32
  if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 256)
    throw new Error('Computer Use operation history limit is invalid')
  const records = new Map<string, ComputerUseDriverOperationSnapshot>()
  let active: Readonly<{ id: string; abort: AbortController; done: Promise<void> }> | undefined
  let closed = false

  const publish = (
    previous: ComputerUseDriverOperationSnapshot,
    patch: Partial<ComputerUseDriverOperationSnapshot>,
  ) => {
    const observed = clock()
    const updatedAtMs =
      Number.isSafeInteger(observed) && observed >= 0
        ? Math.max(previous.updatedAtMs, observed)
        : previous.updatedAtMs
    const next = Object.freeze({ ...previous, ...patch, updatedAtMs })
    records.set(next.operationId, next)
    return next
  }
  const trim = () => {
    while (records.size > historyLimit) {
      const oldest = records.keys().next().value as string | undefined
      if (oldest === undefined || oldest === active?.id) return
      records.delete(oldest)
    }
  }

  const start = (kind: ComputerUseDriverOperationKind): ComputerUseDriverOperationSnapshot => {
    if (closed) throw new Error('Computer Use operation runtime is closed')
    if (active) throw new Error('Computer Use driver operation is already running')
    const operationId = createId()
    if (!/^cu-[a-zA-Z0-9-]{1,128}$/u.test(operationId) || records.has(operationId))
      throw new Error('Computer Use operation id is invalid')
    const now = clock()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Computer Use operation clock is invalid')
    const initial = Object.freeze({
      operationId,
      kind,
      state: 'queued' as const,
      phase: 'queued' as const,
      startedAtMs: now,
      updatedAtMs: now,
    })
    records.set(operationId, initial)
    const abort = new AbortController()
    const phase = (value: 'installing' | 'restarting') => {
      const current = records.get(operationId)
      if (!current || terminal(current.state) || current.state === 'cancelling') return
      publish(current, { state: 'running', phase: value })
    }
    const done = Promise.resolve()
      .then(async () => {
        const outcome =
          kind === 'restart'
            ? await tasks.restart({ signal: abort.signal, phase })
            : await tasks.install(kind, { signal: abort.signal, phase })
        const current = records.get(operationId)
        if (!current) return
        // Cancellation is acknowledged only when the task throws an AbortError (or observes the
        // aborted signal and throws). A task may already be inside an irreversible commit when the
        // request arrives; reporting that completed commit as cancelled would lie to callers.
        publish(current, { state: 'succeeded', phase: 'complete', outcome })
      })
      .catch((error: unknown) => {
        const current = records.get(operationId)
        if (!current) return
        if (cancelled(error)) publish(current, { state: 'cancelled', phase: 'complete' })
        else publish(current, { state: 'failed', phase: 'complete', failure: 'operation-failed' })
      })
      .finally(() => {
        if (active?.id === operationId) active = undefined
        trim()
      })
    active = Object.freeze({ id: operationId, abort, done })
    return initial
  }

  return Object.freeze({
    start,
    settled: () => active?.done ?? Promise.resolve(),
    status(operationId) {
      if (operationId !== undefined) return records.get(operationId)
      if (active) return records.get(active.id)
      let latest: ComputerUseDriverOperationSnapshot | undefined
      for (const record of records.values()) latest = record
      return latest
    },
    cancel(operationId) {
      const current = records.get(operationId)
      if (!current || terminal(current.state)) return current
      if (active?.id !== operationId) return current
      const next = publish(current, { state: 'cancelling' })
      active.abort.abort()
      return next
    },
    async close() {
      if (closed) return
      closed = true
      const running = active
      running?.abort.abort()
      await running?.done
    },
  })
}
