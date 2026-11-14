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
