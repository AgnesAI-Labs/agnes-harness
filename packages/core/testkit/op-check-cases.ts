// Cases for the check an open makes of the program-counter cells, run against any storage. The cells
// are not folded from rows, so a store that holds a wrong one must fail the open rather than be
// repaired from the fold; the lease is handed back, so the next writer is refused for the same
// reason and not for a lease the failed open kept.
import assert from 'node:assert/strict'
import type { InferenceEvent, Provider } from '@agnes/protocol'
import { defaultIds } from '../src/ids.js'
import type { StorageAdapter } from '../src/log/storage.js'
import { openTracked } from '../src/reduce/tracker.js'
import { ToolRegistry } from '../src/registry/tools.js'
import type { CoreError, Seq } from '../src/types.js'
import { fakeProvider, sentFor, textTurn, toolTurn } from '../test/helpers/fake-provider.js'
import { actor, openSession, shellTool } from '../test/helpers/open-session.js'

/** A storage under test, and a way to change a program-counter cell behind its back. */
export type Tamperable = {
  make(): StorageAdapter
  /** Replaces the cell of `lane` in session `key`, or removes it when `cell` is null. */
  setOpCell(
    storage: StorageAdapter,
    key: string,
    lane: string,
    cell: { seq: Seq; data: unknown } | null,
  ): Promise<void>
}

const clock = () => 1_757_203_200_000
const say = (text: string) => ({ content: [{ type: 'text' as const, text }], actor })
const hanging = (): Provider => ({
  models: () => [],
  async *infer(req): AsyncIterable<InferenceEvent> {
    yield sentFor(req)
    await new Promise<void>(() => undefined)
  },
})

const reopen = (storage: StorageAdapter, writerRunId: string, key = 'k') =>
  openTracked({
    storage,
    key,
    writerRunId,
    ttlMs: 60_000,
    ids: defaultIds(clock),
    clock,
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
  })

/** Both opens fail on the cell, the second proving the first handed its lease back. */
async function refusedTwice(storage: StorageAdapter, key = 'k'): Promise<void> {
  for (const writer of ['after-1', 'after-2']) {
    let failure: CoreError | undefined
    try {
      const opened = await reopen(storage, writer, key)
      await opened.log.close()
    } catch (error) {
      failure = error as CoreError
    }
    assert.equal(failure?.code, 'E_LEDGER_INTEGRITY', `open by ${writer}`)
  }
}

/** A session whose turn sits in inference, closed as a killed process would leave it. */
async function turnOpen(t: Tamperable) {
  const storage = t.make()
  const h = await openSession({ provider: hanging(), storage: storage as never, clock })
  await h.session.enqueue('next-turn', say('go'))
  await h.session.step()
  await h.session.step()
  const cell = h.log.registerRow('op.state')
  assert.ok(cell)
  await h.log.close()
  return { storage, cell, lastSeq: h.log.lastSeq }
}

