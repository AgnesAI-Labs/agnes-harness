import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Candidate, Engine, type Policy, runningAssignment, type Trigger } from '../../src/core/index.js'
import { createHookState, DEFAULT_WAIT, NO_WAIT } from '../../src/runtime/hooks.js'
import { SessionRegistry } from '../../src/runtime/sessions.js'
import { tempStore } from './helpers.js'
import { hookHarness } from './hook-harness.js'

let temp: ReturnType<typeof tempStore>
beforeEach(() => {
  temp = tempStore()
})
afterEach(() => temp.close())

const ENDED = { allow: false, reason: 'Ticket ended; new work needs a new authorized ticket' }
const message = (id: string, actor: string): Trigger => ({
  id,
  source: 'chat',
  threads: [{ source: 'chat', id: 'th' }],
  actor: { source: 'chat', id: actor },
  human: true,
  at: `2026-11-14T00:00:${id.padStart(2, '0')}Z`,
  text: `message ${id}`,
  channel: { source: 'chat', thread: 'th', address: { message: id } },
  meta: {},
})

function setup() {
  let version = 'v1'
  const requests: Candidate[] = []
  const policy: Policy = {
    get version() {
      return version
    },
    paused: false,
    evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    // The mandate holds only while the policy that granted it does.
    revalidate: () => version === 'v1',
    admitsInferred: () => false,
  }
  const engine = new Engine({
    repo: temp.store,
    scope: { scope: () => ({ listened: true, observed: false }) },
    policy: () => policy,
    assessor: { request: (candidate) => requests.push(candidate) },
    executor: { start: () => {}, deliver: () => {}, stop: () => {} },
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
  })
  engine.receive(message('1', 'alice'))
  engine.evaluateDue()
  const candidate = requests.at(-1)!
  const decision = engine.decide(candidate.triggers[0]!.id, {
    kind: 'accept',
    title: 'Fix',
    scope: 'small',
    reason: 'requested',
    acknowledgement: 'ok',
    evalId: candidate.evalId,
  })
  const ticketId = decision.ticketId!
  const start = () => {
    const assignment =
      runningAssignment(temp.store.tickets.get(ticketId)!) ??
      temp.store.tickets.get(ticketId)!.assignments.at(-1)!
    engine.assignmentStarted(ticketId, assignment.id)
  }
  start()
  const registry = new SessionRegistry(temp.store)
  registry.record({ kind: 'orchestrator' }, 'superagent:orchestrator')
  registry.record({ kind: 'worker', ticketId }, `superagent:worker:${ticketId}`)
  const hooks = hookHarness()
  let unavailable: string | undefined
  hooks.cell.set(
    createHookState({
      registry,
      store: temp.store,
      unavailable: () => unavailable,
      prompt: { request: () => 'section' },
      liveNote: () => undefined,
    }),
  )
  return {
    engine,
    hooks,
    worker: `superagent:worker:${ticketId}`,
    ticketId,
    start,
    revoke: () => {
      version = 'v2'
    },
    setUnavailable: (reason?: string) => {
      unavailable = reason
    },
  }
}

describe('the ticket guard', () => {
  it('refuses every tool of an ended ticket, and allows them again once a revalidated message resumes it', () => {
    const { engine, hooks, worker, ticketId, start } = setup()
    expect(hooks.toolCall(worker, 'shell', { command: 'git push' })).toEqual({ allow: true })
    engine.report(ticketId, { state: 'ready', summary: 'done' })
    for (const tool of ['shell', 'write', 'orchestrator_report', 'job_output'])
      expect(hooks.toolCall(worker, tool), tool).toEqual(ENDED)
    // Its subagents stop with it.
    expect(hooks.toolCall(`${worker}/01HXCHILD`, 'shell')).toEqual(ENDED)
    engine.receive(message('2', 'bob'))
    engine.evaluateDue()
    start()
    expect(hooks.toolCall(worker, 'shell', { command: 'git status' })).toEqual({ allow: true })
    expect(hooks.toolCall(`${worker}/01HXCHILD`, 'read')).toEqual({ allow: true })
  })

  it('keeps refusing when the mandate fails its review under the changed policy', () => {
    const { engine, hooks, worker, ticketId, revoke } = setup()
    engine.report(ticketId, { state: 'ready', summary: 'done' })
    revoke()
    engine.receive(message('2', 'bob'))
    engine.evaluateDue()
    expect(hooks.toolCall(worker, 'shell')).toEqual(ENDED)
  })

  it("refuses Superagent's sessions with the reason while the service is not ready", () => {
    const { hooks, worker, setUnavailable } = setup()
    setUnavailable('Superagent is stopping')
    expect(hooks.toolCall(worker, 'read')).toEqual({ allow: false, reason: 'Superagent is stopping' })
    expect(hooks.toolCall('superagent:orchestrator', 'read')).toEqual({
      allow: false,
      reason: 'Superagent is stopping',
    })
  })

  it('refuses the main session the calls that would wait, as noWait does', () => {
    const { hooks } = setup()
    const main = (name: string, args: unknown) => hooks.toolCall('superagent:orchestrator', name, args)
    expect(main('shell', { command: 'sleep 30' })).toEqual({ allow: false, reason: NO_WAIT })
    expect(main('shell', { command: 'cd repo && sleep 5; gh pr view' })).toEqual({
      allow: false,
      reason: NO_WAIT,
    })
    expect(main('shell', { command: 'gh pr view 1', timeoutMs: 60_000 })).toEqual({
      allow: false,
      reason: NO_WAIT,
    })
    expect(main('job_output', { jobId: 'j1', waitMs: 30_000 })).toEqual({ allow: false, reason: NO_WAIT })
    expect(main('shell', { command: 'gh pr view 1' })).toEqual({ allow: true })
    expect(main('shell', { command: 'gh pr checks 1 --watch', background: true })).toEqual({ allow: true })
    expect(main('shell', { command: 'ls', timeoutMs: 20_000 })).toEqual({ allow: true })
    expect(main('job_output', { jobId: 'j1', waitMs: 5000 })).toEqual({ allow: true })
    expect(main('job_output', { jobId: 'j1' })).toEqual({ allow: true })
    expect(main('read', { path: 'sleep.md' })).toEqual({ allow: true })
    expect(DEFAULT_WAIT).toMatch(/background/)
  })
})
