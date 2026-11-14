// Delivery cases adapted from dsh-superagent (MIT) tests/delivery.spec.ts: the notice that wakes no one and the check of
// whether a session holds a message, asserted on AGH's pending inputs and session history instead of a DSH inbox.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NOTICES_NOTE_ID, SessionDelivery } from '../../src/runtime/delivery.js'
import { SessionRegistry, Sessions } from '../../src/runtime/sessions.js'
import { fakeClient } from './fake-sdk.js'
import { tempStore } from './helpers.js'

let temp: ReturnType<typeof tempStore>
beforeEach(() => {
  temp = tempStore()
})
afterEach(() => temp.close())

async function setup() {
  const fake = fakeClient()
  const sessions = new Sessions({
    client: fake.client,
    registry: new SessionRegistry(temp.store),
    orchestratorDir: () => temp.dir,
    prepareCommand: () => '',
    environment: () => ({}),
    lifetime: new AbortController().signal,
  })
  const id = await sessions.ensureOrchestrator()
  const delivery = new SessionDelivery({ sessions, store: temp.store })
  return { fake, session: fake.sessions.get(id)!, id, delivery }
}

describe('delivery', () => {
  it("steers a busy session and follows up an idle one, under the message's command id", async () => {
    const { session, id, delivery } = await setup()
    session.running = true
    expect(await delivery.deliver(id, { id: 'm1', content: 'report', mode: 'steer' })).toEqual({
      seq: expect.any(Number),
    })
    session.running = false
    await delivery.deliver(id, { id: 'm2', content: 'candidate', mode: 'steer' })
    session.running = true
    await delivery.deliver(id, { id: 'm3', content: 'queued', mode: 'followUp' })
    expect(session.calls.filter((call) => ['steer', 'followUp'].includes(call.method))).toEqual([
      { method: 'steer', args: ['report', { commandId: 'superagent:m1' }] },
      { method: 'followUp', args: ['candidate', { commandId: 'superagent:m2' }] },
      { method: 'followUp', args: ['queued', { commandId: 'superagent:m3' }] },
    ])
  })

  it('tells whether the session holds a message: waiting in its inbox, taken into its history, or neither', async () => {
    const { session, id, delivery } = await setup()
    await delivery.deliver(id, { id: 'waiting', content: 'a', mode: 'followUp' })
    session.taken.push({ commandId: 'superagent:taken', text: 'b' })
    session.pending.push({ itemId: 'x', commandId: 'other:waiting', preview: 'c' })
    expect(await delivery.status(id, 'waiting')).toBe('pending')
    expect(await delivery.status(id, 'taken')).toBe('taken')
    expect(await delivery.status(id, 'never')).toBe('absent')
  })

  it("answers unknown, and delivers nothing again, when the session's state cannot be read", async () => {
    const { session, id, delivery } = await setup()
    session.unreadable = true
    expect(await delivery.status(id, 'waiting')).toBe('unknown')
    expect(await delivery.status('superagent:worker:gone', 'waiting')).toBe('unknown')
    expect(session.calls.filter((call) => ['steer', 'followUp'].includes(call.method))).toEqual([])
  })

  it('resolves a retry after an uncertain submission under its own id, so the message arrives once', async () => {
    const { session, id, delivery } = await setup()
    session.running = true
    session.queueSteers = true
    session.failNext = 'landed'
    await expect(delivery.deliver(id, { id: 'm1', content: 'report', mode: 'steer' })).rejects.toThrow(
      'UNCERTAIN',
    )
    // The busy state flips before the retry: the original steer is confirmed, not resent as a follow-up.
    session.running = false
    await delivery.deliver(id, { id: 'm1', content: 'report', mode: 'steer' })
    expect(session.calls.filter((call) => call.method === 'checkCommand')).toEqual([
      { method: 'checkCommand', args: ['superagent:m1'] },
    ])
    expect(session.pending.map((item) => item.commandId)).toEqual(['superagent:m1'])
    // The next message goes out at once, so an ordered queue behind it moves on.
    await delivery.deliver(id, { id: 'm2', content: 'next', mode: 'steer' })
    expect(session.pending.map((item) => item.commandId)).toEqual(['superagent:m1', 'superagent:m2'])
  })

  it('retries a submission refused for good under a fresh id, whatever its receipt says', async () => {
    const { session, id, delivery } = await setup()
    session.running = true
    session.queueSteers = true
    session.failNext = 'landed'
    await expect(delivery.deliver(id, { id: 'm1', content: 'report', mode: 'steer' })).rejects.toThrow()
    // The client gave up on the submission and the copy left the inbox; only the daemon's receipt remains.
    session.journal.clear()
    session.pending = []
    session.running = false
    await delivery.deliver(id, { id: 'm1', content: 'report', mode: 'steer' })
    expect(session.pending.map((item) => item.commandId)).toEqual(['superagent:m1:r1'])
    expect(await delivery.status(id, 'm1')).toBe('pending')
  })

  it('delivers a renewed message under its next attempt, unless the session already holds a copy', async () => {
    const { session, id, delivery } = await setup()
    await delivery.deliver(id, { id: 'm1', content: 'comment', mode: 'followUp' })
    session.pending = []
    delivery.renew(id, 'm1')
    await delivery.deliver(id, { id: 'm1', content: 'comment', mode: 'followUp' })
    expect(session.pending.map((item) => item.commandId)).toEqual(['superagent:m1:r1'])
    // Taken before it was renewed: the session read it, and no second copy goes out.
    session.taken.push(
      ...session.pending.map(({ commandId, preview }) => ({
        ...(commandId ? { commandId } : {}),
        text: preview,
      })),
    )
    session.pending = []
    delivery.renew(id, 'm1')
    await delivery.deliver(id, { id: 'm1', content: 'comment', mode: 'followUp' })
    expect(session.pending).toEqual([])
    // A session that cannot be read delivers nothing.
    delivery.renew(id, 'm2')
    session.unreadable = true
    await expect(delivery.deliver(id, { id: 'm2', content: 'x', mode: 'followUp' })).rejects.toThrow()
    expect(session.calls.filter((call) => call.method === 'followUp')).toHaveLength(2)
  })

  it('rolls one live note per session forward without waking it, and keeps it across a restart', async () => {
    const { session, id, delivery } = await setup()
    expect(delivery.liveNote(id)).toBeUndefined()
    delivery.notify(id, { content: 'Settings saved: policy' })
    delivery.notify(id, { content: 'Settings saved: eval' })
    expect(delivery.liveNote(id)).toEqual({ id: NOTICES_NOTE_ID, content: 'Settings saved: eval' })
    expect(session.calls).toEqual([])
    // The note is never withdrawn: a new process reads the same note.
    const again = new SessionDelivery({
      sessions: { handle: () => Promise.reject(new Error('unused')) },
      store: temp.store,
    })
    expect(again.liveNote(id)).toEqual({ id: 'superagent-notices', content: 'Settings saved: eval' })
    expect(again.liveNote('superagent:worker:t1')).toBeUndefined()
  })
})
