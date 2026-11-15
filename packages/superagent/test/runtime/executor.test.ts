// Executor cases adapted from dsh-superagent (MIT) tests/runtime.spec.ts: launch, prepare failure, a worker's turn ending
// without a report, passing and lasting turn failures, the stop of an ended ticket and the reconcile after a restart,
// asserted on the AGH session calls and events instead of a DSH agent.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Effects } from '../../src/app/effects.js'
import { type Candidate, Engine, key, latestReport, type Policy, type Trigger } from '../../src/core/index.js'
import { HealthBoard } from '../../src/infra/health.js'
import { SettingsSchema } from '../../src/policy.js'
import { SessionDelivery } from '../../src/runtime/delivery.js'
import { SuperagentExecutor } from '../../src/runtime/executor.js'
import { SessionRegistry, Sessions } from '../../src/runtime/sessions.js'
import { fakeClient } from './fake-sdk.js'
import { tempStore } from './helpers.js'

let temp: ReturnType<typeof tempStore>
beforeEach(() => {
  temp = tempStore()
})
afterEach(() => temp.close())

const ticketOf = (id: string) => temp.store.tickets.get(id)!
const message = (id: string): Trigger => ({
  id,
  source: 'chat',
  threads: [{ source: 'chat', id: 'th' }],
  actor: { source: 'chat', id: 'alice' },
  human: true,
  at: `2026-11-14T00:00:${id.padStart(2, '0')}Z`,
  text: `please fix ${id}`,
  channel: { source: 'chat', thread: 'th', address: { message: id } },
  meta: {},
})

function setup(prepare = '') {
  temp.store.saveSettings(SettingsSchema.parse({ executor: { prepare, directory: join(temp.dir, 'work') } }))
  const fake = fakeClient()
  const registry = new SessionRegistry(temp.store)
  const lifetime = new AbortController()
  const sessions = new Sessions({
    client: fake.client,
    registry,
    orchestratorDir: () => temp.dir,
    prepareCommand: () => temp.store.settings().executor.prepare,
    environment: () => ({}),
    lifetime: lifetime.signal,
  })
  const delivery = new SessionDelivery({ sessions, store: temp.store })
  const effects = new Effects(temp.store, new HealthBoard())
  const relays: string[] = []
  effects.handle('relay', async ({ text }) => {
    relays.push(text)
  })
  const requests: Candidate[] = []
  const policy: Policy = {
    version: 'v1',
    paused: false,
    evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    revalidate: () => true,
    admitsInferred: () => false,
  }
  let closing = false
  let engine!: Engine
  const deliveries = new HealthBoard().claim('deliveries')
  const executor = new SuperagentExecutor({
    get engine() {
      return engine
    },
    store: temp.store,
    effects,
    health: new HealthBoard().claim('worker'),
    deliveries,
    stateDir: temp.dir,
    lifetime: lifetime.signal,
    sessions,
    delivery,
    relay: (id, text) => effects.enqueue('relay', id, { text }),
    closing: () => closing,
    paused: () => false,
    environment: () => [],
    sourceLink: async () => ({}),
    repliedTo: () => undefined,
  })
  engine = new Engine({
    repo: temp.store,
    scope: { scope: () => ({ listened: true, observed: false }) },
    policy: () => policy,
    assessor: { request: (candidate) => requests.push(candidate) },
    executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
    prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome),
  })
  const accept = () => {
    engine.receive(message('1'))
    engine.evaluateDue()
    const candidate = requests.at(-1)!
    return engine.decide(candidate.triggers[0]!.id, {
      kind: 'accept',
      title: 'Fix login',
      scope: 'small',
      reason: 'requested',
      acknowledgement: 'ok',
      name: 'fix-login',
      evalId: candidate.evalId,
    }).ticketId!
  }
  effects.start()
  const worker = (ticketId: string) => fake.sessions.get(`superagent:worker:${ticketId}`)
  /** Waits until the executor reads the worker session's events. */
  const watched = (ticketId: string) => vi.waitFor(() => expect(worker(ticketId)?.listening()).toBe(1))
  return {
    fake,
    engine,
    executor,
    effects,
    relays,
    deliveries,
    accept,
    worker,
    watched,
    stop: () => {
      closing = true
      lifetime.abort()
      return executor.shutdown()
    },
  }
}

