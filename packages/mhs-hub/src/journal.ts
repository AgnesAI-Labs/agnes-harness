import { createHash } from 'node:crypto'
import { type Json, MhsError, type Outcome, object } from '@agnes/mhs-device'
import type { BoundWakes, Invocation, OwnedStore, StoreTransaction, WakeTarget } from './ports.js'

export type Operation = {
  id: string
  digest: string
  device: string
  kind: 'action' | 'watch'
  state: 'accepted' | 'running' | 'terminal'
  outcome?: Outcome
  target?: WakeTarget
  sessionId?: string
  laneId?: string
}
export function digest(value: unknown): string {
  function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
    if (v !== null && typeof v === 'object')
      return `{${Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
        .join(',')}}`
    return JSON.stringify(v) ?? 'null'
  }
  return createHash('sha256').update(canonical(value)).digest('hex')
}
export class Journal {
  constructor(
    readonly store: OwnedStore,
    private readonly wakes: BoundWakes,
  ) {}
  async read(id: string): Promise<Operation | undefined> {
    return this.store.transaction((tx) => tx.get(`op/${digest(id)}`)?.value as Operation | undefined)
  }
  async accept(
    device: string,
    subject: unknown,
    invocation: Invocation,
    extra?: (tx: StoreTransaction) => void,
  ): Promise<{ fresh: boolean; operation: Operation }> {
    const hash = digest({
      subject,
      sessionId: invocation.sessionId ?? null,
      laneId: invocation.laneId ?? null,
      binding: invocation.target?.bindingId ?? null,
    })
    return this.store.transaction((tx) => {
      const key = `op/${digest(invocation.operationId)}`
      const prior = tx.get(key)
      if (prior) {
        const operation = prior.value as unknown as Operation
        if (operation.digest !== hash) throw new MhsError('ID_CONFLICT')
        return { fresh: false, operation }
      }
      const operation: Operation = {
        id: invocation.operationId,
        digest: hash,
        device,
        kind: extra ? 'watch' : 'action',
        state: 'accepted',
        ...(invocation.target ? { target: invocation.target } : {}),
        ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
        ...(invocation.laneId ? { laneId: invocation.laneId } : {}),
      }
      tx.put(key, operation as unknown as Json, null)
      extra?.(tx)
      return { fresh: true, operation }
    })
  }
  async finish(id: string, outcome: Outcome, extra?: (tx: StoreTransaction) => void): Promise<Operation> {
    return this.store.transaction((tx) => {
      const key = `op/${digest(id)}`
      const prior = tx.get(key)
      if (!prior) throw new MhsError('missing-operation')
      const operation = prior.value as unknown as Operation
      extra?.(tx)
      if (operation.state === 'terminal') return operation
      const next = { ...operation, state: 'terminal' as const, outcome }
      tx.put(key, next as unknown as Json, prior.revision)
      if (operation.target)
        tx.put(
          `outbox/${digest(id)}`,
          {
            id,
            target: { bindingId: operation.target.bindingId },
            event: {
              name: 'mhs.operation',
              summary: `${operation.device}: ${outcome.status}`,
              data: { operationId: id, status: outcome.status },
            },
          },
          null,
        )
      return next
    })
  }
  async recover(): Promise<void> {
    await this.each('op/', async (row) => {
      const operation = row as unknown as Operation
      if (operation.state !== 'terminal' && operation.kind !== 'watch')
        await this.finish(operation.id, { status: 'unknown', reason: 'restart' })
    })
    await this.flush()
  }
  async flush(): Promise<void> {
    const keys: string[] = []
    await this.each('outbox/', async (value) => {
      const row = object(value)
      const id = String(row.id)
      const queued = await this.wakes.enqueue({
        target: row.target as unknown as WakeTarget,
        idempotencyKey: `mhs/${digest(id)}/terminal`,
        event: row.event as { name: string; summary: string; data: Json },
        delivery: 'next-turn',
      })
      if (queued.state === 'queued' || queued.state === 'delivered' || queued.state === 'refused')
        keys.push(`outbox/${digest(id)}`)
    })
    for (const key of keys)
      await this.store.transaction((tx) => {
        const row = tx.get(key)
        if (row) tx.remove(key, row.revision)
      })
  }
  async each(prefix: string, consume: (value: Json) => Promise<void>): Promise<void> {
    let cursor: string | undefined
    do {
      const page = await this.store.scan({ prefix, limit: 100, ...(cursor ? { cursor } : {}) })
      for (const row of page.rows) await consume(row.value)
      cursor = page.nextCursor
    } while (cursor)
  }
}
