import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import type { EventInput } from '../src/index.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { opLanesAfter } from '../src/log/relations.js'
import { SessionLogImpl } from '../src/log/session-log.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

const opData = (step: number, lane: string) => ({
  meta: {
    turn: 1,
    lane,
    acceptedAt: 't',
    triggerSeq: 1,
    presetName: 'standard',
    profileHash: null,
    depthLimit: 1,
  },
  control: { status: 'running' as const },
  step,
  latestAssistantSeq: null,
  taint: false,
  phase: { kind: 'checkpoint' as const, continuation: 'need_assistant' as const, triggerSeq: 1 },
})
const op = (step: number | null, lane = 'main') => ({
  opState: { lane, data: step === null ? null : opData(step, lane) },
})
const note = (lane = 'main'): EventInput => ({
  actor,
  origin: 'system',
  trust: 'trusted',
  type: 'x/core/note',
  lane,
  ignorable: true,
  data: {},
})
const job = (jobId: string): EventInput => ({
  actor,
  origin: 'system',
  trust: 'trusted',
  type: 'artifact/job',
  register: 'artifact/job',
  data: { jobId, status: 'queued' },
})

const tableLanes = (log: SessionLogImpl) =>
  new Set(log.allRegisters().flatMap((row) => (row.register === 'op.state' ? [row.key] : [])))

const noTimers = { setTimeout: () => 0, clearTimeout: () => undefined }

async function openCounted(storage: MemoryStorage) {
  let copies = 0
  let seen: Set<string> | undefined
  const log = await SessionLogImpl.open({
    storage,
    key: 'k',
    writerRunId: 'r1',
    ttlMs: 900,
    ids: defaultIds(),
    clock: () => Date.now(),
    timers: noTimers,
    relationCheck: (_events, l, o) => {
      seen = opLanesAfter(l, o)
    },
  })
  const real = log.allRegisters.bind(log)
  log.allRegisters = () => {
    copies++
    return real()
  }
  return {
    log,
    copies: () => copies,
    seen: () => seen,
    // Reads the table without counting, so the assertion itself is not mistaken for an append's copy.
    inSync: () =>
      expect(log.opLanes()).toEqual(
        new Set(real().flatMap((r) => (r.register === 'op.state' ? [r.key] : []))),
      ),
  }
}

describe('the op lane set kept beside the register table', () => {
  it('tracks commits, tombstones, a reseed and a reopen, and appends never copy the table', async () => {
    const storage = new MemoryStorage()
    const h = await openCounted(storage)
    h.inSync()
    await h.log.append([note()], op(1))
    h.inSync()
    expect(h.log.opLanes()).toEqual(new Set(['main']))
    await h.log.append([note('side')], op(1, 'side'))
    await h.log.append([job('j1')])
    h.inSync()
    expect(h.log.opLanes()).toEqual(new Set(['main', 'side']))
    // The relation check sees the lanes as they stand once the batch's own op write lands.
    await h.log.append([note()], op(null))
    expect(h.seen()).toEqual(new Set(['side']))
    h.inSync()
    expect(h.copies()).toBe(0)

    const rows = h.log.allRegisters()
    h.log.replaceRegisterCache(rows.filter((row) => row.register !== 'op.state'))
    h.inSync()
    expect(h.log.opLanes().size).toBe(0)
    h.log.replaceRegisterCache(rows)
    h.inSync()
    expect(h.log.opLanes()).toEqual(new Set(['side']))

    // The set a caller gets is its own: changing it leaves the log's set alone.
    h.log.opLanes().add('ghost')
    h.inSync()
    await h.log.close()

    const reopened = await openCounted(storage)
    reopened.inSync()
    expect(reopened.log.opLanes()).toEqual(new Set(['side']))
    await reopened.log.close()
  })

  it('stays equal to the table across a whole turn and is empty once it ends', async () => {
    const h = await openSession({ provider: fakeProvider([textTurn('hi')]) })
    const inSync = () => expect(h.log.opLanes()).toEqual(tableLanes(h.log))
    inSync()
    await h.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect(await h.session.step()).toEqual({ phase: 'checkpoint' })
    inSync()
    expect(h.log.opLanes()).toEqual(new Set(['main']))
    h.log.replaceRegisterCache(h.log.allRegisters())
    inSync()
    await h.session.run({ until: 'turn-end', signal: new AbortController().signal })
    inSync()
    expect(h.log.opLanes().size).toBe(0)
  })
})
