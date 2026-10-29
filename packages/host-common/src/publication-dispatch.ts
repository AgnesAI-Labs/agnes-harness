import type { WorkspaceInvocationPort, WorkspaceInvocationView } from '@agnes/core'
import { admitHotPolicyEntry, type HotPolicyFacade, releaseHotPolicyEntry } from './profile-policy.js'
import type { PublicationGate } from './publication-gate.js'

export type RuntimeHandler<T> = () => T | Promise<T>

export type RuntimeResourceLease<Value> = Readonly<{
  value: Value
  release(): void
}>

export type RuntimeResourcePort<Value> = Readonly<{
  acquire(): RuntimeResourceLease<Value>
}>

/**
 * The only Host adapter from external business dispatch into the currently published runtime.
 * Ordinary handlers have no call lease: resolve under the ticket, release, then invoke. Workspace
 * handlers instead enter `WorkspaceInvocationPort.run()` while the ticket is held so its synchronous
 * acquire prefix closes the publication/lease window; the port owns the sole eventual release.
 */
export class PublicationDispatch {
  constructor(
    private readonly gate: PublicationGate,
    private readonly hotPolicy: HotPolicyFacade | undefined = undefined,
  ) {}

  async ordinary<T>(resolve: () => RuntimeHandler<T>): Promise<Awaited<T>> {
    return this.#drain('policy:capabilities', async () => {
      const ticket = await this.gate.enterDispatch()
      let handler: RuntimeHandler<T>
      try {
        handler = resolve()
      } finally {
        ticket.release()
      }
      await Promise.resolve()
      return handler() as Awaited<T>
    })
  }

  async workspace<T>(
    resolve: () => Readonly<{
      port: WorkspaceInvocationPort
      handler: (view: WorkspaceInvocationView) => T | Promise<T>
    }>,
  ): Promise<Awaited<T>> {
    return this.#drain('policy:workspace-packages', async () => {
      const ticket = await this.gate.enterDispatch()
      try {
        const target = resolve()
        return target.port.run(async (view) => target.handler(view)) as Promise<Awaited<T>>
      } finally {
        ticket.release()
      }
    })
  }

  /** Acquire a generation lease while the pointer is protected, then invoke after reopening. */
  async resource<Value, Result>(
    resolve: () => RuntimeResourcePort<Value>,
    handler: (value: Value) => Result | Promise<Result>,
  ): Promise<Awaited<Result>> {
    return this.#drain('policy:capabilities', async () => {
      const ticket = await this.gate.enterDispatch()
      let lease: RuntimeResourceLease<Value>
      try {
        lease = resolve().acquire()
      } finally {
        ticket.release()
      }
      await Promise.resolve()
      try {
        return (await handler(lease.value)) as Awaited<Result>
      } finally {
        lease.release()
      }
    })
  }

  async #drain<T>(
    row: 'policy:capabilities' | 'policy:workspace-packages',
    run: () => Promise<T>,
  ): Promise<Awaited<T>> {
    if (this.hotPolicy && !admitHotPolicyEntry(this.hotPolicy, row)) {
      throw Object.assign(new Error(`E_POLICY_DRAIN: ${row} is draining`), {
        code: 'E_POLICY_DRAIN' as const,
      })
    }
    try {
      return (await run()) as Awaited<T>
    } finally {
      if (this.hotPolicy) releaseHotPolicyEntry(this.hotPolicy)
    }
  }
}
