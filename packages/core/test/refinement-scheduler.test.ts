import { presetDefaults } from '@agnes/core-common/step/preset'
import type { Event } from '@agnes/core-common/types'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { MAINTENANCE_LANE, REFINEMENT_RUN_EVENT } from '@agnes/core-ledger/reduce/state'
import type { InferenceEvent, Provider, RequestBody } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { RoleDelegation } from '../src/child/roles.js'
import { Kernel } from '../src/kernel.js'
import { refinementFacade } from '../src/refinement/facade.js'
import { queueRefinementRun, refinementRunRow } from '../src/refinement/run.js'
import {
  pump,
  type RefinementDeps,
  type RefinementSettingsView,
  tryApply,
} from '../src/refinement/scheduler.js'
import type { RefinementPlanner } from '../src/refinement/types.js'
import { experienceNotes } from '../src/request/experience.js'
import type { SessionImpl } from '../src/step/session.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, sentFor, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, openSession, testFsOps } from './helpers/open-session.js'
import { data, ofType, record } from './helpers/side-call-session.js'

const plannerModel = record({
  id: 'planner',
  route: 'rsi',
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
})
const target = { route: 'rsi', model: 'planner' }
const ENTRY = 'The file to read is b; a does not exist.'
const T0 = 1_757_203_200_000

const gate = () => {
  let open!: () => void
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}
const NOOP = JSON.stringify({
  summary: 'Nothing worth keeping.',
  rationale: '',
  expectedOutcome: '',
  edits: [],
  confirmations: [],
  evidenceIds: [],
})
/** A verbatim part of the request the lesson cites (`e1`), which grants it session level. */
const QUOTE = 'read file b, not a'
const REQUEST = `first task: ${QUOTE}`
const LESSON = JSON.stringify({
  summary: 'Read b.',
  rationale: 'The first read failed.',
  expectedOutcome: 'Fewer failed reads.',
  edits: [
    {
      op: 'upsert',
      kind: 'memory',
      id: 'read-b',
      title: 'Read b, not a',
      content: ENTRY,
      applicability: 'session',
      evidenceIds: ['e1'],
      quote: QUOTE,
    },
  ],
  confirmations: [],
  evidenceIds: ['e1'],
})

/** Renders the snapshot as JSON and reads the answer with JSON.parse; Core checks the rest. */
const planner: RefinementPlanner = {
  buildPrompt(snapshot, entries, guidance) {
    const text = JSON.stringify({ guidance, entries, evidence: snapshot.items })
    return {
      system: 'Plan one refinement.',
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      evidenceIds: snapshot.items.map((item) => item.id),
      fullEntries: entries.map(({ kind, id }) => ({ kind, id })),
      referenceEntries: [],
      omitted: { referenceEntries: 0, evidence: 0, fullEntries: 0 },
      inputTokens: 0,
    }
  },
  parseOutput(text) {
    try {
      return JSON.parse(text)
    } catch {
      return { error: 'invalid-json' }
    }
  },
}

type Plan = { text: string; gate?: Promise<void> }

/** The conversation answers from scripts (a turn may be held); the `rsi` route plans, one answer per call. */
function provider(o: { plans?: Plan[]; holds?: Map<number, Promise<void>> } = {}) {
  const base = fakeProvider([textTurn('answer')])
  const planned: RequestBody[] = []
  const plans = [...(o.plans ?? [])]
  const calls = { turns: 0 }
  const p: Provider = {
    ...base,
    models: () => [plannerModel],
    async *infer(request, options) {
      if (request.route !== 'rsi') {
        await o.holds?.get(calls.turns++)
        yield* base.infer(request, options)
        return
      }
      planned.push(request)
      const plan = plans.shift() ?? { text: NOOP }
      yield sentFor(request)
      await plan.gate
      yield { type: 'text_delta', delta: plan.text }
      yield {
        type: 'usage',
        tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
        credits: 0.001,
        creditSource: 'gateway',
      } as InferenceEvent
      yield { type: 'done', reason: 'stop' }
    },
  }
  return { provider: p, planned, requests: base.requests, calls }
}

type Switch = RefinementSettingsView

function deps(sw: Switch, over: Partial<RefinementDeps> = {}): RefinementDeps {
  return { settings: () => ({ ...sw }), planner: () => planner, target, ...over }
}

