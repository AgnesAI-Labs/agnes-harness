import type * as W from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { type ActionFact, judgeComplete, planDrain } from '../../src/runtime/supervisor/completion.js'
import {
  actionTimebox,
  admissionIds,
  lifetimeDeadline,
  maxDeadline,
  sessionIdOf,
  workspaceIdOf,
} from '../../src/runtime/supervisor/keys.js'
import { type RecoveryInput, recoveryStep } from '../../src/runtime/supervisor/recovery.js'
import { evaluateWait, type WaitFacts } from '../../src/runtime/supervisor/wait.js'

const digest = (value: W.JsonValue) => {
  let h = 0
  for (const ch of JSON.stringify(value)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0
  return h.toString(16).padStart(8, '0').repeat(8)
}
const scope = {
  kind: 'session',
  installationId: 'i',
  runtimeId: 'r',
  tenantId: 't',
  workspaceId: 'w',
  sessionId: 's1',
} as unknown as W.ScopeRef

describe('admission identity', () => {
  it('converges on retry and separates scope and key', () => {
    const a = admissionIds(scope, 'idem-1', 'spec-a', digest)
    expect(admissionIds(scope, 'idem-1', 'spec-a', digest)).toEqual(a)
    expect(admissionIds(scope, 'idem-2', 'spec-a', digest).ticketId).not.toBe(a.ticketId)
    expect(
      admissionIds({ ...scope, sessionId: 's2' } as unknown as W.ScopeRef, 'idem-1', 'spec-a', digest).runId,
    ).not.toBe(a.runId)
    expect(a.runKey).toBe('idem-1')
  })
  it('keeps the runKey but changes the ticket when the spec changes, so the coordinator run-key index conflicts', () => {
    const a = admissionIds(scope, 'idem-1', 'spec-a', digest)
    const b = admissionIds(scope, 'idem-1', 'spec-b', digest)
    expect(b.runKey).toBe(a.runKey)
    expect(b.ticketId).not.toBe(a.ticketId)
    expect(b.runId).not.toBe(a.runId)
  })
  it('reads the session only from session-bearing scopes', () => {
    expect(sessionIdOf(scope)).toBe('s1')
    expect(sessionIdOf({ kind: 'runtime' } as unknown as W.ScopeRef)).toBe(null)
    expect(workspaceIdOf(scope)).toBe('w')
    expect(workspaceIdOf({ kind: 'runtime' } as unknown as W.ScopeRef)).toBe(null)
  })
})

describe('lifetime and timebox', () => {
  const t0 = Date.parse('2026-10-05T00:00:00.000Z')
  it('defaults to thirty days, clamps to delegation, refuses beyond 365 days', () => {
    expect(lifetimeDeadline(t0, 30 * 86_400_000, null)).toBe('2026-11-04T00:00:00.000Z')
    expect(lifetimeDeadline(t0, 30 * 86_400_000, t0 + 1000)).toBe('2026-10-05T00:00:01.000Z')
    expect(() => lifetimeDeadline(t0, 366 * 86_400_000, null)).toThrow(/365d/)
    expect(() => lifetimeDeadline(t0, 1000, t0)).toThrow(/expired/)
  })
  it('takes the minimum persisted bound', () => {
    expect(maxDeadline(['2026-10-06T00:00:00.000Z', null, '2026-10-05T12:00:00.000Z'])).toBe(
      '2026-10-05T12:00:00.000Z',
    )
    expect(() => maxDeadline([null])).toThrow(/bound/)
    expect(
      actionTimebox('2026-10-05T00:00:00.000Z', 120_000, ['2026-10-06T00:00:00.000Z']).defaultTimeoutMs,
    ).toBe(120_000)
  })
})

const facts = (over: Partial<WaitFacts> = {}): WaitFacts => ({
  nowMs: 1_000,
  keys: new Map([
    ['a', 'act-a'],
    ['b', 'act-b'],
  ]),
  views: new Map(),
  interactions: new Map(),
  signals: [],
  ...over,
})
const clause = (mode: 'any' | 'all', readyWhen: 'receipt' | 'resolved' = 'receipt'): W.WaitCondition => ({
  anyOf: [{ kind: 'actions', mode, readyWhen, actions: [{ localKey: 'a' }, { localKey: 'b' }] }],
})
const view = (outcome: 'succeeded' | 'unknown_effect', visibility: 'ready' | 'pending' = 'ready') => ({
  visibility,
  outcome,
})

describe('wait evaluation', () => {
  it('any needs one visible result and all needs every one', () => {
    const one = facts({ views: new Map([['act-a', view('succeeded')]]) })
    expect(evaluateWait(clause('any'), one).satisfied).toBe(true)
    expect(evaluateWait(clause('all'), one).satisfied).toBe(false)
    const both = facts({
      views: new Map([
        ['act-a', view('succeeded')],
        ['act-b', view('succeeded')],
      ]),
    })
    expect(evaluateWait(clause('all'), both).satisfied).toBe(true)
  })
  it('a raw or pending receipt never satisfies; an unresolved localKey never satisfies', () => {
    expect(
      evaluateWait(clause('any'), facts({ views: new Map([['act-a', view('succeeded', 'pending')]]) }))
        .satisfied,
    ).toBe(false)
    expect(
      evaluateWait(clause('any'), facts({ keys: new Map(), views: new Map([['act-a', view('succeeded')]]) }))
        .satisfied,
    ).toBe(false)
  })
  it('unknown_effect wakes receipt waits but not resolved waits', () => {
    const f = facts({ views: new Map([['act-a', view('unknown_effect')]]) })
    expect(evaluateWait(clause('any', 'receipt'), f).satisfied).toBe(true)
    expect(evaluateWait(clause('any', 'resolved'), f).satisfied).toBe(false)
  })
  it('signals need seq > afterSeq, a listed type and no consumption', () => {
    const cond: W.WaitCondition = { anyOf: [{ kind: 'signals', typeIds: ['t/x@1'], afterSeq: 4 }] }
    expect(
      evaluateWait(cond, facts({ signals: [{ seq: 4, typeId: 't/x@1', consumed: false }] })).satisfied,
    ).toBe(false)
    expect(
      evaluateWait(cond, facts({ signals: [{ seq: 5, typeId: 't/x@1', consumed: true }] })).satisfied,
    ).toBe(false)
    expect(
      evaluateWait(cond, facts({ signals: [{ seq: 5, typeId: 't/y@1', consumed: false }] })).satisfied,
    ).toBe(false)
    expect(evaluateWait(cond, facts({ signals: [{ seq: 5, typeId: 't/x@1', consumed: false }] }))).toEqual({
      satisfied: true,
      by: 'clause',
      clause: 0,
    })
  })
  it('interaction wakes on any terminal answer; deadline is an extra OR and a bare deadline waits for it', () => {
    const ask: W.WaitCondition = { anyOf: [{ kind: 'interaction', interactionId: 'q1' }] }
    expect(evaluateWait(ask, facts({ interactions: new Map([['q1', 'pending']]) })).satisfied).toBe(false)
    expect(evaluateWait(ask, facts({ interactions: new Map([['q1', 'terminal']]) })).satisfied).toBe(true)
    const timer: W.WaitCondition = { anyOf: [], deadline: new Date(2_000).toISOString() }
    expect(evaluateWait(timer, facts({ nowMs: 1_999 })).satisfied).toBe(false)
    expect(evaluateWait(timer, facts({ nowMs: 2_000 }))).toEqual({ satisfied: true, by: 'deadline' })
  })
  it('is idempotent for a duplicated wake', () => {
    const f = facts({ views: new Map([['act-a', view('succeeded')]]) })
    expect(evaluateWait(clause('any'), f)).toEqual(evaluateWait(clause('any'), f))
  })
})

const fact = (id: string, state: W.ActionState, over: Partial<ActionFact> = {}): ActionFact => ({
  actionId: id,
  parentActionId: null,
  state,
  obligation: 'mandatory',
  owner: { kind: 'run', id: 'run-1' },
  ...over,
})

describe('terminal judgement', () => {
  it('completes only with every mandatory action settled', () => {
    expect(judgeComplete(0, [fact('a', 'settled')])).toMatchObject({ ok: true })
    expect(judgeComplete(0, [fact('a', 'running')])).toEqual({
      ok: false,
      code: 'conflict',
      detailCode: 'supervisor_complete_pending',
    })
  })
  it('refuses completion over an unresolved unknown effect, an open child and a same-batch action', () => {
    expect(judgeComplete(0, [fact('a', 'unknown')])).toMatchObject({
      detailCode: 'supervisor_complete_unknown',
    })
    expect(
      judgeComplete(0, [fact('a', 'reconciling', { owner: { kind: 'reconciliation', id: 'c' } })]),
    ).toMatchObject({ detailCode: 'supervisor_complete_unknown' })
    expect(judgeComplete(0, [fact('c', 'dispatching', { parentActionId: 'p' })])).toMatchObject({
      detailCode: 'supervisor_complete_children',
    })
    expect(judgeComplete(1, [])).toMatchObject({ detailCode: 'supervisor_complete_new_actions' })
  })
  it('lets a job-owned detached action outlive completion and lists its owner', () => {
    const owner = { kind: 'job', id: 'job-1' } as const
    expect(judgeComplete(0, [fact('d', 'running', { obligation: 'detached', owner })])).toEqual({
      ok: true,
      unknownActionIds: [],
      detachedOwnerRefs: [owner],
    })
    expect(judgeComplete(0, [fact('d', 'running', { obligation: 'detached' })])).toMatchObject({
      detailCode: 'supervisor_detached_owner_missing',
    })
  })
  it('drain keeps unknown effects supervised and blocks finalization until in-flight work ends', () => {
    const plan = planDrain([
      fact('p', 'prepared'),
      fact('r', 'running'),
      fact('u', 'unknown', { owner: { kind: 'reconciliation', id: 'chk' } }),
      fact('s', 'settled'),
    ])
    expect(plan.settleUndispatched).toEqual(['p'])
    expect(plan.cancelInflight).toEqual(['r'])
    expect(plan.unknownActionIds).toEqual(['u'])
    expect(plan.canFinalize).toBe(false)
    expect(
      planDrain([fact('u', 'unknown', { owner: { kind: 'reconciliation', id: 'chk' } })]).canFinalize,
    ).toBe(true)
    expect(planDrain([fact('u', 'unknown')]).canFinalize).toBe(false)
  })
})

const base: RecoveryInput = {
  action: 'dispatching',
  attempt: { number: 1, state: 'running' },
  viewReady: false,
  rawReceipt: false,
  retry: { mode: 'never', maxAttempts: 1, backoffMs: [] },
  semantics: 'receipt-query',
  lookup: null,
}
describe('crash recovery step', () => {
  it('dispatches only intents that never reached an attempt', () => {
    expect(recoveryStep({ ...base, action: 'prepared', attempt: null })).toBe('dispatch')
    expect(recoveryStep({ ...base, action: 'dispatching', attempt: { number: 1, state: 'allocated' } })).toBe(
      'resume-allocated',
    )
  })
  it('never re-dispatches a possibly sent call without evidence', () => {
    expect(recoveryStep(base)).toBe('lookup')
    expect(recoveryStep({ ...base, semantics: 'non-idempotent' })).toBe('mark-unknown')
    expect(recoveryStep({ ...base, lookup: 'unknown' })).toBe('mark-unknown')
    expect(recoveryStep({ ...base, lookup: 'not-found-unsafe' })).toBe('mark-unknown')
  })
  it('retries the same identity only inside the declared policy and budget', () => {
    const retry: W.RetryPolicy = { mode: 'reconcile_first', maxAttempts: 2, backoffMs: [] }
    expect(recoveryStep({ ...base, retry, lookup: 'not-found-safe' })).toBe('retry-same-identity')
    expect(recoveryStep({ ...base, retry: { ...retry, maxAttempts: 1 }, lookup: 'not-found-safe' })).toBe(
      'mark-unknown',
    )
    expect(
      recoveryStep({
        ...base,
        retry: { mode: 'before_dispatch', maxAttempts: 3, backoffMs: [] },
        lookup: 'not-found-safe',
      }),
    ).toBe('mark-unknown')
  })
  it('finishes a pending visible result instead of rerunning, and redelivers a ready one', () => {
    expect(recoveryStep({ ...base, rawReceipt: true })).toBe('finish-view')
    expect(
      recoveryStep({ ...base, action: 'settled', attempt: { number: 1, state: 'settled' }, viewReady: true }),
    ).toBe('redeliver')
  })
})