describe('the executor', () => {
  it("launches a ticket's worker session in its ticket directory and starts the assignment", async () => {
    const { accept, effects, worker, engine, stop } = setup()
    const ticketId = accept()
    await effects.idle('launch')
    const ticket = ticketOf(ticketId)
    expect(ticket.assignments.at(-1)?.state).toBe('running')
    expect(existsSync(ticket.execution!.directory)).toBe(true)
    const session = worker(ticketId)!
    expect(session.options).toMatchObject({ cwd: ticket.execution!.directory, preset: 'superagent-worker' })
    const first = session.calls.find((call) => call.method === 'followUp')!
    expect(first.args[1]).toEqual({ commandId: `superagent:${key(`assignment:${ticketId}`)}` })
    expect(JSON.parse(first.args[0] as string)).toMatchObject({
      ticket_id: ticketId,
      title: 'Fix login',
      trigger: { trigger_id: '1', text: 'please fix 1' },
    })
    await stop()
  })

  it('fails the ticket when its prepare command fails, without retrying it', async () => {
    const { accept, effects, engine, relays, fake, stop } = setup('exit 7')
    const ticketId = accept()
    await effects.idle('launch')
    await effects.idle('relay')
    expect(latestReport(ticketOf(ticketId))).toMatchObject({ state: 'failed' })
    expect(latestReport(ticketOf(ticketId))?.summary).toMatch(/prepare command failed \(exit 7\)/)
    expect(fake.sessions.size).toBe(0)
    expect(relays.join('\n')).toContain('failed')
    await stop()
  })

  it('reports a worker whose turn ended without a report as waiting, with its last answer', async () => {
    const { accept, effects, worker, watched, relays, stop } = setup()
    const ticketId = accept()
    await effects.idle('launch')
    await watched(ticketId)
    const session = worker(ticketId)!
    session.assistant.push('I looked at it and need the stack trace.')
    session.emit({ type: 'turn/end', data: { reason: 'completed', lastAssistantSeq: 1 } })
    await vi.waitFor(() => expect(latestReport(ticketOf(ticketId))?.state).toBe('waiting'))
    expect(latestReport(ticketOf(ticketId))?.summary).toBe('I looked at it and need the stack trace.')
    await effects.idle('relay')
    expect(relays.at(-1)).toContain('need the stack trace')
    await stop()
  })

  it('fails the ticket on a lasting turn failure, and lets a passing one retry', async () => {
    const { accept, effects, executor, worker, watched, stop } = setup()
    const ticketId = accept()
    await effects.idle('launch')
    await watched(ticketId)
    const session = worker(ticketId)!
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      session.emit({
        type: 'turn/end',
        data: { reason: 'error', error: { code: 'RATE_LIMIT', message: 'provider busy' } },
      })
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0))
      expect(latestReport(ticketOf(ticketId))).toBeUndefined()
      // The ticket card shows the wait while the worker waits it out.
      expect(executor.modelRetry(session.id)).toEqual({
        model_retry: {
          sessionId: session.id,
          code: 'RATE_LIMIT',
          attempts: 1,
          since: expect.any(String),
          lastAt: expect.any(String),
        },
      })
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.waitFor(() =>
        expect(
          session.pending.some(
            (item) =>
              item.commandId === `superagent:${key(`retry:${ticketOf(ticketId).assignments[0]!.id}:1`)}`,
          ),
        ).toBe(true),
      )
    } finally {
      vi.useRealTimers()
    }
    session.emit({
      type: 'turn/end',
      data: { reason: 'error', error: { code: 'invalid_request', message: 'bad schema' } },
    })
    await vi.waitFor(() => expect(latestReport(ticketOf(ticketId))).toMatchObject({ state: 'failed' }))
    expect(executor.modelRetry(session.id)).toEqual({})
    await stop()
  })

  it('cancels the running turn and kills the jobs of a ticket a person stopped', async () => {
    const { accept, effects, engine, worker, watched, stop } = setup()
    const ticketId = accept()
    await effects.idle('launch')
    await watched(ticketId)
    const session = worker(ticketId)!
    session.jobs.push({ id: 'j1', owner: 'agent', status: 'running', command: 'npm run dev' })
    session.running = true
    session.emit({ type: 'turn/start', data: { turn: 2 } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    engine.stopTicket(ticketId)
    await vi.waitFor(() => {
      expect(session.calls.some((call) => call.method === 'cancel')).toBe(true)
      expect(session.jobs[0]!.status).toBe('killed')
    })
    await stop()
  })

  it("delivers a person's comment put back at a restart again under a fresh command id, and exactly once", async () => {
    const first = setup()
    const ticketId = first.accept()
    await first.effects.idle('launch')
    await first.watched(ticketId)
    const session = first.worker(ticketId)!
    session.queueSteers = true
    session.running = true
    session.emit({ type: 'turn/start', data: { turn: 1 } })
    // A person comments while the worker is busy: the comment waits in the worker's inbox.
    first.engine.receive({ ...message('2'), text: 'also check the logout page' })
    await vi.waitFor(() => expect(ticketOf(ticketId).undelivered).toEqual([]))
    const comment = (item: { preview?: string; text?: string }) =>
      (item.preview ?? item.text ?? '').includes('also check the logout page')
    const original = session.pending.find(comment)!
    expect(original.commandId).toMatch(/^superagent:[0-9a-f]{32}$/)
    // The daemon restarts: the turn ends, the comment stays queued, and Superagent starts again and re-dispatches.
    await first.stop()
    session.running = false
    const again = setup()
    again.fake.sessions.set(session.id, session)
    await again.executor.resume()
    await again.effects.idle('launch')
    await vi.waitFor(() => expect(ticketOf(ticketId).undelivered).toEqual([]))
    await again.effects.idle('delivery')
    const copies = [...session.pending.filter(comment), ...session.taken.filter(comment)]
    expect(copies).toHaveLength(1)
    expect(copies[0]!.commandId).toBe(`${original.commandId}:r1`)
    expect(ticketOf(ticketId).assignments).toHaveLength(2)
    expect(ticketOf(ticketId).delivery).toBeUndefined()
    // The worker taking that copy reads the comment.
    expect(ticketOf(ticketId).inputs.find((input) => input.kind === 'trigger')?.readAt).toBeNull()
    await again.watched(ticketId)
    session.emit({ type: 'user/message', data: { commandId: copies[0]!.commandId } })
    await vi.waitFor(() =>
      expect(ticketOf(ticketId).inputs.find((input) => input.kind === 'trigger')?.readAt).toEqual(
        expect.any(String),
      ),
    )
    await again.stop()
  })

  it("delivers a person's comment whose delivery was unconfirmed at the restart exactly once, under a fresh id", async () => {
    const first = setup()
    const ticketId = first.accept()
    await first.effects.idle('launch')
    await first.watched(ticketId)
    const session = first.worker(ticketId)!
    session.queueSteers = true
    session.running = true
    session.emit({ type: 'turn/start', data: { turn: 1 } })
    // The comment reaches the daemon but its answer is lost: the submission is left unconfirmed.
    session.failNext = 'landed'
    first.engine.receive({ ...message('2'), text: 'also check the logout page' })
    await vi.waitFor(() => expect(ticketOf(ticketId).delivery).toBeDefined())
    expect(session.journal.size).toBe(1)
    const comment = (item: { preview?: string; text?: string }) =>
      (item.preview ?? item.text ?? '').includes('also check the logout page')
    const original = session.pending.find(comment)!
    await first.stop()
    session.running = false
    // While the daemon cannot confirm it, the relaunch neither drops the copy nor fails the ticket.
    session.checkFails = true
    const held = setup()
    held.fake.sessions.set(session.id, session)
    await held.executor.resume()
    await held.effects.idle('launch')
    expect(session.pending.filter(comment)).toEqual([original])
    expect(latestReport(ticketOf(ticketId))).toBeUndefined()
    await held.stop()
    session.checkFails = false
    const again = setup()
    again.fake.sessions.set(session.id, session)
    await again.executor.resume()
    await again.effects.idle('launch')
    await vi.waitFor(() => expect(ticketOf(ticketId).undelivered).toEqual([]))
    await again.effects.idle('delivery')
    const copies = [...session.pending.filter(comment), ...session.taken.filter(comment)]
    expect(copies.map((item) => item.commandId)).toEqual([`${original.commandId}:r1`])
    expect(session.journal.size).toBe(0)
    await again.stop()
  })

  it('names the ticket on the health once its relaunch waited three times to confirm a delivery, and clears it after', async () => {
    const first = setup()
    const ticketId = first.accept()
    await first.effects.idle('launch')
    await first.watched(ticketId)
    const session = first.worker(ticketId)!
    session.queueSteers = true
    session.running = true
    session.emit({ type: 'turn/start', data: { turn: 1 } })
    session.failNext = 'landed'
    first.engine.receive({ ...message('2'), text: 'also check the logout page' })
    await vi.waitFor(() => expect(ticketOf(ticketId).delivery).toBeDefined())
    await first.stop()
    session.running = false
    session.checkFails = true
    const held = setup()
    held.fake.sessions.set(session.id, session)
    await held.executor.resume()
    /** Runs the waiting launch once more now, rather than after its retry delay. */
    const relaunch = async () => {
      temp.store.db.prepare("UPDATE effect SET due = 0 WHERE kind = 'launch'").run()
      await held.effects.idle('launch')
    }
    await held.effects.idle('launch')
    await relaunch()
    expect(held.deliveries.get()).toMatchObject({ state: 'ready' })
    await relaunch()
    expect(held.deliveries.get()).toMatchObject({ state: 'error' })
    expect(held.deliveries.get()?.detail).toMatch(
      new RegExp(`^Ticket ${ticketId} waits to deliver \\S+, 3 times since`),
    )
    expect(held.deliveries.get()?.detail).toContain('UNCERTAIN')
    session.checkFails = false
    await relaunch()
    expect(held.deliveries.get()).toMatchObject({
      state: 'ready',
      detail: 'No delivery waits to be confirmed',
    })
    expect(temp.store.db.prepare("SELECT 1 FROM effect WHERE kind = 'launch'").get()).toBeUndefined()
    await held.stop()
  })

  it("opens a worker session its owner deleted again to deliver a person's message", async () => {
    const { accept, effects, engine, fake, worker, watched, stop } = setup()
    const ticketId = accept()
    await effects.idle('launch')
    await watched(ticketId)
    fake.remove(worker(ticketId)!.id)
    engine.receive({ ...message('2'), text: 'also check the logout page' })
    await vi.waitFor(() => expect(ticketOf(ticketId).undelivered).toEqual([]))
    expect(ticketOf(ticketId).delivery).toBeUndefined()
    const reopened = worker(ticketId)!
    expect(reopened.deleted).toBeUndefined()
    expect(reopened.pending.some((item) => item.preview.includes('also check the logout page'))).toBe(true)
    await stop()
  })

  it('after a restart, re-dispatches an assignment whose worker no longer runs and keeps one that still does', async () => {
    const first = setup()
    const ticketId = first.accept()
    await first.effects.idle('launch')
    await first.stop()
    const again = setup()
    again.fake.sessions.set(`superagent:worker:${ticketId}`, first.worker(ticketId)!)
    await again.executor.resume()
    await again.effects.idle('launch')
    const resumed = ticketOf(ticketId)
    expect(resumed.assignments.map((item) => [item.state, item.endedReason])).toEqual([
      ['ended', 'hostRestarted'],
      ['running', undefined],
    ])
    // A worker that still runs is left running and watched.
    first.worker(ticketId)!.running = true
    const third = setup()
    third.fake.sessions.set(`superagent:worker:${ticketId}`, first.worker(ticketId)!)
    await third.executor.resume()
    expect(ticketOf(ticketId).assignments).toHaveLength(2)
    await third.watched(ticketId)
    await again.stop()
    await third.stop()
  })
})
