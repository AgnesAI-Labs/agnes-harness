// Session faults: a worker session its owner archived fails the assignment for a person to decide and no other session
// opens; one its owner deleted is opened again under the same key and given the whole assignment again; a delivery
// whose outcome cannot be confirmed is recorded as such and never sent a second time or under another id.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { latestReport, ticketStage } from '../../src/core/index.js'
import { tempStore } from '../runtime/helpers.js'
import { message, world } from './world.js'

let temp: ReturnType<typeof tempStore>
beforeEach(() => {
  temp = tempStore()
})
afterEach(() => temp.close())

const ticketOf = (id: string) => temp.store.tickets.get(id)!
const workerKey = (ticketId: string) => `superagent:worker:${ticketId}`
const parsed = (text: string) => JSON.parse(text) as Record<string, unknown>

it('fails the assignment when the owner archived the worker session, hands it to a person and opens no other session', async () => {
  const w = world(temp.store, temp.dir)
  const ticketId = w.accept()
  await w.effects.idle('launch')
  await w.watched(ticketId)
  const session = w.worker(ticketId)!
  // The worker's turn fails for good; a person retries the ticket after the owner archived the worker's session.
  session.emit({
    type: 'turn/end',
    data: { reason: 'error', error: { code: 'AUTH', message: 'invalid key' } },
  })
  await vi.waitFor(() => expect(latestReport(ticketOf(ticketId))?.state).toBe('failed'))
  session.archived = true
  const before = { sessions: w.fake.sessions.size, pending: session.pending.length }
  w.engine.retryTicket(ticketId)
  await w.effects.idle('launch')
  const ticket = ticketOf(ticketId)
  expect(ticket.assignments).toHaveLength(2)
  expect(ticket.assignments[1]!.report).toMatchObject({
    state: 'failed',
    summary: `The owner archived the worker session ${workerKey(ticketId)}; Superagent opens no other session for the ticket. Restore the session and retry the ticket, or stop it.`,
  })
  expect(ticketStage(ticket)).toEqual({ stage: 'person', action: 'failed' })
  await w.effects.idle('relay')
  expect(parsed(w.relays.at(-1)!)).toMatchObject({ kind: 'worker_report', state: 'failed' })
  expect(parsed(w.relays.at(-1)!).summary).toContain('The owner archived the worker session')
  // The archived session is the ticket's only one, and it was given nothing.
  expect(w.fake.sessions.size).toBe(before.sessions)
  expect(w.fake.sessions.get(workerKey(ticketId))).toBe(session)
  expect(session.pending).toHaveLength(before.pending)
  await w.stop()
})

it('opens a worker session the owner deleted again under the same key and sends it the whole assignment again', async () => {
  const first = world(temp.store, temp.dir)
  const ticketId = first.accept()
  await first.effects.idle('launch')
  await first.watched(ticketId)
  const original = first.worker(ticketId)!
  expect(parsed(original.pending[0]!.preview)).toMatchObject({ ticket_id: ticketId, title: 'Fix login' })
  // The owner deletes the worker's session; Superagent restarts and reconciles its assignment by the session's state.
  first.fake.remove(original.id)
  await first.stop()
  const again = world(temp.store, temp.dir, { fake: first.fake })
  await again.executor.resume()
  await again.effects.idle('launch')
  const reopened = again.worker(ticketId)!
  expect(reopened).not.toBe(original)
  expect(reopened.id).toBe(workerKey(ticketId))
  expect(reopened.options).toMatchObject({
    sessionKey: workerKey(ticketId),
    preset: 'superagent-worker',
    permission: 'full-access',
  })
  // The new session has none of the old one's history, so it gets the whole assignment, not the short notice.
  const assignment = parsed(reopened.pending[0]!.preview)
  expect(assignment).toMatchObject({ ticket_id: ticketId, title: 'Fix login' })
  expect(assignment).toHaveProperty('trigger')
  const ticket = ticketOf(ticketId)
  expect(ticket.assignments).toHaveLength(2)
  expect(ticket.assignments[0]!.endedReason).toBe('hostRestarted')
  expect(ticket.assignments[1]!.state).toBe('running')
  expect(latestReport(ticket)).toBeUndefined()
  await again.stop()
})

it('records a delivery whose outcome cannot be confirmed and never sends it again or under another id', async () => {
  const w = world(temp.store, temp.dir)
  const ticketId = w.accept()
  await w.effects.idle('launch')
  await w.watched(ticketId)
  const session = w.worker(ticketId)!
  session.queueSteers = true
  session.running = true
  session.emit({ type: 'turn/start', data: { turn: 1 } })
  // A person's comment reaches the daemon, its answer is lost, and the daemon cannot confirm it either.
  session.failNext = 'landed'
  session.checkFails = true
  w.engine.receive(message('2', 'also check the logout page'))
  await vi.waitFor(() => expect(ticketOf(ticketId).delivery).toBeDefined())
  const comment = (item: { preview?: string; text?: string }) =>
    (item.preview ?? item.text ?? '').includes('also check the logout page')
  const original = session.pending.find(comment)!.commandId!
  // Tried again twice: each time it is looked up under its own id, which cannot be confirmed, and nothing is sent.
  await w.rerun('delivery')
  await w.rerun('delivery')
  expect(ticketOf(ticketId).delivery?.error).toContain('UNCERTAIN')
  expect(ticketStage(ticketOf(ticketId))).toEqual({ stage: 'person', action: 'delivery' })
  expect(ticketOf(ticketId).undelivered).toHaveLength(1)
  expect(session.pending.filter(comment).map((item) => item.commandId)).toEqual([original])
  const sends = session.calls.filter((call) => call.method === 'steer' || call.method === 'followUp')
  expect(sends.filter((call) => String(call.args[0]).includes('also check the logout page'))).toHaveLength(1)
  expect([...session.journal.keys()]).toEqual([original])
  session.unreadable = true
  const messageId = original.slice('superagent:'.length)
  expect(await w.delivery.status(session.id, messageId)).toBe('unknown')
  // Once the daemon can confirm it, the copy that landed counts: still one copy, under its first id.
  session.unreadable = false
  session.checkFails = false
  await w.rerun('delivery')
  await vi.waitFor(() => expect(ticketOf(ticketId).undelivered).toEqual([]))
  expect(ticketOf(ticketId).delivery).toBeUndefined()
  expect(session.pending.filter(comment).map((item) => item.commandId)).toEqual([original])
  expect(session.journal.size).toBe(0)
  await w.stop()
})
