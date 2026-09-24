import { describe, expect, it } from 'vitest'
import { CORE_CHECKS } from '../src/invariants/core-checks.js'
import { InvariantRegistry } from '../src/invariants/registry.js'
import { foldEvents } from '../src/reduce/reducer.js'
import type { Event } from '../src/types.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
let seq = 0
const ev = (type: string, data: unknown, extra: Partial<Event> = {}): Event =>
  ({
    seq: ++seq,
    ts: 't',
    id: `01J6ZM2Q3R4S5T6V7W8X9Y0Z${String(seq).padStart(2, '0')}`,
    type,
    data,
    actor,
    origin: 'system',
    trust: 'trusted',
    lane: 'main',
    v: 1,
    ...extra,
  }) as Event

describe('invariants', () => {
  it('registers core checks and requires every package to declare', () => {
    const r = new InvariantRegistry()
    r.register('@agnes/core', CORE_CHECKS)
    r.register('@agnes/base', { none: true, reason: 'persistence needs backend round-trips' })
    expect(r.packages()).toEqual([
      { pkg: '@agnes/core', checks: CORE_CHECKS.length },
      { pkg: '@agnes/base', checks: 0, blank: 'persistence needs backend round-trips' },
    ])
    expect(() => r.register('@agnes/core', [])).toThrow(/already/)
  })

  it('flags seq gaps, aborted without cancel, unpaired tool results and ledger rows without usage', () => {
    seq = 0
    const events = [
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev('op.state', { meta: {} }, { register: 'op.state' }),
      ev('step/start', { turn: 1, step: 1 }),
    ]
    events.push({
      ...ev('tool/result', {
        toolUseId: 'ghost',
        content: [],
        isError: false,
        enforcement: { level: 'full', scope: [] },
        authz: { decisionId: 'n/a' },
      }),
      seq: 9,
    })
    seq = 9
    events.push(
      ev('effect/settled', { effectId: 'e', outcome: 'aborted' }),
      ev('cost/ledger', { purpose: 'inference', effectId: 'e', creditSource: 'gateway', model: 'm' }),
    )
    const r = new InvariantRegistry()
    r.register('@agnes/core', CORE_CHECKS)
    const rules = r
      .run(events, foldEvents([]))
      .map((v) => v.rule)
      .sort()
    expect(rules).toEqual([
      'aborted-after-cancel',
      'ledger-usage-present',
      'seq-monotonic',
      'tool-result-paired',
    ])
  })

  it('a clean session produces no violations', () => {
    seq = 0
    const events = [
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev('op.state', { meta: {} }, { register: 'op.state' }),
      ev('step/start', { turn: 1, step: 1 }),
      ev('tool/call', { toolUseId: 't', name: 'read', args: {}, ordinal: 0 }),
      ev('tool/result', {
        toolUseId: 't',
        content: [],
        isError: false,
        enforcement: { level: 'full', scope: [] },
        authz: { decisionId: 'n/a' },
      }),
      ev('step/end', { turn: 1, step: 1 }),
      ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
      ev('op.state', null, { register: 'op.state' }),
    ]
    const r = new InvariantRegistry()
    r.register('@agnes/core', CORE_CHECKS)
    expect(r.run(events, foldEvents([]))).toEqual([])
  })

  it('flags request/sent with reordered, orphaned, or duplicate causal sources', () => {
    const registry = new InvariantRegistry()
    registry.register('@agnes/core', CORE_CHECKS)
    const causal = (events: Event[]) =>
      registry.run(events, foldEvents([])).filter((violation) => violation.rule === 'request-sent-causal')

    seq = 0
    const prefix = [
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev('op.state', { meta: {} }, { register: 'op.state' }),
      ev('step/start', { turn: 1, step: 1 }),
      ev('request/header', { model: 'm' }),
      ev('effect/intent', { effectId: 'inf', kind: 'inference', replay: 'never' }),
    ]
    const sources = [prefix[3]?.seq ?? 0, prefix[4]?.seq ?? 0]
    const receipt = ev('request/sent', {}, { sourceEventSeqs: sources })
    expect(causal([...prefix, receipt])).toEqual([])
    expect(causal([...prefix, receipt, ev('request/sent', {}, { sourceEventSeqs: sources })])).toHaveLength(1)

    seq = 0
    const reordered = [
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev('op.state', { meta: {} }, { register: 'op.state' }),
      ev('step/start', { turn: 1, step: 1 }),
      ev('request/header', { model: 'm' }),
      ev('effect/intent', { effectId: 'inf', kind: 'inference', replay: 'never' }),
    ]
    reordered.push(
      ev('request/sent', {}, { sourceEventSeqs: [reordered[4]?.seq ?? 0, reordered[3]?.seq ?? 0] }),
    )
    expect(causal(reordered)).toHaveLength(1)

    seq = 0
    const orphaned = [
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev('op.state', { meta: {} }, { register: 'op.state' }),
      ev('step/start', { turn: 1, step: 1 }),
      ev('request/header', { model: 'm' }),
      ev('assistant/output', {
        state: 'started',
        effectId: 'none',
        chars: { text: 1, thinking: 0 },
        estimatedTokens: 1,
      }),
    ]
    orphaned.push(ev('request/sent', {}, { sourceEventSeqs: [orphaned[3]?.seq ?? 0, orphaned[4]?.seq ?? 0] }))
    expect(causal(orphaned)).toHaveLength(1)

    for (const outputType of ['assistant/output', 'assistant/message'] as const) {
      seq = 0
      const late = [
        ev('turn/start', { turn: 1, trigger: 'prompt' }),
        ev('op.state', { meta: {} }, { register: 'op.state' }),
        ev('step/start', { turn: 1, step: 1 }),
        ev('request/header', { model: 'm' }),
        ev('effect/intent', { effectId: 'inf', kind: 'inference', replay: 'never' }),
        outputType === 'assistant/output'
          ? ev('assistant/output', {
              state: 'started',
              effectId: 'inf',
              chars: { text: 1, thinking: 0 },
              estimatedTokens: 1,
            })
          : ev('assistant/message', { content: [], stopReason: 'end_turn', requestSeq: 4 }),
      ]
      late.push(ev('request/sent', {}, { sourceEventSeqs: [late[3]?.seq ?? 0, late[4]?.seq ?? 0] }))
      expect(causal(late), outputType).toHaveLength(1)
    }
  })

  // Reverse-verification: the two tests above exercise only 4 of the 10 rules. These two cover the
  // remaining 6 — each by constructing a batch a real writer would never produce, confirming the check
  // fires, then repairing the same batch and confirming it goes quiet (no false positive).
  it('flags a reopened turn, an orphaned step/exec row, and an unintended effect', () => {
    seq = 0
    const broken = [
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev('turn/start', { turn: 2, trigger: 'prompt' }),
      ev('effect/settled', { effectId: 'y', outcome: 'completed' }),
      ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
      ev('step/start', { turn: 2, step: 1 }),
      ev('request/header', { model: 'm' }),
    ]
    const r = new InvariantRegistry()
    r.register('@agnes/core', CORE_CHECKS)
    expect(
      r
        .run(broken, foldEvents([]))
        .map((v) => v.rule)
        .sort(),
    ).toEqual(['exec-events-in-turn', 'settled-has-intent', 'step-in-turn', 'turn-open-unique'])

    seq = 0
    const fixed = [
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev('op.state', { meta: {} }, { register: 'op.state' }),
      ev('effect/intent', { effectId: 'y', kind: 'tool', replay: 'idempotent' }),
      ev('effect/settled', { effectId: 'y', outcome: 'completed' }),
      ev('request/header', { model: 'm' }),
      ev('step/start', { turn: 1, step: 1 }),
    ]
    expect(r.run(fixed, foldEvents([]))).toEqual([])
  })

  it('flags an open turn missing its op.state register and a replace whose sourceEventSeqs miss its range', () => {
    seq = 0
    const broken = [
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev(
        'assistant/message',
        { role: 'assistant', content: [] },
        { surfaceOp: { op: 'replace', start: 2, end: 2 } },
      ),
    ]
    const r = new InvariantRegistry()
    r.register('@agnes/core', CORE_CHECKS)
    expect(
      r
        .run(broken, foldEvents([]))
        .map((v) => v.rule)
        .sort(),
    ).toEqual(['op-state-iff-turn', 'replace-brackets'])

    seq = 0
    const fixed = [
      ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ev('op.state', { meta: {}, control: { status: 'running' } }, { register: 'op.state' }),
      ev(
        'assistant/message',
        { role: 'assistant', content: [] },
        { surfaceOp: { op: 'replace', start: 3, end: 3 }, sourceEventSeqs: [3] },
      ),
    ]
    expect(r.run(fixed, foldEvents([]))).toEqual([])
  })
})
