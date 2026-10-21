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
    const phase = new AssemblyLifetime()
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
    return { ready, dispose: () => owner.dispose() }
  }

  stop(): Promise<void> {
    return this.#each((resource) => resource.stop?.())
  }

  drain(graceMs: number, signal: AbortSignal): Promise<void> {
    return this.#each((resource) => {
      if (!signal.aborted) return resource.drain?.(graceMs, signal)
    })
  }

  force(): void {
    for (const resource of [...this.#resources].reverse()) resource.force?.()
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
