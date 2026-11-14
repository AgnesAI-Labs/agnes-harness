// Model faults: a worker turn that ends with a passing provider failure (429, a 5xx) is resumed three times, after 15,
// 30 and 60 seconds; a fourth failure in a row fails the assignment and hands it to a person through the main session.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { canRetry, key, latestReport, ticketStage } from '../../src/core/index.js'
import type { FakeSession } from '../runtime/fake-sdk.js'
import { tempStore } from '../runtime/helpers.js'
import { world } from './world.js'

let temp: ReturnType<typeof tempStore>
beforeEach(() => {
  temp = tempStore()
})
afterEach(() => {
  vi.useRealTimers()
  temp.close()
})

/** The provider failures of three turns in a row, each with the wait before the turn is resumed. */
const PASSING = [
  [{ code: 'RATE_LIMIT', message: '429 Too Many Requests' }, 15_000],
  [{ code: 'TRANSPORT', message: 'HTTP 503 Service Unavailable' }, 30_000],
  [{ code: 'TRANSPORT', message: 'HTTP 502 Bad Gateway' }, 60_000],
] as const

/** Starts a ticket's worker and fails its turn three times, checking each wait; returns the worker. */
async function failThrice(w: ReturnType<typeof world>, ticketId: string): Promise<FakeSession> {
  await w.effects.idle('launch')
  await w.watched(ticketId)
  const session = w.worker(ticketId)!
  const assignmentId = temp.store.tickets.get(ticketId)!.assignments[0]!.id
  const resumed = (attempt: number) =>
    session.pending.some((item) => item.commandId === `superagent:${key(`retry:${assignmentId}:${attempt}`)}`)
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  for (const [index, [error, wait]] of PASSING.entries()) {
    session.emit({ type: 'turn/start', data: { turn: index + 1 } })
    session.emit({ type: 'turn/end', data: { reason: 'error', error } })
    await vi.waitFor(() =>
      expect(w.executor.modelRetry(session.id).model_retry).toMatchObject({
        code: error.code,
        attempts: index + 1,
      }),
    )
    expect(w.health.models).toMatchObject({ state: 'error' })
    expect(w.health.models?.detail).toContain(`retried ${index + 1} times`)
    // Each wait doubles: not resumed a moment before it ends, resumed when it does.
    await vi.advanceTimersByTimeAsync(wait - 100)
    expect(resumed(index + 1)).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    await vi.waitFor(() => expect(resumed(index + 1)).toBe(true))
    expect(latestReport(temp.store.tickets.get(ticketId)!)).toBeUndefined()
  }
  vi.useRealTimers()
  return session
}

it('resumes a turn that failed for a 429 or a 5xx three times, after 15, 30 and 60 s, and goes on once a turn succeeds', async () => {
  const w = world(temp.store, temp.dir)
  const ticketId = w.accept()
  const session = await failThrice(w, ticketId)
  // The fourth turn succeeds: the wait is over, and the worker's turn ends as any other.
  session.assistant.push('Fixed the login page.')
  session.emit({ type: 'turn/start', data: { turn: 4 } })
  session.emit({ type: 'turn/end', data: { reason: 'completed', lastAssistantSeq: 1 } })
  await vi.waitFor(() => expect(latestReport(temp.store.tickets.get(ticketId)!)?.state).toBe('waiting'))
  const ticket = temp.store.tickets.get(ticketId)!
  expect(ticket.ended).toBeUndefined()
  expect(ticket.assignments).toHaveLength(1)
  expect(ticket.assignments[0]!.state).toBe('running')
  expect(ticketStage(ticket)).toEqual({ stage: 'idle' })
  expect(w.executor.modelRetry(session.id)).toEqual({})
  expect(w.health.models).toMatchObject({ state: 'ready' })
  await w.stop()
})

it('fails the assignment on a fourth failure in a row and hands it to a person, without resuming it again', async () => {
  const w = world(temp.store, temp.dir)
  const ticketId = w.accept()
  const session = await failThrice(w, ticketId)
  session.emit({ type: 'turn/start', data: { turn: 4 } })
  session.emit({
    type: 'turn/end',
    data: { reason: 'error', error: { code: 'RATE_LIMIT', message: '429 Too Many Requests' } },
  })
  await vi.waitFor(() => expect(latestReport(temp.store.tickets.get(ticketId)!)?.state).toBe('failed'))
  const ticket = temp.store.tickets.get(ticketId)!
  expect(latestReport(ticket)?.summary).toBe('RATE_LIMIT: 429 Too Many Requests')
  // The assignment's report is failed, and the ticket waits for a person (to retry or stop it), open.
  expect(ticket.assignments).toHaveLength(1)
  expect(ticket.assignments[0]!.report).toMatchObject({ state: 'failed' })
  expect(ticketStage(ticket)).toEqual({ stage: 'person', action: 'failed' })
  expect(canRetry(ticket)).toBe(true)
  expect(ticket.ended).toBeUndefined()
  // The main session is told, which hands the failure to a person.
  await w.effects.idle('relay')
  const relay = JSON.parse(w.relays.at(-1)!) as Record<string, unknown>
  expect(relay).toMatchObject({
    kind: 'worker_report',
    state: 'failed',
    summary: 'RATE_LIMIT: 429 Too Many Requests',
    read: `ticket/${ticketId}/result`,
  })
  expect(w.executor.modelRetry(session.id)).toEqual({})
  expect(w.health.models).toMatchObject({ state: 'ready' })
  // Nothing resumes it any more.
  const before = session.pending.length
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(session.pending).toHaveLength(before)
  await w.stop()
})
