import { rpcError } from '@agnes/protocol'

export type CommandQueueErrorCode = 'RESOURCE_EXHAUSTED' | 'CLOSED'

export class CommandQueueError extends Error {
  constructor(readonly code: CommandQueueErrorCode) {
    super(code)
    this.name = 'CommandQueueError'
  }
}

type Entry<T> = {
  signal: AbortSignal
  action: (signal: AbortSignal) => Promise<T>
  guard: () => void
  controller: AbortController
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
  abort(): void
  started: boolean
}

type SessionQueue = { active: Entry<unknown> | undefined; waiting: Entry<unknown>[] }

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('The operation was aborted', 'AbortError')

export class CommandQueue {
  private readonly sessions = new Map<string, SessionQueue>()
  private pending = 0
  private closed = false
  private closing?: Promise<void>
  private finishClose: (() => void) | undefined

  constructor(
    private readonly limits: { maxPending: number; maxPerSession: number } = {
      maxPending: 1_024,
      maxPerSession: 32,
    },
  ) {
    if (![limits.maxPending, limits.maxPerSession].every((v) => Number.isSafeInteger(v) && v > 0))
      throw new RangeError('command queue limits must be positive integers')
  }

  run<T>(
    sessionId: string,
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<T>,
    guard: () => void = () => undefined,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new CommandQueueError('CLOSED'))
    if (signal.aborted) return Promise.reject(abortReason(signal))
    guard()
    const current = this.sessions.get(sessionId)
    if (
      this.pending >= this.limits.maxPending ||
      (current ? current.waiting.length + (current.active ? 1 : 0) >= this.limits.maxPerSession : false)
    )
      return Promise.reject(new CommandQueueError('RESOURCE_EXHAUSTED'))
    const queue = current ?? { active: undefined, waiting: [] }
    if (!current) this.sessions.set(sessionId, queue)
    let entry!: Entry<T>
    const promise = new Promise<T>((resolve, reject) => {
      const controller = new AbortController()
      entry = {
        signal,
        action,
        guard,
        controller,
        resolve,
        reject,
        abort: () => {
          if (entry.started) controller.abort(abortReason(signal))
          else this.cancelWaiting(sessionId, queue, entry)
        },
        started: false,
      }
    })
    queue.waiting.push(entry as Entry<unknown>)
    this.pending++
    signal.addEventListener('abort', entry.abort, { once: true })
    if (signal.aborted) entry.abort()
    else this.pump(sessionId, queue)
    return promise
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    for (const [sessionId, queue] of this.sessions) {
      for (const entry of queue.waiting.splice(0)) {
        entry.signal.removeEventListener('abort', entry.abort)
        this.pending--
        entry.reject(new CommandQueueError('CLOSED'))
      }
      queue.active?.controller.abort(new CommandQueueError('CLOSED'))
      if (!queue.active) this.sessions.delete(sessionId)
    }
    if (this.pending === 0) this.closing = Promise.resolve()
    else
      this.closing = new Promise<void>((resolve) => {
        this.finishClose = resolve
      })
    return this.closing
  }

  private cancelWaiting<T>(sessionId: string, queue: SessionQueue, entry: Entry<T>): void {
    const at = queue.waiting.indexOf(entry as Entry<unknown>)
    if (at < 0) return
    queue.waiting.splice(at, 1)
    entry.signal.removeEventListener('abort', entry.abort)
    this.pending--
    entry.reject(abortReason(entry.signal))
    if (!queue.active && queue.waiting.length === 0) this.sessions.delete(sessionId)
    this.maybeClosed()
  }

  private pump(sessionId: string, queue: SessionQueue): void {
    if (this.closed || queue.active) return
    const entry = queue.waiting.shift()
    if (!entry) return
    entry.started = true
    queue.active = entry
    void this.execute(sessionId, queue, entry)
  }

  private async execute<T>(sessionId: string, queue: SessionQueue, entry: Entry<T>): Promise<void> {
    try {
      entry.guard()
      entry.resolve(await entry.action(entry.controller.signal))
    } catch (error) {
      entry.reject(error)
    } finally {
      entry.signal.removeEventListener('abort', entry.abort)
      queue.active = undefined
      this.pending--
      if (queue.waiting.length === 0) this.sessions.delete(sessionId)
      else this.pump(sessionId, queue)
      this.maybeClosed()
    }
  }

  private maybeClosed(): void {
    if (!this.closed || this.pending !== 0 || !this.finishClose) return
    const finish = this.finishClose
    this.finishClose = undefined
    finish()
  }
}

export async function runQueued<T>(
  queue: CommandQueue,
  sessionId: string,
  signal: AbortSignal,
  action: (signal: AbortSignal) => Promise<T>,
  guard?: () => void,
): Promise<T> {
  try {
    return await queue.run(sessionId, signal, action, guard)
  } catch (error) {
    if (!(error instanceof CommandQueueError)) throw error
    throw rpcError('OVERLOADED', {
      code: error.code === 'RESOURCE_EXHAUSTED' ? error.code : 'QUEUE_CLOSED',
    })
  }
}