async function open(
  o: {
    sw?: Switch
    plans?: Plan[]
    holds?: Map<number, Promise<void>>
    storage?: MemoryStorage
    writerRunId?: string
    clock?: () => number
    refinement?: Partial<RefinementDeps>
  } = {},
) {
  const sw = o.sw ?? { enabled: true, mode: 'auto', revision: 'r1' }
  const p = provider(o)
  const warnings: string[] = []
  const opened = await openSession({
    provider: p.provider,
    ...(o.storage ? { storage: o.storage, key: 'k' } : {}),
    ...(o.writerRunId ? { writerRunId: o.writerRunId } : {}),
    ...(o.clock ? { clock: o.clock } : {}),
    refinement: deps(sw, o.refinement),
    refinementEnabled: () => sw.enabled,
    logger: { debug() {}, info() {}, warn: (message: string) => warnings.push(message), error() {} },
  })
  const s = opened.session
  const say = async (text: string) => {
    await s.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
    return s.run({ until: 'turn-end', signal: new AbortController().signal })
  }
  const rows = () => s.scan({ toSeq: s.lastSeq })
  const state = (runId: string) => s.state.refinementRuns.get(runId)?.state
  const lastUserSeq = async () => ofType(await rows(), 'user/message').at(-1)?.seq ?? 0
  return { ...opened, ...p, sw, say, rows, state, lastUserSeq, warnings, facade: refinementFacade(s) }
}

const runId = (outcome: unknown): string => {
  const id = (outcome as { runId?: string }).runId
  if (!id) throw new Error(`no run: ${JSON.stringify(outcome)}`)
  return id
}
const requestText = (request: RequestBody | undefined) => JSON.stringify(request ?? null)
const edit = { op: 'upsert' as const, kind: 'memory' as const, id: 'read-b', title: 'Read b', content: ENTRY }
const proposal = (evidence: number) => ({
  rationale: 'The first read failed; b is the file.',
  evidenceSeqs: [evidence],
  edits: [edit],
})

/**
 * An idle session with a proposed run and an empty inbox: the proposal is made while turn 2 is
 * open, and the switch is off while that turn ends so the turn-end apply leaves it alone.
 */
async function parked() {
  const held = gate()
  const t = await open({ holds: new Map([[1, held.wait]]) })
  expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
  await t.session.enqueue('next-turn', { content: [{ type: 'text', text: 'second task' }], actor })
  const second = t.session.run({ until: 'turn-end', signal: new AbortController().signal })
  await vi.waitFor(() => expect(t.calls.turns).toBe(2))
  const id = runId(await t.facade.propose(proposal(await t.lastUserSeq())))
  expect(t.state(id)).toBe('proposed')
  t.sw.enabled = false
  held.open()
  expect(await second).toMatchObject({ reason: 'completed' })
  t.sw.enabled = true
  expect(t.state(id)).toBe('proposed')
  expect(ofType(await t.rows(), 'harness/entry')).toHaveLength(0)
  return { ...t, id }
}

