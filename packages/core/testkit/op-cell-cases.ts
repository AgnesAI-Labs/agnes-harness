// Cases for the program counter written as a register cell beside the rows, run against any
// storage: the in-memory reference and the durable adapter must behave the same way.
import assert from 'node:assert/strict'
import { scanAll } from '../src/log/scan-pages.js'
import type { CommitTx, StorageAdapter } from '../src/log/storage.js'
import { canonicalJson } from '../src/request/hash.js'
import type { CoreError, Event, EventInput } from '../src/types.js'
import { fakeProvider, textTurn } from '../test/helpers/fake-provider.js'
import { actor, openSession } from '../test/helpers/open-session.js'
import { encodeLedgerState } from './encode-ledger-state.js'

type Make = () => StorageAdapter

const say = (text: string) => ({ content: [{ type: 'text' as const, text }], actor })
const note = (lane = 'main'): EventInput => ({
  type: 'x/core/note',
  lane,
  origin: 'system',
  trust: 'trusted',
  actor,
  ignorable: true,
  data: {},
})

async function refusal(work: Promise<unknown>): Promise<CoreError> {
  try {
    await work
  } catch (error) {
    return error as CoreError
  }
  throw new Error('expected a refusal')
}

/** A session with a turn open on `lane`, stepped from its checkpoint into inference. */
async function inTurn(storage: StorageAdapter, lane = 'main', key = 'k') {
  const h = await openSession({
    provider: fakeProvider([textTurn('done')]),
    storage: storage as never,
    key,
    ...(lane === 'main' ? {} : { lane }),
  })
  await h.session.enqueue('next-turn', say('go'))
  await h.session.acceptInput()
  return h
}

export const OP_CELL_CASES: Record<string, (make: Make) => Promise<void>> = {
  async 'refuses a program counter outside its schema and writes nothing'(make) {
    const h = await inTurn(make())
    const head = h.log.lastSeq
    const cell = h.log.registerRow('op.state')
    const e = await refusal(
      h.log.append([note()], { opState: { lane: 'main', data: { step: -1 } as never } }),
    )
    assert.equal(e.code, 'E_ENVELOPE')
    assert.equal(h.log.lastSeq, head)
    assert.deepEqual(h.log.registerRow('op.state'), cell)
    assert.equal((await h.storage.scan('k', { fromSeq: head + 1, limit: 5 })).length, 0)
    await h.session.close()
  },

  async 'refuses a batch that leaves an open turn and the cells out of step'(make) {
    const h = await inTurn(make())
    const head = h.log.lastSeq
    // Removing the cell of a lane whose turn stays open.
    const cleared = await refusal(h.log.append([note()], { opState: { lane: 'main', data: null } }))
    assert.equal(cleared.code, 'E_RELATION')
    // Opening a turn with no cell to go with it.
    const opened = await refusal(
      h.log.append([
        {
          type: 'turn/start',
          lane: 'side',
          origin: 'system',
          trust: 'trusted',
          actor,
          data: { turn: 1, trigger: 'job' },
        },
      ]),
    )
    assert.equal(opened.code, 'E_RELATION')
    assert.equal(h.log.lastSeq, head)
    await h.session.close()
  },

  async 'refuses a transition built before a zero-row transition moved the cell'(make) {
    const h = await inTurn(make())
    const stale = h.session.op()
    assert.ok(stale)
    const first = h.session.transition([], { ...stale, step: 1 })
    const second = h.session.transition([], { ...stale, step: 2 })
    await first
    assert.equal((await refusal(second)).code, 'E_CAS')
    const [mark] = await h.log.scan({ fromSeq: h.log.lastSeq, limit: 1 })
    assert.equal(mark?.type, 'x/core/op-mark')
    assert.equal(h.log.registerRow('op.state')?.seq, mark?.seq)
    assert.equal(h.session.op()?.step, 1)
    await h.session.close()
  },

  async 'writes the mark of a zero-row transition on the session lane'(make) {
    const h = await inTurn(make(), 'side')
    const head = h.log.lastSeq
    await h.session.step()
    const rows = await h.log.scan({ fromSeq: head + 1, limit: 10 })
    const marks = rows.filter((row) => row.type === 'x/core/op-mark')
    assert.equal(marks.length, 1)
    assert.equal(marks[0]?.lane, 'side')
    assert.deepEqual(marks[0]?.data, { phase: 'inference' })
    assert.equal(h.log.registerRow('op.state', 'side')?.seq, h.log.lastSeq)
    assert.equal(h.log.registerRow('op.state', 'main'), undefined)
    await h.session.close()
  },

  async 'seals the session when an adapter drops the program counter it was handed'(make) {
    const inner = make()
    const dropping = new Proxy(inner, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown
        if (property === 'commit')
          return async (key: string, tx: CommitTx) => {
            const { opState: _dropped, ...rest } = tx
            const { opState: _receipt, ...receipt } = await inner.commit(key, rest)
            return receipt
          }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const h = await openSession({ provider: fakeProvider([]), storage: dropping as never })
    const faults: CoreError[] = []
    h.log.onFault((e) => faults.push(e))
    await h.session.enqueue('next-turn', say('go'))
    const e = await refusal(h.session.acceptInput())
    assert.equal(e.code, 'E_STORAGE_FAULT')
    assert.equal(h.log.faulted, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(faults.length, 1)
    await h.log.close()
  },

  async 'imports an exported session row for row, with no program counter left over'(make) {
    const storage = make()
    const h = await openSession({ provider: fakeProvider([textTurn('done')]), storage: storage as never })
    await h.session.enqueue('next-turn', say('go'))
    assert.equal(
      (await h.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason,
      'completed',
    )
    const rows = await scanAll((q) => h.log.scan(q), { fromSeq: 1, toSeq: h.log.lastSeq })
    assert.ok(rows.some((row) => row.type === 'x/core/op-mark'))
    await h.session.close()
    const copy = await openSession({
      provider: fakeProvider([]),
      storage: storage as never,
      key: 'copy',
      writerRunId: 'r2',
    })
    const start = rows[0] as Event
    // The copy's own session/start is already there; everything after it goes in as one closed batch.
    await copy.log.append(
      rows.filter((row) => row !== start).map(({ seq: _seq, ...row }) => row as EventInput),
    )
    const copied = await scanAll((q) => copy.log.scan(q), { fromSeq: 2, toSeq: copy.log.lastSeq })
    const strip = (events: Event[]) => events.map(({ seq: _seq, ...row }) => row)
    assert.deepEqual(strip(copied), strip(rows.slice(1)))
    assert.deepEqual(
      copy.log.allRegisters().filter((row) => row.register === 'op.state'),
      [],
    )
    const fold = (state: typeof copy.tracker.state) => {
      const { session: _session, ...rest } = encodeLedgerState(state)
      return canonicalJson(rest)
    }
    assert.equal(fold(copy.tracker.state), fold(h.tracker.state))
    await copy.session.close()
  },
}
