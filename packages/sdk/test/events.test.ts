import type { Cursor } from '@agnes/protocol'
import { META_KEY } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localAuth } from '../src/auth.js'
import { createClient } from '../src/client.js'
import { type JournalStore, memoryJournal } from '../src/journal.js'
import type { LedgerEvent } from '../src/session.js'
import { type FakeEndpoint, fakeEndpoint, flush, type Handler } from './helpers/fake-endpoint.js'

const providers = { local: () => localAuth() }
const init: Handler = fakeEndpoint({}).initialize
const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }

const ev = (seq: number) =>
  ({
    jsonrpc: '2.0' as const,
    method: '_agnes/v1/session.event',
    params: {
      sessionId: 's',
      event: {
        seq,
        ts: '2026-09-08T00:00:00.000Z',
        id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
        type: 'assistant/message',
        data: { content: [], stopReason: 'end_turn' },
        actor,
        origin: 'model',
        trust: 'trusted',
      },
      _meta: {
        [META_KEY]: {
          promptTurnId: '1',
          eventSequence: seq,
          generation: 1,
          lane: 'main',
          phase: 'event',
        },
      },
    },
  }) as const

type Setup = { replayOnAttach?: boolean; failAttachOn?: number; journal?: JournalStore }

function setup(bufferLimit = 1000, o: Setup = {}) {
  let highest = 0
  let attaches = 0
  const methods: Record<string, Handler> = {
    initialize: init,
    '_agnes/v1/session.attach': (p, ctx) => {
      attaches++
      if (attaches === o.failAttachOn) throw new Error('attach refused')
      const cursor = (p as { cursor?: { fromSeq: number } }).cursor
      // A real daemon answers a cursored attach by replaying the rows after the position
      // the client reports: `fromSeq` is the last row applied, not the first one wanted.
      // The client still has to recognise an overlap rather than hand it over twice.
      if (o.replayOnAttach && cursor) for (let i = cursor.fromSeq + 1; i <= highest; i++) ctx.push(ev(i))
      return { generation: 1, lastSeq: highest, resolvedProfileHash: null }
    },
    '_agnes/v1/session.detach': () => ({}),
    'session/new': () => ({ sessionId: 's' }),
  }
  // One daemon, one ledger, but a connection per run: the endpoints share the handlers
  // above, so a later client sees the same session as the one that closed.
  const live: FakeEndpoint[] = []
  const open = () => {
    const e = fakeEndpoint(methods)
    live.push(e)
    return e
  }
  const j = o.journal ?? memoryJournal('cid')
  const connect = (endpoint: FakeEndpoint) =>
    createClient({
      transport: { kind: 'inproc', endpoint: endpoint.endpoint },
      journal: j,
      authProviders: providers,
      bufferLimit,
    })
  const f = open()
  const push = (seq: number) => {
    if (seq > highest) highest = seq
    live[live.length - 1]?.push(ev(seq))
  }
  return { f, j, c: connect(f), push, reopen: () => connect(open()) }
}

const attachCalls = (f: ReturnType<typeof fakeEndpoint>) =>
  f.calls.filter((x) => x.method === '_agnes/v1/session.attach')

afterEach(() => {
  vi.useRealTimers()
})

