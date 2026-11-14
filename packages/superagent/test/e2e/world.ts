/**
 * The plugin end to end below the daemon, for the fault tests: Superagent's real store (SQLite in a temporary
 * directory), engine, effect queue, executor, sessions and delivery, over the in-memory SDK client of `fake-sdk.ts`,
 * with the prepare command run as a real shell. A test makes a fault on the fake session or client and reads the
 * states Superagent records.
 */
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { Effects } from '../../src/app/effects.js'
import type { Store } from '../../src/app/store.js'
import { type Candidate, Engine, type Policy, type Trigger } from '../../src/core/index.js'
import { HealthBoard } from '../../src/infra/health.js'
import { SettingsSchema } from '../../src/policy.js'
import { SessionDelivery } from '../../src/runtime/delivery.js'
import { SuperagentExecutor } from '../../src/runtime/executor.js'
import { SessionRegistry, Sessions } from '../../src/runtime/sessions.js'
import { fakeClient } from '../runtime/fake-sdk.js'

/** A person's message on the ticket's thread. */
export const message = (id: string, text = `please fix ${id}`): Trigger => ({
  id,
  source: 'chat',
  threads: [{ source: 'chat', id: 'th' }],
  actor: { source: 'chat', id: 'alice' },
  human: true,
  at: new Date().toISOString(),
  text,
  channel: { source: 'chat', thread: 'th', address: { message: id } },
  meta: {},
})

/**
 * One run of Superagent on `store` (a restart is a second `world` on the same store and client). The prepare command is
 * `prepare`, run in the ticket directory under `dir`.
 */
export function world(
  store: Store,
  dir: string,
  opts: { prepare?: string; fake?: ReturnType<typeof fakeClient> } = {},
) {
  store.saveSettings(
    SettingsSchema.parse({ executor: { prepare: opts.prepare ?? '', directory: join(dir, 'work') } }),
  )
  const fake = opts.fake ?? fakeClient()
  const lifetime = new AbortController()
  const sessions = new Sessions({
    client: fake.client,
    registry: new SessionRegistry(store),
    orchestratorDir: () => dir,
    prepareCommand: () => store.settings().executor.prepare,
    environment: () => ({}),
    lifetime: lifetime.signal,
  })
  const delivery = new SessionDelivery({ sessions, store })
  const board = new HealthBoard()
  const effects = new Effects(store, board)
  /** What reached the main session: the reports and failures it hands to a person. */
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
  const executor = new SuperagentExecutor({
    get engine() {
      return engine
    },
    store,
    effects,
    health: board.claim('worker'),
    models: board.claim('models'),
    deliveries: board.claim('deliveries'),
    stateDir: dir,
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
    repo: store,
    scope: { scope: () => ({ listened: true, observed: false }) },
    policy: () => policy,
    assessor: { request: (candidate) => requests.push(candidate) },
    executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
    prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome),
  })
  /** A person asks; the main session accepts it as a ticket. */
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
  return {
    fake,
    engine,
    executor,
    delivery,
    effects,
    health: board.all,
    relays,
    accept,
    worker,
    /** Waits until the executor reads the worker session's events. */
    watched: (ticketId: string) => vi.waitFor(() => expect(worker(ticketId)?.listening()).toBe(1)),
    /** Runs the waiting effects of `kind` again now, rather than after their retry delay. */
    async rerun(kind: 'launch' | 'delivery') {
      store.db.prepare('UPDATE effect SET due = 0 WHERE kind = ?').run(kind)
      await effects.idle(kind)
    },
    /** Stops this run as a restart or a disable does: sessions, turns and records stay. */
    async stop() {
      closing = true
      lifetime.abort()
      await executor.shutdown()
      await effects.drain()
    },
  }
}