describe('applying between turns', () => {
  it("a message queued before apply wins and apply waits for that turn's end", async () => {
    const t = await parked()
    const lock = gate()
    const held = t.session.locked(() => lock.wait)
    // Both wait on the session lock in this order: the message's inbox row commits first.
    const queued = t.session.enqueue('next-turn', { content: [{ type: 'text', text: 'third' }], actor })
    const applying = t.facade.afterTurn()
    lock.open()
    await held
    const inboxSeq = await queued
    await applying
    expect(t.state(t.id)).toBe('proposed')
    expect(await t.session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
      reason: 'completed',
    })
    // The turn that took the message did not see the lesson; it was applied when that turn ended.
    expect(requestText(t.requests.at(-1))).not.toContain(ENTRY)
    expect(t.state(t.id)).toBe('applied')
    const all = await t.rows()
    const refine = ofType(all, 'harness/refine')
    expect(refine).toHaveLength(1)
    expect(refine[0]?.seq).toBeGreaterThan(inboxSeq)
    expect(refine[0]?.seq).toBeGreaterThan(ofType(all, 'turn/end').at(-1)?.seq ?? Infinity)
    expect(await t.say('fourth')).toMatchObject({ reason: 'completed' })
    expect(requestText(t.requests.at(-1))).toContain(ENTRY)
    await t.session.close()
  })

  it('apply committed first is read by the next turn', async () => {
    const t = await parked()
    const lock = gate()
    const held = t.session.locked(() => lock.wait)
    // The other order: the apply is first in line, the message second.
    const applying = t.facade.afterTurn()
    const queued = t.session.enqueue('next-turn', { content: [{ type: 'text', text: 'third' }], actor })
    lock.open()
    await held
    await applying
    const inboxSeq = await queued
    expect(t.state(t.id)).toBe('applied')
    const refine = ofType(await t.rows(), 'harness/refine')
    expect(refine[0]?.seq).toBeLessThan(inboxSeq)
    expect(await t.session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
      reason: 'completed',
    })
    expect(requestText(t.requests.at(-1))).toContain(ENTRY)
    await t.session.close()
  })

  it('the apply row, its entries and the run state commit in one transaction', async () => {
    const t = await parked()
    await t.facade.afterTurn()
    const all = await t.rows()
    const refine = ofType(all, 'harness/refine')[0] as Event
    const entry = ofType(all, 'harness/entry')[0] as Event
    const applied = ofType(all, REFINEMENT_RUN_EVENT).find((row) => data(row).state === 'applied') as Event
    expect(data(refine)).toMatchObject({ runId: t.id, outcome: 'applied' })
    expect([entry.seq, applied.seq]).toEqual([refine.seq + 1, refine.seq + 2])
    expect(applied.lane).toBe(MAINTENANCE_LANE)
    // A second attempt is a no-op: the run has ended.
    expect(await tryApply(t.session, t.id)).toBe('not-proposed')
    expect(ofType(await t.rows(), 'harness/refine')).toHaveLength(1)
    await t.session.close()
  })

  it('paused sessions keep the result proposed', async () => {
    const held = gate()
    const t = await open({ holds: new Map([[1, held.wait]]) })
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    await t.session.enqueue('next-turn', { content: [{ type: 'text', text: 'second task' }], actor })
    const second = t.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await vi.waitFor(() => expect(t.calls.turns).toBe(2))
    await t.session.controls.apply('pause', actor, 'pause-1')
    const id = runId(await t.facade.propose(proposal(await t.lastUserSeq())))
    held.open()
    expect(await second).toMatchObject({ reason: 'parked' })
    await t.facade.afterTurn()
    expect(t.state(id)).toBe('proposed')
    expect(ofType(await t.rows(), 'harness/entry')).toHaveLength(0)
    // Resumed, the parked turn finishes and the lesson is applied at its end, never before.
    await t.session.controls.apply('resume', actor, 'resume-1')
    await t.session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(t.state(id)).toBe('applied')
    await t.session.close()
  })

  it('a durable pause with no open turn keeps the result proposed too', async () => {
    const t = await parked()
    await t.session.append([
      t.session.ev('x/core/pause-state', { paused: true }, { actor, origin: 'principal', ignorable: true }),
    ])
    expect(await tryApply(t.session, t.id)).toBe('paused')
    expect(t.state(t.id)).toBe('proposed')
    await t.session.append([
      t.session.ev('x/core/pause-state', { paused: false }, { actor, origin: 'principal', ignorable: true }),
    ])
    expect(await tryApply(t.session, t.id)).toBe('applied')
    await t.session.close()
  })
})

describe('task-level lessons', () => {
  it('no goal => a task-level edit is not applied or delivered; the session-level one is', async () => {
    const TASK_ENTRY = 'Only for this task: skip the slow suite.'
    const plan = JSON.parse(LESSON)
    plan.edits.push({
      op: 'upsert',
      kind: 'memory',
      id: 'skip-slow',
      title: 'Skip the slow suite',
      content: TASK_ENTRY,
      applicability: 'task',
      evidenceIds: ['e1'],
    })
    const t = await open({ plans: [{ text: JSON.stringify(plan) }] })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const id = runId(await t.facade.request({ kind: 'manual', seq: t.session.lastSeq }))
    await vi.waitFor(() => expect(t.state(id)).toBe('applied'))
    const run = t.session.state.refinementRuns.get(id)
    expect(run?.plan?.edits.map((edit) => [edit.id, edit.op === 'upsert' && edit.expired === true])).toEqual([
      ['read-b', false],
      ['skip-slow', true],
    ])
    const all = await t.rows()
    expect(ofType(all, 'harness/entry').map((row) => data(row).id)).toEqual(['read-b'])
    expect((data(ofType(all, 'harness/refine')[0] as Event).edits as unknown[]).length).toBe(1)
    expect(await t.say('second task')).toMatchObject({ reason: 'completed' })
    expect(requestText(t.requests.at(-1))).toContain(ENTRY)
    expect(requestText(t.requests.at(-1))).not.toContain(TASK_ENTRY)
    await t.session.close()
  })
})