describe('Session.events()', () => {
  it('uses an explicit opening cursor instead of replaying the older journal position', async () => {
    const journal = memoryJournal('cid')
    await journal.setCursor('s', { fromSeq: 2, generation: 1 })
    const { f, c, push } = setup(1000, { journal, replayOnAttach: true })
    const s = await c.session.new({ cwd: '/w' })
    push(8)

    const it = s.events({ cursor: { fromSeq: 7, generation: 1 } })[Symbol.asyncIterator]()
    expect((await it.next()).value?.seq).toBe(8)
    expect(attachCalls(f)).toHaveLength(1)
    expect(attachCalls(f)[0]?.params).toMatchObject({ cursor: { fromSeq: 7, generation: 1 } })
    await it.return?.()
  })

  it('attaches lazily, yields events in order, dedups by seq, persists cursor', async () => {
    const { f, j, c, push } = setup()
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    const first = it.next()
    push(1)
    push(2)
    push(2)
    push(3)
    const out = [(await first).value?.seq, (await it.next()).value?.seq, (await it.next()).value?.seq]

    expect(out).toEqual([1, 2, 3])
    await it.return?.()
    expect(await j.cursor('s')).toEqual({ fromSeq: 3, generation: 1 })
    expect(attachCalls(f)).toHaveLength(1)
  })

  it('attaches on first iteration when the caller never attached explicitly', async () => {
    const { f, c, push } = setup()
    const s = await c.session.new({ cwd: '/w' })
    expect(attachCalls(f)).toHaveLength(0)

    const it = s.events({ preview: false })[Symbol.asyncIterator]()
    const first = it.next()
    await flush()

    expect(attachCalls(f)).toHaveLength(1)
    expect(attachCalls(f)[0]?.params).toEqual({
      sessionId: 's',
      filter: { preview: false, acpUpdates: false },
    })
    push(1)
    expect((await first).value?.seq).toBe(1)
    await it.return?.()
  })

  // `cli` writes exactly this: attach to a session, then ask for a filtered stream over
  // it. Ignoring the filter hands back everything, with nothing to say it did.
  it('re-attaches with the filter events() asked for when the session is already attached', async () => {
    const { f, c, push } = setup()
    const s = await c.session.attach('s')
    expect(attachCalls(f)).toHaveLength(1)

    const it = s.events({ types: ['turn/end'] })[Symbol.asyncIterator]()
    const first = it.next()
    await flush()

    const attaches = attachCalls(f)
    expect(attaches).toHaveLength(2)
    expect(attaches[1]?.params).toMatchObject({
      filter: { types: ['turn/end'], acpUpdates: false },
      cursor: { fromSeq: 0, generation: 1 },
    })
    expect(s.filter).toEqual({ types: ['turn/end'], acpUpdates: false })
    push(1)
    expect((await first).value?.seq).toBe(1)
    await it.return?.()
  })

  it('asks for no second attach when the filter is already the one in force', async () => {
    const { f, c } = setup()
    const s = await c.session.attach('s', { filter: { preview: false } })
    const it = s.events({ preview: false })[Symbol.asyncIterator]()
    void it.next()
    await flush()

    expect(attachCalls(f)).toHaveLength(1)
    await it.return?.()
  })

  // Two iterators created in the same tick as an explicit attach: three attaches in
  // flight together settle `generation` and `filter` in whichever order they land, and
  // the filter of whichever lost is the one the caller thinks it has.
  it('attaches once for an explicit attach and two iterators started together', async () => {
    const { f, c } = setup()
    const s = await c.session.new({ cwd: '/w' })

    const explicit = s.attach()
    const a = s.events()[Symbol.asyncIterator]()
    const b = s.events()[Symbol.asyncIterator]()
    void a.next()
    void b.next()
    await explicit
    await flush()

    expect(attachCalls(f)).toHaveLength(1)
    await a.return?.()
    await b.return?.()
  })

  // A dropped row is dropped, not thrown - but a consumer parked on next() cannot tell
  // that from an idle daemon, and under `-p` that is a hang instead of an exit code.
  it('reports an inbound row it had to drop', async () => {
    const { f, c, push } = setup()
    const s = await c.session.attach('s')
    const notices: Array<{ kind?: string; sessionId?: string; seq?: number }> = []
    c.on('notice', (p) => notices.push(p as { kind?: string }))

    const good = ev(1)
    f.push({
      ...good,
      params: { ...good.params, event: { ...good.params.event, origin: 'not-an-origin' } },
    })
    push(2)
    await flush()

    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ kind: 'invalid-event', sessionId: 's', seq: 1 })
    expect(s.cursor().fromSeq).toBe(2)
  })

  it('holds a full buffer without detaching, and detaches one event past it', async () => {
    const { f, c, push } = setup(4)
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    for (let i = 1; i <= 4; i++) push(i)
    await flush()
    expect(f.calls.some((x) => x.method === '_agnes/v1/session.detach')).toBe(false)

    push(5)
    await flush()
    expect(f.calls.filter((x) => x.method === '_agnes/v1/session.detach')).toHaveLength(1)
    await it.return?.()
  })

  it('detaches once for a buffer that stays over the bound', async () => {
    const { f, c, push } = setup(4)
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    for (let i = 1; i <= 8; i++) push(i)
    await flush()

    // One detach for the overflow, not one per event that arrives while detached.
    expect(f.calls.filter((x) => x.method === '_agnes/v1/session.detach')).toHaveLength(1)
    await it.return?.()
  })

  // An odd limit is the only place the halving is observable: at `bufferLimit: 5` the
  // drain mark is two, so a queue back down to three is still not drained enough.
  it('re-attaches only once the buffer is down to half the limit, floored', async () => {
    const { f, c, push } = setup(5)
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    for (let i = 1; i <= 7; i++) push(i)
    await flush()
    expect(f.calls.filter((x) => x.method === '_agnes/v1/session.detach')).toHaveLength(1)

    for (let i = 0; i < 4; i++) await it.next()
    await flush()
    expect(attachCalls(f)).toHaveLength(1)

    await it.next()
    await flush()
    expect(attachCalls(f)).toHaveLength(2)
    await it.return?.()
  })

  it('retries a re-attach that the server refused instead of staying detached', async () => {
    const { f, c, push } = setup(4, { failAttachOn: 2 })
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    for (let i = 1; i <= 6; i++) push(i)
    await flush()

    for (let i = 0; i < 4; i++) await it.next()
    await flush()
    expect(attachCalls(f)).toHaveLength(2)
    expect(s.attached).toBe(false)

    await it.next()
    await flush()

    expect(attachCalls(f)).toHaveLength(3)
    expect(s.attached).toBe(true)
    await it.return?.()
  })

  // The reader that overflows and the reader whose drain brings the stream back need
  // not be the same one: the applied watermark is session-wide, so the leading reader
  // decides where the re-attach resumes from.
  it('re-attaches from the leading reader after the lagging reader overflowed', async () => {
    const { f, c, push } = setup(4)
    const s = await c.session.attach('s')
    const lead = s.events()[Symbol.asyncIterator]()
    const lag = s.events()[Symbol.asyncIterator]()

    for (let i = 1; i <= 4; i++) {
      push(i)
      expect((await lead.next()).value?.seq).toBe(i)
    }
    push(5)
    await flush()
    expect(f.calls.filter((x) => x.method === '_agnes/v1/session.detach')).toHaveLength(1)

    expect((await lead.next()).value?.seq).toBe(5)
    await flush()

    const attaches = attachCalls(f)
    expect(attaches).toHaveLength(2)
    expect(attaches[1]?.params).toMatchObject({ cursor: { fromSeq: 5, generation: 1 } })
    // Nothing the lagging reader had buffered is lost by any of this.
    const got: number[] = []
    for (let i = 0; i < 5; i++) got.push((await lag.next()).value?.seq as number)
    expect(got).toEqual([1, 2, 3, 4, 5])
    await lead.return?.()
    await lag.return?.()
  })

  // The two writers of `fromSeq` have to spell the same position the same way: this goes
  // red for an off-by-one in either of them, because it compares them against each other
  // rather than against whatever each happens to send today.
  it('re-attaches after a drain with exactly the position it persists', async () => {
    const { f, j, c, push } = setup(4)
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    for (let i = 1; i <= 6; i++) push(i)
    await flush()
    expect(f.calls.some((x) => x.method === '_agnes/v1/session.detach')).toBe(true)

    const got: number[] = []
    for (let i = 0; i < 4; i++) got.push((await it.next()).value?.seq as number)
    await flush()

    const attaches = attachCalls(f)
    expect(attaches).toHaveLength(2)
    expect(got).toEqual([1, 2, 3, 4])

    await s.flushCursor()
    const persisted = await j.cursor('s')
    expect(persisted).toEqual({ fromSeq: 4, generation: 1 })
    expect(attaches[1]?.params).toMatchObject({ cursor: persisted })
    await it.return?.()
  })

  // Which of the two numbers is the right one, driven off the journal in a client that
  // has no memory of the run that wrote it: `fromSeq` is the last row applied, so the
  // replay starts after it. One spelling repeats a row here, the other loses one, and
  // there is no in-memory watermark left to hide either.
  it('resumes a fresh client from the persisted cursor, repeating no row and losing none', async () => {
    const { j, c, push, reopen } = setup(1000, { replayOnAttach: true })
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    const first = it.next()
    for (let i = 1; i <= 4; i++) push(i)
    const seen = [(await first).value?.seq, (await it.next()).value?.seq]
    expect(seen).toEqual([1, 2])
    await it.return?.()
    await c.close()
    expect(await j.cursor('s')).toEqual({ fromSeq: 2, generation: 1 })

    const resumed = reopen()
    const s2 = await resumed.session.new({ cwd: '/w' })
    const it2 = s2.events()[Symbol.asyncIterator]()
    const firstResumed = it2.next()
    await flush()
    push(5)

    const got = [(await firstResumed).value?.seq, (await it2.next()).value?.seq]

    expect(got).toEqual([3, 4])
    await it2.return?.()
    await resumed.close()
  })

  it('drops the prefix the re-attach replays, so an overflow costs no duplicates', async () => {
    const { c, push } = setup(4, { replayOnAttach: true })
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    for (let i = 1; i <= 6; i++) push(i)
    await flush()

    const got: number[] = []
    // Stop at four: this is the pull that triggers the re-attach, so the replayed
    // rows land while the consumer is still behind them.
    for (let i = 0; i < 4; i++) got.push((await it.next()).value?.seq as number)
    await flush()
    push(7)
    await flush()
    for (let i = 0; i < 3; i++) got.push((await it.next()).value?.seq as number)

    expect(got).toEqual([1, 2, 3, 4, 5, 6, 7])
    await it.return?.()
  })

  // The producer never waits for the consumer: events keep landing while `next()` is
  // parked, and every one of them must come out once, in order.
  it('keeps order and loses nothing when the consumer trails the producer', async () => {
    const { c, push } = setup(1000)
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    const seen: number[] = []
    const consumer = (async () => {
      for (let i = 0; i < 20; i++) {
        const r = await it.next()
        seen.push(r.value?.seq as number)
        await new Promise((r2) => setTimeout(r2, 0))
      }
    })()
    for (let i = 1; i <= 20; i++) push(i)
    await consumer

    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    await it.return?.()
  })

  it('feeds every live iterator, and ending one leaves the others attached', async () => {
    const { f, c, push } = setup()
    const s = await c.session.attach('s')
    const a = s.events()[Symbol.asyncIterator]()
    const b = s.events()[Symbol.asyncIterator]()

    const firstA = a.next()
    const firstB = b.next()
    push(1)
    expect([(await firstA).value?.seq, (await firstB).value?.seq]).toEqual([1, 1])

    await a.return?.()
    expect(f.calls.some((x) => x.method === '_agnes/v1/session.detach')).toBe(false)

    const secondB = b.next()
    push(2)
    expect((await secondB).value?.seq).toBe(2)
    expect((await a.next()).done).toBe(true)
    await b.return?.()
  })

  it('writes the cursor every fifty events without waiting for the timer', async () => {
    vi.useFakeTimers()
    const { j, c, push } = setup()
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    for (let i = 1; i <= 50; i++) push(i)
    for (let i = 1; i <= 49; i++) await it.next()
    await flush()
    expect(await j.cursor('s')).toBeNull()

    await it.next()
    await flush()
    expect(await j.cursor('s')).toEqual({ fromSeq: 50, generation: 1 })
    await it.return?.()
  })

  it('writes the cursor on the two second tick for a stream too short to reach fifty', async () => {
    vi.useFakeTimers()
    const { j, c, push } = setup()
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    push(1)
    await it.next()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(await j.cursor('s')).toBeNull()

    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(await j.cursor('s')).toEqual({ fromSeq: 1, generation: 1 })
    await it.return?.()
  })

  it('stops feeding the buffer of an iterator that has ended', async () => {
    const { f, c, push } = setup(2)
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()
    const parked = it.next()
    await flush()

    await it.return?.()
    expect((await parked).done).toBe(true)
    expect(s.listeners.size).toBe(0)

    for (let i = 1; i <= 5; i++) push(i)
    await flush()

    // A dead iterator that kept filling its buffer would trip the overflow guard.
    expect(f.calls.some((x) => x.method === '_agnes/v1/session.detach')).toBe(false)
  })

  it('releases every parked reader when the iterator ends', async () => {
    const { c } = setup()
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    const both = Promise.all([it.next(), it.next()])
    await flush()
    await it.return?.()

    expect((await both).map((r) => r.done)).toEqual([true, true])
  })

  it('does not let a lagging reader push the cursor backwards', async () => {
    const { j, c, push } = setup()
    const s = await c.session.attach('s')
    const ahead = s.events()[Symbol.asyncIterator]()
    const behind = s.events()[Symbol.asyncIterator]()

    // `behind` buffers from the moment its iterator exists but pulls nothing until
    // `ahead` has already consumed the whole burst.
    const firstAhead = ahead.next()
    for (let i = 1; i <= 3; i++) push(i)
    await firstAhead
    await ahead.next()
    await ahead.next()
    expect((await behind.next()).value?.seq).toBe(1)

    await ahead.return?.()
    expect(await j.cursor('s')).toEqual({ fromSeq: 3, generation: 1 })
    await behind.return?.()
    expect(await j.cursor('s')).toEqual({ fromSeq: 3, generation: 1 })
  })

  it('ends a reader parked on an empty buffer when the client closes', async () => {
    const { c } = setup()
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()
    const parked = it.next()
    await flush()

    await c.close()

    expect((await parked).done).toBe(true)
  })

  it('hands over what already arrived before ending on a close', async () => {
    const { c, push } = setup()
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    push(1)
    push(2)
    await flush()
    await c.close()

    expect((await it.next()).value?.seq).toBe(1)
    expect((await it.next()).value?.seq).toBe(2)
    expect((await it.next()).done).toBe(true)
  })

  it('persists the cursor and drops the pending timer when the client closes', async () => {
    vi.useFakeTimers()
    const { j, c, push } = setup()
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    const first = it.next()
    push(1)
    await first
    // A timer still ticking towards a stream that has ended would hold a process open
    // for two more seconds after the run it belongs to is over.
    expect(vi.getTimerCount()).toBe(1)

    await c.close()
    await flush()

    expect(await j.cursor('s')).toEqual({ fromSeq: 1, generation: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  // `agnes resume` reads whatever the last run persisted, so a close that returns before
  // its own cursor write has landed resumes from a stale position.
  it('does not resolve close() until the cursor write it owes has landed', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const written: Cursor[] = []
    const journal: JournalStore = {
      ...memoryJournal('cid'),
      async setCursor(_id, cursor) {
        await gate
        written.push(cursor)
      },
    }
    const { c, push } = setup(1000, { journal })
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()
    const first = it.next()
    push(1)
    await first

    let closed = false
    const closing = c.close().then(() => {
      closed = true
    })
    await flush()
    expect([closed, written]).toEqual([false, []])

    release()
    await closing

    expect(written).toEqual([{ fromSeq: 1, generation: 1 }])
  })

  it('ends and unsubscribes the iterator when the consumer throws into it', async () => {
    const { j, c, push } = setup()
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    const first = it.next()
    push(1)
    await first
    const boom = new Error('consumer gave up')

    await expect(it.throw?.(boom)).rejects.toBe(boom)

    expect(s.listeners.size).toBe(0)
    expect(await j.cursor('s')).toEqual({ fromSeq: 1, generation: 1 })
  })

  // Concern: the persisted cursor follows whichever reader is ahead, so a restart
  // resumes past rows a lagging reader had buffered but never took. One consumer per
  // session is the shape we ship; this pins the cost of the second one.
  it('resumes a later run from the leading reader position, not the lagging one', async () => {
    const { f, j, c, push } = setup()
    const s = await c.session.attach('s')
    const ahead = s.events()[Symbol.asyncIterator]()
    const behind = s.events()[Symbol.asyncIterator]()

    const first = ahead.next()
    for (let i = 1; i <= 3; i++) push(i)
    await first
    await ahead.next()
    await ahead.next()
    expect((await behind.next()).value?.seq).toBe(1)
    await ahead.return?.()
    await behind.return?.()

    const resumed = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: j,
      authProviders: providers,
    })
    await resumed.session.attach('s')

    expect(attachCalls(f).at(-1)?.params).toMatchObject({ cursor: { fromSeq: 3, generation: 1 } })
  })

  // Both watermarks start at zero in a fresh process, so a session that resumes from a
  // cursor and then reads nothing would otherwise persist a position behind the one it
  // resumed from, and would take the boundary row from a server that replays inclusively.
  it('holds the resumed position when the new run reads nothing, and skips a replayed row', async () => {
    const j = memoryJournal('cid')
    await j.setCursor('s', { fromSeq: 2, generation: 1 })
    const { c, push } = setup(1000, { journal: j })
    const s = await c.session.attach('s')

    await s.flushCursor()
    expect(await j.cursor('s')).toEqual({ fromSeq: 2, generation: 1 })

    const it = s.events()[Symbol.asyncIterator]()
    const first = it.next()
    push(2)
    push(3)

    expect((await first).value?.seq).toBe(3)
    await it.return?.()
  })

  // The event notification is not in the I1 method table, but the envelope it carries
  // is generated, so a row that does not match it never reaches a consumer.
  it('drops an inbound row that does not match the ledger schema', async () => {
    const { f, c, push } = setup()
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    const first = it.next()
    const good = ev(1)
    f.push({
      ...good,
      params: { ...good.params, event: { ...good.params.event, origin: 'not-an-origin' } },
    })
    push(2)

    expect((await first).value?.seq).toBe(2)
    expect(s.cursor().fromSeq).toBe(2)
    await it.return?.()
  })

  // A cursor write that fails is worth no more than the next attempt; it must not
  // surface as an unhandled rejection, nor stop the rows the consumer is reading.
  it('keeps delivering rows when the journal refuses the cursor write', async () => {
    const journal: JournalStore = {
      ...memoryJournal('cid'),
      async setCursor() {
        throw new Error('journal is read only')
      },
    }
    const { c, push } = setup(1000, { journal })
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    for (let i = 1; i <= 50; i++) push(i)
    const seen: number[] = []
    for (let i = 0; i < 50; i++) seen.push((await it.next()).value?.seq as number)
    await flush()

    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    // Ending the iterator is quiet about it too. A cursor write is worth no more than the
    // next attempt, and `for await (...) { break }` must not throw on the way out.
    await expect(it.return?.()).resolves.toMatchObject({ done: true })
  })

  it('carries the harness meta alongside the ledger row', async () => {
    const { c, push } = setup()
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()

    const first = it.next()
    push(1)
    const row = (await first).value as LedgerEvent

    expect(row.type).toBe('assistant/message')
    expect(row._meta).toMatchObject({ eventSequence: 1, generation: 1, lane: 'main' })
    await it.return?.()
  })
})
