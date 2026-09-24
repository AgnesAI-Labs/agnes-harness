import { describe, expect, it } from 'vitest'
import type { Assembled } from '../src/assemble.js'
import { createMemoryAudit } from '../src/audit.js'
import { closeHost, Rollback } from '../src/lifecycle.js'

describe('Rollback', () => {
  // The close order is the one claim the audit trail cannot make: `host.closed` being the last line
  // written says nothing about which layer came down first. The stack is what decides it, so the
  // order is observed here rather than inferred from a log.
  it('unwinds in the reverse of the order things were pushed', async () => {
    const r = new Rollback()
    const done: string[] = []
    for (const label of ['adapters', 'seams', 'kernel']) r.push(label, () => void done.push(label))
    expect(await r.unwind()).toEqual([])
    expect(done).toEqual(['kernel', 'seams', 'adapters'])
  })
  it('drains the stack as it runs, so a second unwind is a no-op', async () => {
    const r = new Rollback()
    let n = 0
    r.push('a', () => {
      n++
    })
    await r.unwind()
    await r.unwind()
    expect(n).toBe(1)
  })
  it('reports a failing teardown by label and still runs the layers under it', async () => {
    const r = new Rollback()
    const done: string[] = []
    r.push('under', () => void done.push('under'))
    r.push('broken', () => {
      throw new Error('teardown refused')
    })
    expect(await r.unwind()).toEqual(['broken'])
    expect(done).toEqual(['under'])
  })
  // A teardown that never settles strands everything below it just as thoroughly as one that throws,
  // and that is how a forced close used to leave the sqlite handle and the exec children open.
  it('bounds each entry, so one that never settles does not strand the layers under it', async () => {
    const r = new Rollback()
    const done: string[] = []
    r.push('under', () => void done.push('under'))
    r.push('hangs', () => new Promise<void>(() => {}))
    const t0 = Date.now()
    expect(await r.unwind({ timeoutMs: 20 })).toEqual(['hangs'])
    expect(done).toEqual(['under'])
    expect(Date.now() - t0).toBeLessThan(2000)
  })
  it('waits indefinitely when no deadline is given, which is the assembly-failure path', async () => {
    const r = new Rollback()
    let settled = false
    r.push('slow', async () => {
      await new Promise((res) => setTimeout(res, 30))
      settled = true
    })
    expect(await r.unwind()).toEqual([])
    expect(settled).toBe(true)
  })
})

describe('closeHost', () => {
  it('seals and drains ordinary reconciliation before unwinding the plugin tree', async () => {
    const events: string[] = []
    let releaseReconcile!: () => void
    const inFlight = new Promise<void>((resolve) => {
      releaseReconcile = resolve
    })
    const rollback = new Rollback()
    rollback.push('ordinary-plugin-tree', () => {
      events.push('tree:close')
    })
    const reconciliation = {
      close: () => {
        events.push('reconcile:close')
        return inFlight.then(() => {
          events.push('reconcile:settled')
        })
      },
    }
    const audit = createMemoryAudit()

    const closing = closeHost({ rollback, ordinaryReconciliation: reconciliation } as Assembled, new Set(), {
      timeoutMs: 100,
      audit,
    })
    await Promise.resolve()
    expect(events).toEqual(['reconcile:close'])

    releaseReconcile()
    await closing
    expect(events).toEqual(['reconcile:close', 'reconcile:settled', 'tree:close'])
  })

  it('starts every session close concurrently and tears down only after a forced drain later settles', async () => {
    const rollback = new Rollback()
    const closed: string[] = []
    rollback.push('shared', () => void closed.push('shared'))
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const started: string[] = []
    const sessions = new Set([
      {
        async close() {
          started.push('held')
          await held
          closed.push('held')
        },
      },
      {
        async close() {
          started.push('ready')
          closed.push('ready')
        },
      },
    ])
    const audit = createMemoryAudit()
    await closeHost(
      { rollback, ordinaryReconciliation: { close: async () => undefined } } as Assembled,
      sessions,
      { timeoutMs: 20, audit },
    )

    expect(started).toEqual(['held', 'ready'])
    expect(closed).toEqual(['ready'])
    expect(audit.events.some((event) => event.kind === 'host.closed')).toBe(false)

    release()
    await expect.poll(() => closed).toEqual(['ready', 'held', 'shared'])
    expect(audit.events.at(-1)).toMatchObject({ kind: 'host.closed', detail: { forced: true } })
  })

  it('bounds a stuck reconcile wait and postpones rollback until that drain settles', async () => {
    const rollback = new Rollback()
    const events: string[] = []
    rollback.push('ordinary-plugin-tree', () => void events.push('tree:close'))
    let release!: () => void
    const reconciliation = new Promise<void>((resolve) => {
      release = resolve
    })
    const audit = createMemoryAudit()

    await closeHost(
      {
        rollback,
        ordinaryReconciliation: { close: () => reconciliation.then(() => void events.push('reconciled')) },
      } as Assembled,
      new Set(),
      { timeoutMs: 1, audit },
    )
    expect(events).toEqual([])
    expect(audit.events.some((event) => event.kind === 'host.closed')).toBe(false)

    release()
    await expect.poll(() => events).toEqual(['reconciled', 'tree:close'])
    expect(audit.events.at(-1)).toMatchObject({ kind: 'host.closed', detail: { forced: true } })
  })
})