export const OP_CHECK_CASES: Record<string, (t: Tamperable) => Promise<void>> = {
  async 'opens a ledger whose cells agree with it'(t) {
    const { storage } = await turnOpen(t)
    const opened = await reopen(storage, 'next')
    assert.equal(opened.log.registerRow('op.state')?.data !== undefined, true)
    await opened.log.close()
  },

  async 'refuses an open turn whose cell is gone'(t) {
    const { storage } = await turnOpen(t)
    await t.setOpCell(storage, 'k', 'main', null)
    await refusedTwice(storage)
  },

  async 'refuses a cell left on a lane whose turn has ended'(t) {
    const storage = t.make()
    const h = await openSession({
      provider: fakeProvider([textTurn('done')]),
      storage: storage as never,
      clock,
    })
    await h.session.enqueue('next-turn', say('go'))
    await h.session.acceptInput()
    const cell = h.log.registerRow('op.state')
    assert.ok(cell)
    await h.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await h.session.close()
    await t.setOpCell(storage, 'k', 'main', { seq: cell.seq, data: cell.data })
    await refusedTwice(storage)
  },

  async 'refuses a cell that names another turn'(t) {
    const { storage, cell } = await turnOpen(t)
    const data = structuredClone(cell.data) as { meta: { turn: number } }
    data.meta.turn = 99
    await t.setOpCell(storage, 'k', 'main', { seq: cell.seq, data })
    await refusedTwice(storage)
  },

  async 'refuses a cell that names another lane'(t) {
    const { storage, cell } = await turnOpen(t)
    const data = structuredClone(cell.data) as { meta: { lane: string } }
    data.meta.lane = 'side'
    await t.setOpCell(storage, 'k', 'main', { seq: cell.seq, data })
    await refusedTwice(storage)
  },

  async 'refuses a cell outside its schema'(t) {
    const { storage, cell } = await turnOpen(t)
    await t.setOpCell(storage, 'k', 'main', { seq: cell.seq, data: { ...(cell.data as object), step: -1 } })
    await refusedTwice(storage)
  },

  async 'refuses a cell written after the head'(t) {
    const { storage, cell, lastSeq } = await turnOpen(t)
    await t.setOpCell(storage, 'k', 'main', { seq: lastSeq + 5, data: cell.data })
    await refusedTwice(storage)
  },

  async 'refuses a cell written before its turn started'(t) {
    const { storage, cell } = await turnOpen(t)
    const [start] = await storage.scan('k', { type: 'turn/start', order: 'desc', limit: 1 })
    assert.ok(start)
    await t.setOpCell(storage, 'k', 'main', { seq: start.seq - 1, data: cell.data })
    await refusedTwice(storage)
  },

  async 'refuses a cell whose trigger lies past the head'(t) {
    const { storage, cell, lastSeq } = await turnOpen(t)
    const data = structuredClone(cell.data) as { meta: { triggerSeq: Seq } }
    data.meta.triggerSeq = lastSeq + 5
    await t.setOpCell(storage, 'k', 'main', { seq: cell.seq, data })
    await refusedTwice(storage)
  },

  async 'refuses a dispatched call rewritten to approved at the same seq'(t) {
    const storage = t.make()
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const registry = new ToolRegistry()
    registry.add(
      shellTool(async () => {
        started()
        await new Promise<void>(() => undefined)
        return { content: [{ type: 'text' as const, text: 'never' }] }
      }),
      { source: 's', trust: 'builtin' },
    )
    const h = await openSession({
      provider: fakeProvider([toolTurn('shell', { cmd: 'rm -rf x' })]),
      registry,
      storage: storage as never,
      clock,
    })
    await h.session.enqueue('next-turn', say('delete it'))
    void h.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await running
    const cell = h.log.registerRow('op.state')
    assert.ok(cell)
    const calls = (cell.data as { phase: { batch: { calls: Array<{ status: string }> } } }).phase.batch.calls
    assert.deepEqual(
      calls.map((call) => call.status),
      ['dispatched'],
    )
    // The writer died mid-call: its lease is gone, and the cell is rewritten in place.
    await storage.release('k', 'r1')
    const data = structuredClone(cell.data) as {
      phase: { batch: { calls: Array<Record<string, unknown>> } }
    }
    for (const call of data.phase.batch.calls) {
      call.status = 'approved'
      delete call.effectId
      delete call.dispatchAttempt
      delete call.dispatchPhase
    }
    await t.setOpCell(storage, 'k', 'main', { seq: cell.seq, data })
    await refusedTwice(storage)
  },

  async 'opens a child that never wrote its first row, and refuses one holding a cell'(t) {
    const { storage, cell, lastSeq } = await turnOpen(t)
    // Cut after createChild and before session/start, at a boundary inside the parent's open turn.
    await storage.createChild('k', lastSeq, 'child')
    const unstarted = await reopen(storage, 'child-1', 'child')
    assert.equal(unstarted.log.lastSeq, lastSeq)
    await unstarted.log.close()
    // The normal path still starts it: the fork writes session/start, and the child opens a turn.
    const parent = await reopen(storage, 'parent-2')
    const forked = await parent.log.forkInto(lastSeq, 'child', {
      actor,
      agnesVersion: '0.0.1',
      preset: 'standard',
      resolvedProfileHash: null,
      writerRunId: 'child-2',
      lane: 'main',
    })
    const child = await openTracked({
      storage,
      key: 'child',
      writerRunId: 'child-2',
      ttlMs: 60_000,
      ids: defaultIds(clock),
      clock,
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      existing: forked,
    })
    const turn = child.log.lastSeq + 1
    const data = structuredClone(cell.data) as { meta: { triggerSeq: Seq; turn: number } }
    data.meta.triggerSeq = turn
    // Turn numbers carry on from the parent across a fork.
    data.meta.turn = 2
    await child.log.append(
      [
        {
          type: 'turn/start',
          origin: 'system',
          trust: 'trusted',
          actor,
          data: { turn: 2, trigger: 'prompt' },
        },
      ],
      { opState: { lane: 'main', data: data as never } },
    )
    assert.equal(child.tracker.state.openTurn.get('main')?.turn, 2)
    await child.log.close()
    await parent.log.close()
    // An unstarted child that holds a cell is not one the ledger can explain.
    await storage.createChild('k', lastSeq, 'child-b')
    await t.setOpCell(storage, 'child-b', 'main', { seq: lastSeq, data: cell.data })
    await refusedTwice(storage, 'child-b')
  },
}
