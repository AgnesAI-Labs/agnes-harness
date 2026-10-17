import { describe, expect, it } from 'vitest'
import { CHECKPOINT_MAX_BYTES, codec, encodeState, initialState, parseJevState } from '../src/state.js'
import type { HistoryEntry } from '../src/types.js'

const big = (i: number): HistoryEntry => ({
  phase: 'INSPECT',
  operation: 'read',
  target: `f${i}`,
  status: 'succeeded',
  disposition: 'SUCCEEDED',
  summary: `read(f${i}) conf=0.90`,
  error: {
    code: 'X',
    kind: 'execution',
    stage: 'dispatch',
    recoverability: 'recoverable',
    message: 'm'.repeat(200),
  },
  intentFp: 'a'.repeat(32),
  observationFp: 'b'.repeat(32),
  dispatched: true,
})

describe('checkpoint codec v1', () => {
  it('round-trips the initial state', () => {
    const cp = encodeState(initialState())
    expect(cp.codecVersion).toBe(1)
    expect(parseJevState(codec.decode(cp))).toEqual(initialState())
  })
  it('rejects other versions and malformed states', () => {
    expect(() => codec.decode({ codecVersion: 2, state: null })).toThrow('expected 1')
    expect(() => parseJevState({ ...initialState(), stage: 'nope' } as never)).toThrow()
    expect(() => parseJevState({ ...initialState(), v: 2 } as never)).toThrow()
  })
  it('stays within 32 KiB: prior history first, then the previous answer, then the goal', () => {
    const s = initialState()
    s.workspace.history = Array.from({ length: 60 }, (_, i) => big(i))
    s.workspace.turnStart = 40
    s.workspace.previousAnswer = 'p'.repeat(4000)
    s.workspace.goal = '目'.repeat(20000)
    const cp = encodeState(s)
    expect(Buffer.byteLength(JSON.stringify(cp.state))).toBeLessThanOrEqual(CHECKPOINT_MAX_BYTES)
    const out = parseJevState(cp.state)
    expect(out.workspace.history.length).toBeLessThan(60)
    expect(out.workspace.history.at(-1)?.target).toBe('f59')
    expect(out.workspace.goal.length).toBeLessThanOrEqual(4003)
    expect(s.workspace.history).toHaveLength(60)
  })
  it('round-trips a populated mid-step state and rejects incomplete calls', () => {
    const s = initialState()
    s.stage = 'dispatch'
    s.idTurn = 3
    s.coreTurn = 7
    s.step = 4
    s.cur = {
      jevAttempts: ['jev:3:4:d0'],
      level: 2,
      decision: {
        phase: 'ACT',
        op: 'edit',
        target: 'a.ts',
        bindingMode: 'llm_parameters',
        args: { path: 'a.ts' },
        confidence: 0.8,
        operationPathConfidence: 0.8,
        targetConfidence: null,
        ambiguity: 0.1,
        progress: null,
        phaseTop: [['ACT', 0.9]],
        actionTop: [['edit', 0.8]],
        consumed: [{ role: 'phase', head: 'h', selected: 'ACT', confidence: 0.9, deterministic: false }],
      },
      route: { kind: 'parameters', reason: null },
      llm: { kind: 'parameters', attempt: 1, note: 'n' },
      calls: [{ invocationId: 'jev:3:4:t0', name: 'edit', args: { path: 'a.ts' }, announce: 'true' }],
    }
    s.workspace.history = [big(0)]
    s.endReason = 'error'
    s.endError = { code: 'X', message: 'm' }
    expect(parseJevState(codec.decode(codec.encode(s as never)))).toEqual(s)
    const broken = structuredClone(s) as never as { cur: { calls: Array<Record<string, unknown>> } }
    delete broken.cur.calls[0]?.name
    expect(() => parseJevState(broken as never)).toThrow('cur.calls[0].name')
  })
})