describe('scheduling plans', () => {
  it('a newer trigger supersedes the queued one', async () => {
    const first = gate()
    const t = await open({ plans: [{ text: NOOP, gate: first.wait }, { text: NOOP }] })
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    const seq = t.session.lastSeq
    const a = runId(await t.facade.request({ kind: 'manual', seq }))
    await vi.waitFor(() => expect(t.planned).toHaveLength(1))
    const b = runId(await t.facade.request({ kind: 'manual', seq, focus: 'older' }))
    const c = runId(await t.facade.request({ kind: 'manual', seq, focus: 'newest' }))
    expect([t.state(a), t.state(b), t.state(c)]).toEqual(['planning', 'superseded', 'queued'])
    first.open()
    // When the plan in flight ends, the newest trigger is planned next; the superseded one never is.
    await vi.waitFor(() => expect(t.state(c)).toBe('no-op'))
    expect([t.state(a), t.state(b)]).toEqual(['no-op', 'superseded'])
    expect(t.planned).toHaveLength(2)
    expect(requestText(t.planned[1])).toContain('newest')
    await t.session.close()
  })

  it("the cooldown survives a restart, and nothing else spaces the machine's triggers", async () => {
    const storage = new MemoryStorage()
    let now = T0
    const clock = () => now
    let t = await open({ storage, clock })
    const automatic = async () =>
      t.facade.request({ kind: 'repeated-failure', seq: await t.lastUserSeq(), focus: 'read' })
    const reopen = async (writerRunId: string) => {
      await t.session.close()
      t = await open({ storage, clock, writerRunId })
      await t.session.resume()
    }
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    const first = runId(await automatic())
    await vi.waitFor(() => expect(t.state(first)).toBe('no-op'))
    expect(await automatic()).toEqual({ refused: 'cooldown' })
    await reopen('r2')
    expect(await automatic()).toEqual({ refused: 'cooldown' })
    // Past the cooldown the next one starts at once: no turns have to pass, and there is no hourly cap.
    for (let plan = 2; plan <= 6; plan++) {
      now += 121_000
      const id = runId(await automatic())
      await vi.waitFor(() => expect(t.state(id)).toBe('no-op'))
    }
    // Manual requests are counted apart: they ignore the automatic limits.
    expect(runId(await t.facade.request({ kind: 'manual', seq: t.session.lastSeq }))).toBeTruthy()
    await t.session.close()
  })

  it('the model asking for a review has no cooldown, in either mode', async () => {
    const t = await open({ sw: { enabled: true, mode: 'manual', revision: 'r1' } })
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    // Six requests back to back, with no turn between them: each is accepted and planned.
    for (let i = 0; i < 6; i++) {
      const id = runId(
        await t.facade.request({ kind: 'model', seq: await t.lastUserSeq(), focus: `ask ${i}` }),
      )
      await vi.waitFor(() => expect(t.state(id)).toBe('no-op'))
    }
    // The machine's trigger is still held to the mode and its limits.
    expect(await t.facade.request({ kind: 'repeated-failure', seq: await t.lastUserSeq() })).toEqual({
      refused: 'manual-mode',
    })
    t.sw.mode = 'auto'
    expect(await t.facade.request({ kind: 'repeated-failure', seq: await t.lastUserSeq() })).toEqual({
      refused: 'cooldown',
    })
    expect(runId(await t.facade.request({ kind: 'model', seq: await t.lastUserSeq() }))).toBeTruthy()
    await t.session.close()
  })

  it('a proposed run recovered on reopen is applied at once while the session is idle', async () => {
    const storage = new MemoryStorage()
    const held = gate()
    let t = await open({ storage, holds: new Map([[1, held.wait]]) })
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    await t.session.enqueue('next-turn', { content: [{ type: 'text', text: 'second task' }], actor })
    const second = t.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await vi.waitFor(() => expect(t.calls.turns).toBe(2))
    const id = runId(await t.facade.propose(proposal(await t.lastUserSeq())))
    // Off while the turn ends, so the proposal is still waiting when the process goes away.
    t.sw.enabled = false
    held.open()
    expect(await second).toMatchObject({ reason: 'completed' })
    expect(t.state(id)).toBe('proposed')
    await t.session.close()
    t = await open({ storage, writerRunId: 'r2' })
    await t.session.resume()
    // Nothing is open and nothing waits: the first turn after the reopen reads the lesson.
    expect(t.state(id)).toBe('applied')
    expect(await t.say('third task')).toMatchObject({ reason: 'completed' })
    expect(requestText(t.requests.at(-1))).toContain(ENTRY)
    await t.session.close()
  })

  it('turning refinement off mid-plan drops the late result', async () => {
    const answer = gate()
    const t = await open({ plans: [{ text: LESSON, gate: answer.wait }] })
    expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
    const id = runId(await t.facade.request({ kind: 'manual', seq: t.session.lastSeq }))
    await vi.waitFor(() => expect(t.planned).toHaveLength(1))
    t.sw.enabled = false
    answer.open()
    await vi.waitFor(() => expect(t.state(id)).toBe('cancelled'))
    const before = (await t.rows()).length
    await t.facade.afterTurn()
    expect(await t.say('second task')).toMatchObject({ reason: 'completed' })
    const after = await t.rows()
    // Off, the turn wrote its own rows and nothing for refinement.
    expect(ofType(after.slice(before), REFINEMENT_RUN_EVENT)).toHaveLength(0)
    expect(ofType(after, 'harness/refine')).toHaveLength(0)
    expect(ofType(after, 'harness/entry')).toHaveLength(0)
    await t.session.close()
  })

  it('a proposed result is never applied while off, and a changed revision cancels it', async () => {
    const t = await parked()
    t.sw.enabled = false
    const before = (await t.rows()).length
    // The switch check itself says no, not a failure further down.
    expect(await tryApply(t.session, t.id)).toBe('off')
    await t.facade.afterTurn()
    expect(await t.say('third')).toMatchObject({ reason: 'completed' })
    expect(ofType((await t.rows()).slice(before), REFINEMENT_RUN_EVENT)).toHaveLength(0)
    expect(t.state(t.id)).toBe('proposed')
    expect(t.warnings).toEqual([])
    Object.assign(t.sw, { enabled: true, revision: 'r2' })
    await t.facade.afterTurn()
    expect(t.session.state.refinementRuns.get(t.id)).toMatchObject({
      state: 'cancelled',
      reason: 'settings-changed',
    })
    expect(ofType(await t.rows(), 'harness/entry')).toHaveLength(0)
    expect(t.warnings).toEqual([])
    await t.session.close()
  })

  it('a queued run is never planned under another settings revision', async () => {
    const first = gate()
    const t = await open({ plans: [{ text: NOOP, gate: first.wait }] })
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    const a = runId(await t.facade.request({ kind: 'manual', seq: t.session.lastSeq }))
    await vi.waitFor(() => expect(t.planned).toHaveLength(1))
    const b = runId(await t.facade.request({ kind: 'manual', seq: t.session.lastSeq }))
    expect(t.session.state.refinementRuns.get(b)).toMatchObject({ state: 'queued', settingsRevision: 'r1' })
    // Saved off and on again: a new revision.
    t.sw.revision = 'r2'
    first.open()
    await vi.waitFor(() => expect(t.state(b)).toBe('cancelled'))
    expect(t.session.state.refinementRuns.get(a)).toMatchObject({
      state: 'rejected',
      reason: 'settings-changed',
    })
    expect(t.session.state.refinementRuns.get(b)).toMatchObject({ reason: 'settings-changed' })
    expect(t.planned).toHaveLength(1)
    await t.session.close()
  })

  it('while a plan runs, an automatic trigger is queued only if just the cooldown stands in its way', async () => {
    const first = gate()
    const t = await open({ plans: [{ text: NOOP, gate: first.wait }, { text: NOOP }, { text: NOOP }] })
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    const seq = await t.lastUserSeq()
    // An automatic plan is in flight: another automatic trigger waits behind it (only its cooldown is in
    // the way), and it never displaces the user's queued request.
    const a = runId(await t.facade.request({ kind: 'compaction', seq }))
    await vi.waitFor(() => expect(t.planned).toHaveLength(1))
    const m = runId(await t.facade.request({ kind: 'manual', seq, focus: 'mine' }))
    const r = runId(await t.facade.request({ kind: 'repeated-failure', seq, focus: 'read' }))
    expect([t.state(m), t.state(r)]).toEqual(['queued', 'queued'])
    first.open()
    await vi.waitFor(() => expect(t.state(m)).toBe('no-op'))
    expect(t.state(a)).toBe('no-op')
    expect(requestText(t.planned[1])).toContain('mine')
    await t.session.close()
  })

  it('an automatic trigger never supersedes a queued manual request', async () => {
    const first = gate()
    const t = await open({ plans: [{ text: NOOP, gate: first.wait }, { text: NOOP }] })
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    const seq = await t.lastUserSeq()
    // A manual plan is in flight, and no automatic plan ever ran: an automatic trigger may wait.
    runId(await t.facade.request({ kind: 'manual', seq }))
    await vi.waitFor(() => expect(t.planned).toHaveLength(1))
    const m = runId(await t.facade.request({ kind: 'manual', seq, focus: 'mine' }))
    const c = runId(await t.facade.request({ kind: 'compaction', seq }))
    expect([t.state(m), t.state(c)]).toEqual(['queued', 'queued'])
    first.open()
    // The user's request is planned next; the automatic one gives way to it.
    await vi.waitFor(() => expect(t.state(m)).toBe('no-op'))
    expect(t.state(c)).toBe('superseded')
    expect(requestText(t.planned[1])).toContain('mine')
    expect(t.planned).toHaveLength(2)
    await t.session.close()
  })

  it('an automatic run that starts never supersedes a manual request queued just before it', async () => {
    const t = await open()
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    const seq = t.session.lastSeq
    const automatic = await queueRefinementRun(t.session, { kind: 'repeated-failure', seq }, 'r1')
    const lock = gate()
    const held = t.session.locked(() => lock.wait)
    // In line for the lock first: the manual request's queue row.
    const manual = queueRefinementRun(t.session, { kind: 'manual', seq }, 'r1')
    // The pump reads the queue now, sees only the automatic run, and starts it; its supersede waits
    // for the lock behind the manual row.
    pump(t.session)
    lock.open()
    await held
    const manualId = await manual
    // Both are planned, the automatic one first: neither displaced the other.
    await vi.waitFor(() => expect(t.state(manualId)).toBe('no-op'))
    expect(t.state(automatic)).toBe('no-op')
    expect(t.planned).toHaveLength(2)
    await t.session.close()
  })

  it('switching to manual stops an automatic run that is already queued', async () => {
    const first = gate()
    const t = await open({ plans: [{ text: NOOP, gate: first.wait }] })
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    const seq = await t.lastUserSeq()
    runId(await t.facade.request({ kind: 'manual', seq }))
    await vi.waitFor(() => expect(t.planned).toHaveLength(1))
    const c = runId(await t.facade.request({ kind: 'compaction', seq }))
    t.sw.mode = 'manual'
    first.open()
    await vi.waitFor(() => expect(t.state(c)).toBe('rejected'))
    expect(t.session.state.refinementRuns.get(c)).toMatchObject({ reason: 'manual-mode' })
    expect(t.planned).toHaveLength(1)
    await t.session.close()
  })

  it('off, nothing is queued, proposed or written, and opening the session writes nothing', async () => {
    const storage = new MemoryStorage()
    const sw: Switch = { enabled: false, mode: 'auto', revision: 'r1' }
    const t = await open({ sw, storage })
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    expect(await t.facade.request({ kind: 'manual', seq: t.session.lastSeq })).toEqual({
      refused: 'refinement-off',
    })
    expect(await t.facade.propose(proposal(await t.lastUserSeq()))).toEqual({ refused: 'refinement-off' })
    await t.session.close()
    const again = await open({ sw, storage, writerRunId: 'r2' })
    await again.session.resume()
    expect((await again.rows()).filter((row) => row.lane === MAINTENANCE_LANE)).toHaveLength(0)
    await again.session.close()
  })

  it('automatic triggers follow the mode and need a known price; manual ones need the user to accept an unknown one', async () => {
    const t = await open({ sw: { enabled: true, mode: 'manual', revision: 'r1' } })
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    const seq = await t.lastUserSeq()
    expect(await t.facade.request({ kind: 'compaction', seq })).toEqual({ refused: 'manual-mode' })
    // The model asking for a review works in manual mode too; saving beyond the session needs automatic.
    expect(await t.facade.request({ kind: 'model', seq, saveTo: 'workspace' })).toEqual({
      refused: 'manual-mode',
    })
    t.sw.mode = 'auto'
    // No planner target given: the session's primary model has no price, so nothing bounds the spend.
    const { target: _target, ...untargeted } = deps(t.sw)
    t.session.d.refinement = untargeted
    expect(await t.facade.request({ kind: 'compaction', seq })).toEqual({ refused: 'unpriced' })
    // The user's own request runs on an unknown price only once the user agreed to it.
    expect(await t.facade.request({ kind: 'manual', seq })).toEqual({ refused: 'unpriced' })
    const agreed = await t.facade.request({ kind: 'manual', seq, allowUnpriced: true })
    expect(runId(agreed)).toBeTruthy()
    expect(t.session.state.refinementRuns.get(runId(agreed) as string)?.trigger).toMatchObject({
      kind: 'manual',
      allowUnpriced: true,
    })
    await t.session.close()
  })

  it('a planner model priced at zero is a known price: automatic triggers plan with it', async () => {
    const t = await open({ plans: [{ text: NOOP }] })
    vi.spyOn(t.session.d.provider, 'models').mockReturnValue([
      { ...plannerModel, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ])
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    const seq = await t.lastUserSeq()
    const accepted = await t.facade.request({ kind: 'compaction', seq })
    expect(runId(accepted)).toBeTruthy()
    await vi.waitFor(() => expect(t.session.state.refinementRuns.get(runId(accepted))?.state).toBe('no-op'))
    await t.session.close()
  })

  it.each(['manual', 'compaction'] as const)(
    'a %s run left queued by a restart is planned again under a new attempt id',
    async (kind) => {
      const storage = new MemoryStorage()
      const a = await open({ storage })
      expect(await a.say('first task')).toMatchObject({ reason: 'completed' })
      // A crash after the planning row and before the call: no intent, so the run goes back to
      // queued. Its own earlier start must not count against it as a cooldown or a recent plan.
      const id = `run-interrupted-${kind}`
      const trigger = { kind, seq: await a.lastUserSeq() }
      await a.session.append([refinementRunRow(a.session, id, 'queued', { trigger, settingsRevision: 'r1' })])
      await a.session.append([
        refinementRunRow(a.session, id, 'planning', { attempt: 1, settingsRevision: 'r1' }),
      ])
      await a.log.close()
      const b = await open({ storage, writerRunId: 'r2' })
      await b.session.resume()
      await vi.waitFor(() => expect(b.state(id)).toBe('no-op'))
      const intents = ofType(await b.rows(), 'effect/intent').filter((row) => row.lane === MAINTENANCE_LANE)
      expect(intents.map((row) => data(row).effectId)).toEqual([`maintenance:${id}.2`])
      expect(b.planned).toHaveLength(1)
      await b.session.close()
    },
  )
})

describe('direct proposals', () => {
  it('create new entries; changing or deleting a saved one needs a read first', async () => {
    const t = await parked()
    await t.facade.afterTurn()
    expect(t.state(t.id)).toBe('applied')
    const seq = await t.lastUserSeq()
    expect(await t.facade.propose(proposal(seq))).toEqual({ refused: 'read-first', detail: 'memory/read-b' })
    expect(
      await t.facade.propose({ ...proposal(seq), edits: [{ op: 'delete', kind: 'memory', id: 'read-b' }] }),
    ).toEqual({ refused: 'read-first', detail: 'memory/read-b' })
    expect(
      await t.facade.propose({ ...proposal(seq), edits: [{ op: 'delete', kind: 'memory', id: 'other' }] }),
    ).toEqual({ refused: 'not-found', detail: 'memory/other' })
    const tooMany = Array.from({ length: 6 }, (_, i) => ({ ...edit, id: `e${i}` }))
    expect(await t.facade.propose({ ...proposal(seq), edits: tooMany })).toMatchObject({ refused: 'invalid' })
    const long = [{ ...edit, id: 'long', content: 'x'.repeat(2001) }]
    expect(await t.facade.propose({ ...proposal(seq), edits: long })).toMatchObject({ refused: 'invalid' })
    expect(await t.facade.propose({ ...proposal(t.session.lastSeq + 5) })).toMatchObject({
      refused: 'invalid',
    })
    // Idle, a valid new entry is applied at once.
    const fresh = [{ ...edit, id: 'fresh' }]
    const id = runId(await t.facade.propose({ ...proposal(seq), edits: fresh }))
    expect(t.state(id)).toBe('applied')
    await t.session.close()
  })
})

describe('direct proposal text', () => {
  it('a credential in a direct proposal is masked before it is stored or delivered', async () => {
    const LEAKED = 'sk-proj4Ab9Zq81LmNopQrStUvWx'
    const t = await parked()
    await t.facade.afterTurn()
    const seq = await t.lastUserSeq()
    const leaky = {
      rationale: `It needs api_key: ${LEAKED}`,
      evidenceSeqs: [seq],
      edits: [{ ...edit, id: 'leaky', title: `Use ${LEAKED}`, content: `Export TOKEN=${LEAKED} first.` }],
    }
    const id = runId(await t.facade.propose(leaky))
    expect(t.state(id)).toBe('applied')
    const kept = (await t.rows()).filter((row) =>
      ['harness/entry', 'harness/refine', REFINEMENT_RUN_EVENT].includes(row.type),
    )
    expect(kept.length).toBeGreaterThan(0)
    expect(JSON.stringify(kept.map((row) => row.data))).not.toContain(LEAKED)
    expect(await t.say('next task')).toMatchObject({ reason: 'completed' })
    const sent = requestText(t.requests.at(-1))
    expect(sent).toContain('Export TOKEN=')
    expect(sent).not.toContain(LEAKED)
    await t.session.close()
  })
})

describe('child sessions', () => {
  it('child sessions never start automatic planning', async () => {
    const role = { ref: '@fixture/roles#reader', title: { en: 'Reader' } }
    const roleDelegation: RoleDelegation = {
      role,
      parentKey: 'parent',
      actor,
      tools: [],
      generationLimit: 3,
      maxFanOut: 2,
      permission: 'read-only',
      approvalPolicy: 'never',
      parentPolicy: 'default',
      parentTainted: false,
      sandboxRequired: true,
      filesystem: fakeSeams().sandbox.fsPolicy(),
    }
    const options = { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }
    const sw: Switch = { enabled: true, mode: 'auto', revision: 'r1' }
    let k!: Kernel
    k = Kernel.create({
      loops: defaultLoops(),
      storage: new MemoryStorage(),
      seams: fakeSeams(),
      provider: provider().provider,
      contract: { contract_id: null, parser_version: '1' },
      preset: { ...presetDefaults(), generationLimit: 3, maxFanOut: 4, treeBudgetCredits: 100 },
      fsOps: testFsOps(),
      netFetch: async () => new Response(''),
      timers: noTimers,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      refinement: deps(sw),
      refinementEnabled: () => sw.enabled,
      childRoles: {
        list: async () => [role],
        resolve: async () => ({
          role,
          open: (key, opts) => k.session(key, { ...options, ...opts, roleDelegation }),
        }),
      },
    })
    try {
      const parent = await k.session('parent', options)
      const spawned = await parent.d.children.create({ parent: 'parent', cwd: '/w', input: 'spawned' })
      const roled = await parent.d.children.createWithKind?.('spawn', {
        parent: 'parent',
        cwd: '/w',
        role: role.ref,
        input: 'role',
        resident: true,
      })
      for (const child of [k.get(spawned.key) as SessionImpl, k.get(roled?.key ?? '') as SessionImpl]) {
        const facade = refinementFacade(child)
        for (const kind of ['compaction', 'repeated-failure', 'model', 'manual'] as const)
          expect(await facade.request({ kind, seq: child.lastSeq })).toEqual({ refused: 'child-session' })
        expect(await facade.propose(proposal(1))).toEqual({ refused: 'child-session' })
        const rows = await child.scan({ toSeq: child.lastSeq })
        expect(rows.filter((row) => row.lane === MAINTENANCE_LANE)).toHaveLength(0)
        // A child inherits nothing of the refinement experience either.
        expect(await experienceNotes(child, child.surface())).toEqual([])
      }
      expect(await experienceNotes(parent, parent.surface())).not.toEqual([])
    } finally {
      await k.close()
    }
  })
})
