import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import type { CommitTx } from '../src/log/storage.js'
import { CoreError } from '../src/types.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

describe('Inbox segment', () => {
  it('start() writes session/start once; enqueue replaces the inbox register whole', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    expect((await log.scan({ fromSeq: 1, limit: 5 })).map((e) => e.type)).toEqual(['session/start'])
    await session.start()
    expect((await log.scan({ fromSeq: 1, limit: 5 })).map((e) => e.type)).toEqual(['session/start'])
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'again' }], actor })
    const inbox = session.latest('inbox') as { items: Array<{ target: string; kind: string }> }
    expect(inbox.items.map((i) => [i.target, i.kind])).toEqual([
      ['next-turn', 'prompt'],
      ['next-turn', 'prompt'],
    ])
    // The whole queue is one cell, so the second write must carry the first item forward.
    expect(
      (await log.scan({ type: 'inbox', limit: 5 })).map((e) => (e.data as { items: [] }).items.length),
    ).toEqual([1, 2])
  })

  it('acceptInput claims one next-turn item into user/message + turn/start + the program counter in one tx', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect(await session.acceptInput()).toBe(true)
    const rows = await log.scan({ fromSeq: 1, limit: 20 })
    expect(rows.map((e) => e.type)).toEqual(['session/start', 'inbox', 'inbox', 'user/message', 'turn/start'])
    expect(log.registerRow('op.state')?.seq).toBe(5)
    expect(session.op()).toMatchObject({
      step: 0,
      control: { status: 'running' },
      taint: false,
      latestAssistantSeq: null,
      phase: { kind: 'checkpoint', continuation: 'need_assistant', triggerSeq: 4 },
      meta: { turn: 1, lane: 'main', presetName: 'standard', triggerSeq: 4, depthLimit: 2 },
    })
    // triggerSeq must name the user/message actually written, not the row before or after it.
    expect(rows[3]?.type).toBe('user/message')
    expect(rows[3]?.seq).toBe(4)
    expect((session.latest('inbox') as { items: unknown[] }).items).toHaveLength(0)
    expect(session.turn).not.toBeNull()
    // A queued second prompt must not open a second turn on the same lane: with one already open
    // the accept path refuses, rather than leaving the refusal to the ledger's lane check.
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'and this' }], actor })
    expect(await session.acceptInput()).toBe(false)
    expect(await log.scan({ type: 'turn/start', limit: 5 })).toHaveLength(1)
    expect((session.latest('inbox') as { items: unknown[] }).items).toHaveLength(1)
  })

  it('acceptInput is false with an empty inbox and leaves no rows behind', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    expect(await session.acceptInput()).toBe(false)
    expect(await log.scan({ fromSeq: 1, limit: 10 })).toHaveLength(1)
    // A next-step item is not a turn opener.
    await session.enqueue('next-step', { content: [{ type: 'text', text: 'later' }], actor })
    expect(await session.acceptInput()).toBe(false)
    expect(session.op()).toBeNull()
  })

  it('carries the enqueued trust and kind onto the user/message it becomes', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'from a channel' }],
      actor: { ...actor, id: 'bot' },
      kind: 'follow_up',
      trust: 'untrusted',
    })
    await session.acceptInput()
    const msg = (await log.scan({ type: 'user/message', limit: 5 }))[0]
    expect(msg).toMatchObject({ trust: 'untrusted', origin: 'principal', actor: { id: 'bot' } })
    expect(msg?.data).toMatchObject({ kind: 'follow_up' })
    const started = (await log.scan({ type: 'turn/start', limit: 5 }))[0]
    expect(started?.data).toMatchObject({ trigger: 'follow_up' })
  })

  it('a second turn gets turn number 2, and endTurn clears the program counter', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'a' }], actor })
    await session.acceptInput()
    await session.endTurn('completed')
    expect(session.op()).toBeNull()
    expect(session.turn).toBeNull()
    expect((await log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({ reason: 'completed' })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'b' }], actor })
    await session.acceptInput()
    expect(session.op()?.meta.turn).toBe(2)
  })

  it('transition guards the op.state cell it read: a stale CAS is refused', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'a' }], actor })
    await session.acceptInput()
    const stale = session.op()
    // Two transitions built from the same phase read, neither awaiting the other — the in-process
    // shape of the race, which is the one a concurrent tool batch produces. The CAS seq is captured
    // where `next` was computed, so the loser is refused instead of being handed a fresh, matching
    // seq once the lock frees up and overwriting the winner.
    const first = session.transition([], { ...(stale as NonNullable<typeof stale>), step: 1 })
    const second = session.transition([], { ...(stale as NonNullable<typeof stale>), step: 99 })
    await first
    const err = await second.then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(CoreError)
    expect((err as CoreError).code).toBe('E_CAS')
    expect(session.op()?.step).toBe(1)
    // A caller that cannot compute its next state up front derives it from whatever the lock holder
    // finds, and that form is checked against the cell it actually read — so it lands.
    await session.transition([], (cur) => ({ ...(cur as NonNullable<typeof stale>), step: 2 }))
    expect(session.op()?.step).toBe(2)
    const bad = await session.d.log
      .append(
        [
          {
            type: 'x/core/op-mark',
            lane: 'main',
            origin: 'system',
            trust: 'trusted',
            actor,
            ignorable: true,
            data: { phase: 'checkpoint' },
          },
        ],
        {
          expectedRegisterSeq: { register: 'op.state', key: 'main', seq: 1 },
          opState: { lane: 'main', data: { ...(stale as NonNullable<typeof stale>), step: 5 } },
        },
      )
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(bad).toBeInstanceOf(CoreError)
    expect((bad as CoreError).code).toBe('E_CAS')
  })

  it('a phase edge is refused when the op.state cell moved under it', async () => {
    // A storage that slips one foreign op.state write in front of the next commit, which is the
    // shape of the race the compare-and-set exists for: the phase read is no longer the phase
    // being advanced from.
    class Racing extends MemoryStorage {
      armed = false
      override async commit(key: string, tx: CommitTx) {
        if (this.armed && tx.expectedRegisterSeq) {
          this.armed = false
          if (tx.opState)
            await super.commit(key, {
              events: tx.events.slice(0, 1),
              opState: tx.opState,
              expectedWriterRunId: tx.expectedWriterRunId,
            })
        }
        return super.commit(key, tx)
      }
    }
    const storage = new Racing()
    const { session } = await openSession({ provider: fakeProvider([]), storage })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'a' }], actor })
    await session.acceptInput()
    const cur = session.op() as NonNullable<ReturnType<typeof session.op>>
    storage.armed = true
    const err = await session.transition([], { ...cur, step: 1 }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(CoreError)
    expect((err as CoreError).code).toBe('E_CAS')
  })

  it('diag writes an ignorable x/core row and never throws', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    await session.diag('contribute-conflict', { key: 'a' })
    const rows = await log.scan({ type: 'x/core/contribute-conflict', limit: 5 })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.ignorable).toBe(true)
    await session.close()
    await expect(session.diag('seam-failed', {})).resolves.toBeUndefined()
  })
})

describe('the transition lock (fix round 1)', () => {
  it('an enqueue landing beside an accept cannot shift the row triggerSeq names', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'a' }], actor })
    // A channel adapter enqueueing from another task while the turn is being opened. `enqueue` is
    // a public entry point, so this is an ordinary interleaving, not a contrived one.
    const accepted = session.acceptInput()
    const queued = session.enqueue('next-step', { content: [{ type: 'text', text: 'b' }], actor })
    await Promise.all([accepted, queued])
    const trigger = session.op()?.meta.triggerSeq
    const first = (await log.scan({ type: 'user/message', limit: 5 }))[0]
    // The anchor the whole turn is scanned from names the user's message, not an inbox row.
    expect(trigger).toBe(first?.seq)
  })

  it('two concurrent enqueues both survive', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    await Promise.all([
      session.enqueue('next-turn', { content: [{ type: 'text', text: 'a' }], actor }),
      session.enqueue('next-turn', { content: [{ type: 'text', text: 'b' }], actor }),
    ])
    expect((session.latest('inbox') as { items: unknown[] }).items).toHaveLength(2)
  })
})
