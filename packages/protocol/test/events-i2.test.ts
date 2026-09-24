import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { X_AGNES_DATA } from '../gen/ts/session-v1.js'
import { EVENT_TYPES, validateEvent } from '../src/index.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const env = (type: string, data: unknown, seq = 1) => ({
  seq,
  ts: '2026-09-07T00:00:00Z',
  id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
  type,
  data,
  actor,
  origin: 'system',
  trust: 'trusted',
})

describe('session-v1 I2: every closed-set type has a data schema', () => {
  it('x-agnes-data covers exactly EVENT_TYPES', () => {
    expect(Object.keys(X_AGNES_DATA).sort()).toEqual([...EVENT_TYPES].sort())
  })
  it('no type in the closed set falls through stage two any more', () => {
    expect(validateEvent(env('cost/ledger', { anything: 1 })).ok).toBe(false)
  })
  it('the program counter is no longer a row type', () => {
    expect(validateEvent({ ...env('op.state', null), register: 'op.state' }).ok).toBe(false)
  })
  it('register tombstones are valid', () => {
    for (const reg of ['plan.items', 'budget.state', 'artifact/job', 'inbox'])
      expect(validateEvent({ ...env(reg, null), register: reg }).ok, reg).toBe(true)
  })
  // The harness/entry cell is keyed by the kind/id pair read out of `data`, so a `data: null`
  // tombstone cannot name the key it removes. core reads `data.tombstone === true` for this one
  // register, and the schema has to accept that branch as well as the live entry.
  it('harness/entry deletes with the keyed tombstone branch, and refuses a half-hearted one', () => {
    const gone = validateEvent({
      ...env('harness/entry', { kind: 'skill', id: 'x', tombstone: true }),
      register: 'harness/entry',
    })
    expect(gone.ok).toBe(true)
    // `data: null` is legal for the other five registers and meaningless for this one, but it is a
    // legal branch here too: what it cannot do is name a key. The shape that must be refused is a
    // tombstone flag that says false, which would read as a live entry with no content.
    const halfhearted = validateEvent({
      ...env('harness/entry', { kind: 'skill', id: 'x', tombstone: false }),
      register: 'harness/entry',
    })
    expect(halfhearted.ok).toBe(false)
  })
  it('accepts a full cost/ledger row with timing', () => {
    const r = validateEvent(
      env('cost/ledger', {
        purpose: 'inference',
        effectId: 'e1',
        credits: 12.5,
        creditSource: 'estimated',
        tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
        model: 'm',
        timing: { ttftMs: 120, durationMs: 900 },
      }),
    )
    expect(r.ok, r.ok ? '' : JSON.stringify(r.errors)).toBe(true)
  })
  // The regression this task exists not to cause: every shape core writes today must still validate
  // now that stage two is on for all 30. One row per writer, taken from the writer's own code.
  it('accepts every shape core writes today', () => {
    const rows: Array<[string, unknown]> = [
      [
        'assistant/output',
        { state: 'started', effectId: 'e1', chars: { text: 2, thinking: 0 }, estimatedTokens: 1 },
      ],
      [
        'budget.state',
        {
          slot: 'primary',
          escalate: false,
          creditsUsed: 0,
          creditsCap: null,
          lastPreflight: { tokens: 12, source: 'estimate' },
        },
      ],
      [
        'effect/intent',
        { effectId: 'e1', kind: 'tool', replay: 'safe', tool: { toolUseId: 't1', name: 'read' }, argsSeq: 3 },
      ],
      ['effect/intent', { effectId: 'e2', kind: 'inference', replay: 'never', slot: 'primary' }],
      ['effect/intent', { effectId: 'e3', kind: 'media', replay: 'never', slot: 'image' }],
      ['effect/settled', { effectId: 'e1', outcome: 'ok', durationMs: 4 }],
      ['verifier/signal', { scope: 'turn', tier: 0, verdict: 'pass', reasons: [] }],
      ['repair/decision', { round: 1, decision: 'repair', verdictSeq: 9 }],
      ['format/deviation', { rule: 'unparsed', model: 'm', sampleHash: 'a'.repeat(64), parserVersion: '1' }],
      [
        'cost/ledger',
        {
          purpose: 'inference',
          effectId: 'e1',
          creditSource: 'estimated',
          model: 'm',
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      // bindingHash is the empty string on the budget and the unknown-outcome paths: neither ask is
      // bound to a tool argv, so the pattern has to admit '' as well as 64 hex digits.
      [
        'approval/asked',
        {
          requestId: 'r1',
          kind: 'budget',
          summary: 's',
          risk: 'budget',
          bindingHash: '',
          deadline: '2026-09-09T00:00:00Z',
        },
      ],
      [
        'approval/asked',
        {
          requestId: 'r2',
          kind: 'tool',
          toolUseId: 't1',
          summary: 'read {}',
          risk: 'destructive',
          bindingHash: 'b'.repeat(64),
          deadline: '2026-09-09T00:00:00Z',
          pending: { ticket: 'tk', expiresAt: '2026-09-09T00:01:00Z' },
        },
      ],
      ['approval/decided', { requestId: 'r1', verdict: 'rejected', via: 'sync' }],
      ['plan.items', { items: [{ id: 'a', text: 'do', status: 'todo' }] }],
      ['artifact/job', { jobId: 'j1', status: 'queued' }],
    ]
    for (const [type, data] of rows) {
      const r = validateEvent(env(type, data))
      expect(r.ok, `${type}: ${r.ok ? '' : JSON.stringify(r.errors)}`).toBe(true)
    }
  })

  it('requires media effects to use the never-replay contract', () => {
    expect(
      validateEvent(env('effect/intent', { effectId: 'media-1', kind: 'media', replay: 'never' })).ok,
    ).toBe(true)
    for (const replay of ['safe', 'idempotent'])
      expect(
        validateEvent(env('effect/intent', { effectId: 'media-1', kind: 'media', replay })).ok,
        replay,
      ).toBe(false)
  })
  it('inbox is one cell holding the whole queue', () => {
    const ok = validateEvent({
      ...env('inbox', {
        items: [
          {
            itemId: 'i1',
            target: 'next-turn',
            content: [{ type: 'text', text: 'hi' }],
            actor,
            enqueuedAt: '2026-09-09T00:00:00Z',
          },
        ],
      }),
      register: 'inbox',
    })
    expect(ok.ok, ok.ok ? '' : JSON.stringify(ok.errors)).toBe(true)
    // The pre-I2 two-slot shape must not slip through: a reader that expected it would find no
    // queue at all and report an empty inbox rather than a malformed one.
    expect(validateEvent(env('inbox', { nextTurn: null, nextStep: null })).ok).toBe(false)
  })
  it('approval/decided requires via in the closed set', () => {
    const bad = validateEvent(env('approval/decided', { requestId: 'r1', verdict: 'rejected', via: 'magic' }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors[0]).toMatchObject({ code: 'ENUM' })
  })
  it('all checked-in i2 fixtures agree with the validator', () => {
    const lines = readFileSync(new URL('../fixtures/events/i2-types.jsonl', import.meta.url), 'utf8')
      .split('\n')
      .filter(Boolean)
    // Exact, not a lower bound: a loose lower bound would let half the fixtures be deleted without
    // going red.
    expect(lines.length).toBe(39) // prior 37 plus subagent/cost valid+invalid
    for (const line of lines) {
      const f = JSON.parse(line) as { id: string; kind: 'valid' | 'invalid'; payload: unknown }
      expect(validateEvent(f.payload).ok, f.id).toBe(f.kind === 'valid')
    }
  })
})
