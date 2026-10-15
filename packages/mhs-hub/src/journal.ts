import { createHash } from 'node:crypto'
import { type Json, MhsError, type Outcome, object } from '@agnes/mhs-device'
import type { BoundWakes, Invocation, OwnedStore, StoreTransaction, WakeTarget } from './ports.js'

export type Operation = {
  id: string
  digest: string
  device: string
  kind: 'action' | 'watch'
  state: 'accepted' | 'running' | 'terminal'
  label?: string
  startedAt?: number
  endedAt?: number
  progress?: Json
  phase?: 'running' | 'paused'
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
  private flushing: Promise<void> = Promise.resolve()
  constructor(
    readonly store: OwnedStore,
    private readonly wakes: BoundWakes,
    private readonly onChange?: (operation: Operation) => void,
  ) {}
  private publish(operation: Operation) {
    try {
      this.onChange?.(operation)
    } catch {
      /* A presentation observer cannot change a committed receipt. */
    }
  }
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
    const accepted = await this.store.transaction((tx) => {
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
        startedAt: Date.now(),
        ...(subject &&
        typeof subject === 'object' &&
        !Array.isArray(subject) &&
        typeof (subject as Record<string, unknown>).action === 'string'
          ? { label: String((subject as Record<string, unknown>).action) }
          : {}),
        ...(invocation.target ? { target: invocation.target } : {}),
        ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
        ...(invocation.laneId ? { laneId: invocation.laneId } : {}),
      }
      tx.put(key, operation as unknown as Json, null)
      extra?.(tx)
      return { fresh: true, operation }
    })
    this.publish(accepted.operation)
    return accepted
  }
  /** Device progress refines an admitted live operation; it cannot reopen a terminal receipt. */
  async running(id: string, device: string, progress?: Json): Promise<Operation | undefined> {
    const updated = await this.store.transaction((tx) => {
      const key = `op/${digest(id)}`,
        prior = tx.get(key)
      if (!prior) return undefined
      const operation = prior.value as unknown as Operation
      if (operation.device !== device) return undefined
      if (operation.state === 'terminal') return operation
      const state =
        progress !== null && typeof progress === 'object' && !Array.isArray(progress)
          ? progress.state
          : undefined
      const next: Operation = {
        ...operation,
        state: 'running',
        ...(progress === undefined ? {} : { progress }),
        ...(state === 'paused' || state === 'running' ? { phase: state } : {}),
      }
      tx.put(key, next as unknown as Json, prior.revision)
      return next
    })
    if (updated) this.publish(updated)
    return updated
  }
  async finish(id: string, outcome: Outcome, extra?: (tx: StoreTransaction) => void): Promise<Operation> {
    const finished = await this.store.transaction((tx) => {
      const key = `op/${digest(id)}`
      const prior = tx.get(key)
      if (!prior) throw new MhsError('missing-operation')
      const operation = prior.value as unknown as Operation
      extra?.(tx)
      if (operation.state === 'terminal') return operation
      const next = { ...operation, state: 'terminal' as const, outcome, endedAt: Date.now() }
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
    this.publish(finished)
    return finished
  }
  async recover(): Promise<void> {
    await this.each('op/', async (row) => {
      const operation = row as unknown as Operation
      if (operation.state !== 'terminal' && operation.kind !== 'watch')
        await this.finish(operation.id, { status: 'unknown', reason: 'restart' })
      else this.publish(operation)
    })
    await this.flush()
  }
  flush(): Promise<void> {
    const run = this.flushing.catch(() => {}).then(() => this.flushPending())
    this.flushing = run
    return run
  }
  private async flushPending(): Promise<void> {
    // Persist the exact batch before enqueueing: a lost reply must retry the same membership/key.
    const page = await this.store.scan({ prefix: 'outbox/', limit: 128 })
    const groups = new Map<string, (typeof page.rows)[number][]>()
    for (const row of page.rows) {
      const binding = digest(object(row.value).target)
      const group = groups.get(binding) ?? []
      group.push(row)
      groups.set(binding, group)
    }
    for (const rows of groups.values()) {
      const id = digest(rows.map((row) => row.key).sort())
      const entries = rows.map((row) => object(row.value))
      await this.store.transaction((tx) => {
        const key = `wakebatch/${id}`
        if (!tx.get(key))
          tx.put(
            key,
            {
              batchId: id,
              idempotencyKey:
                entries.length === 1
                  ? `mhs/${digest(String(entries[0]?.id))}/terminal`
                  : `mhs/${id}/terminal-batch`,
              target: entries[0]?.target ?? null,
              event:
                entries.length === 1
                  ? (entries[0]?.event ?? null)
                  : {
                      name: 'mhs.operations',
                      summary: `${entries.length} device operations completed`,
                      data: { operations: entries.map((entry) => object(entry.event).data ?? null) },
                    },
            } as Json,
            null,
          )
        for (const row of rows) tx.remove(row.key, row.revision)
      })
    }
    await this.each('wakebatch/', async (value) => {
      const row = object(value),
        id = digest(value)
      const queued = await this.wakes.enqueue({
        target: row.target as unknown as WakeTarget,
        idempotencyKey: String(row.idempotencyKey),
        event: row.event as { name: string; summary: string; data: Json },
        delivery: 'next-turn',
      })
      if (['queued', 'delivered', 'refused'].includes(queued.state))
        await this.store.transaction((tx) => {
          const key = `wakebatch/${String(row.batchId)}`
          const stored = tx.get(key)
          if (stored && digest(stored.value) === id) tx.remove(key, stored.revision)
        })
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
