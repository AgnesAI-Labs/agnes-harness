import { shutdownLadder } from './lifecycle.js'

type Resource = {
  stop?(): void | Promise<void>
  drain?(graceMs: number, signal: AbortSignal): void | Promise<void>
  force?(): void
  dispose(): void | Promise<void>
}

/** Each owner registers once; abort and normal shutdown walk the same resources backwards. */
export class AssemblyLifetime {
  readonly #resources: Resource[] = []
  #closing: Promise<void> | undefined
  #disposing: Promise<void> | undefined
  #stopping: Promise<void> | undefined
  #draining: Promise<void> | undefined
  #forced = false

  constructor(private readonly graceMs = 30_000) {}

  own(resource: Resource): void {
    if (this.#closing || this.#disposing) throw new Error('E_PACKAGE_STATE: daemon assembly is closed')
    this.#resources.push(resource)
  }

  async #each(action: (resource: Resource) => void | Promise<void>): Promise<void> {
    const errors: unknown[] = []
    for (const resource of [...this.#resources].reverse()) {
      try {
        await action(resource)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'daemon resource cleanup failed')
  }

  /** A phase owns its partial construction even if its initializer never returns. */
  phase(): AssemblyLifetime {
    const phase = new AssemblyLifetime(this.graceMs)
    this.own({
      stop: () => phase.stop(),
      drain: (graceMs, signal) => phase.drain(graceMs, signal),
      force: () => phase.force(),
      dispose: () => phase.dispose(),
    })
    return phase
  }

  async assemble<T>(
    construct: (owner: AssemblyLifetime) => T | Promise<T>,
  ): Promise<{ ready: T; dispose(): Promise<void> }> {
    const owner = this.phase()
    const ready = await construct(owner)
    return { ready, dispose: () => owner.close(this.graceMs) }
  }

  stop(): Promise<void> {
    this.#stopping ??= this.#each((resource) => resource.stop?.())
    return this.#stopping
  }

  drain(graceMs: number, signal: AbortSignal): Promise<void> {
    this.#draining ??= this.#each((resource) => {
      if (!signal.aborted) return resource.drain?.(graceMs, signal)
    })
    return this.#draining
  }

  force(): void {
    if (this.#forced || this.#disposing) return
    this.#forced = true
    const errors: unknown[] = []
    for (const resource of [...this.#resources].reverse()) {
      try {
        resource.force?.()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'daemon resource termination failed')
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#each((resource) => resource.dispose())
    return this.#disposing
  }

  close(graceMs: number, notify: () => void = () => {}): Promise<void> {
    this.#closing ??= shutdownLadder({
      graceMs,
      stopAccepting: () => this.stop(),
      notify,
      closeWorkers: (grace, signal) => this.drain(grace, signal),
      killWorkers: () => this.force(),
      closeSockets: () => this.dispose(),
      releaseLock: async () => undefined,
      log: (message) => console.error(message),
    })
    return this.#closing
  }
}

/** Only bootstrap callbacks need a readiness gate. Missing or closed always refuses. */
export function assemblyPort<T>() {
  let value: T | undefined
  let closed = false
  return {
    initialize(ready: T): void {
      if (closed || value !== undefined) throw new Error('E_PACKAGE_STATE: daemon port already initialized')
      value = ready
    },
    read(): T {
      if (closed || value === undefined) throw new Error('E_PACKAGE_STATE: daemon port is not ready')
      return value
    },
    close(): void {
      closed = true
      value = undefined
    },
  }
}

/** Non-blocking boot/recovery work still belongs to the worker owner's final release. */
export function assemblyTasks() {
  const pending = new Set<Promise<unknown>>()
  let closed = false
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      if (closed) throw new Error('E_PACKAGE_STATE: daemon work owner is closed')
      const task = work()
      pending.add(task)
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      )
      return task
    },
    async close(): Promise<void> {
      closed = true
      await Promise.allSettled([...pending])
    },
  }
}
