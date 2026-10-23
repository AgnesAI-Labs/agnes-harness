import type { UITurn } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { turnErrorMessageFacts, turnErrorView } from '../src/conversation/turn-error.js'

const turn = (extra: Partial<UITurn> = {}): UITurn => ({
  id: 'turn:1',
  turn: 1,
  startSeq: 1,
  startedAt: '2026-10-21T00:00:00.000Z',
  status: 'failed',
  nodeIds: ['user'],
  inherited: false,
  forkable: false,
  usage: {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    reasoningComplete: true,
    billingComplete: true,
    calls: [],
  },
  ...extra,
})

const failure = (code: string) => turn({ error: { code, message: 'status=500' } })

describe('turn error classification', () => {
  it.each([
    ['AUTH', 'auth', ['account']],
    ['PROVIDER_UNCONFIGURED', 'auth', ['account']],
    ['QUOTA', 'quota', ['account']],
    ['RATE_LIMIT', 'rate', ['retry']],
    ['TIMEOUT', 'timeout', ['retry']],
    ['TRANSPORT', 'transport', ['retry']],
    ['CONTRACT_MISMATCH', 'transport', ['retry']],
    ['NO_MODEL', 'model', ['model']],
    ['NO_ADAPTER', 'model', ['model']],
    ['OVERFLOW', 'context', []],
    ['FORMAT', 'format', ['retry']],
    ['E_WORKSPACE_CLOSED', 'workspace', []],
    ['E_FS_DENIED', 'workspace', []],
    ['E_FS_IO', 'workspace', []],
    ['E_FS_CHECK_FAILED', 'workspace', []],
    ['E_STEP_FAILED', 'internal', ['retry']],
    ['E_RELATION', 'internal', ['retry']],
    ['E_LEDGER_INTEGRITY', 'internal', []],
    ['LEDGER_FAILED', 'internal', []],
    ['HOOK_BLOCKED', 'internal', []],
    ['CODE_RUNTIME_UNAVAILABLE', 'internal', ['retry']],
    ['INTERRUPTED', 'interrupted', ['retry']],
  ] as const)('reads %s as %s with %j', (code, kind, actions) => {
    const view = turnErrorView(failure(code))
    expect(view.kind).toBe(kind)
    expect(view.actions).toEqual(actions)
    expect(view.detail).toEqual({ code, message: 'status=500' })
  })

  it.each([
    ['budget', 'budget', []],
    ['max_steps', 'steps', []],
    ['interrupted', 'interrupted', ['retry']],
  ] as const)('falls back to the reason %s (%s)', (reason, kind, actions) => {
    const view = turnErrorView(turn({ reason }))
    expect(view).toMatchObject({ kind, actions })
    expect(view.detail).toBeUndefined()
  })

  it('keeps an unknown code retryable and never guesses by spelling', () => {
    expect(turnErrorView(failure('E_RUNTIME')).kind).toBe('unknown')
    expect(turnErrorView(failure('E_RUNTIME')).actions).toEqual(['retry'])
    expect(turnErrorView(failure('AUTH_TIMEOUT')).kind).toBe('unknown')
  })

  it('drops the code display when the turn ended without an error object', () => {
    const view = turnErrorView(turn({ reason: 'error' }))
    expect(view).toEqual({ kind: 'unknown', actions: ['retry'] })
  })

  it('keeps the raw record beside the sentence for the details disclosure', () => {
    const view = turnErrorView(
      turn({ reason: 'error', error: { code: 'TRANSPORT', message: 'status=502 requestId=req_abc123' } }),
    )
    expect(view.detail).toEqual({
      code: 'TRANSPORT',
      reason: 'error',
      message: 'status=502 requestId=req_abc123',
    })
  })
})

describe('redacted message facts', () => {
  it('takes the numeric status and the request id', () => {
    expect(turnErrorMessageFacts('status=500 requestId=req_8f3a2b7d')).toEqual({
      status: '500',
      requestId: 'req_8f3a2b7d',
    })
  })

  it('ignores the unknown-status placeholder', () => {
    expect(turnErrorMessageFacts('status=? requestId=req_8f3a2b7d')).toEqual({
      requestId: 'req_8f3a2b7d',
    })
    expect(turnErrorMessageFacts('status=?')).toEqual({})
  })

  it('does not invent facts from free text', () => {
    expect(turnErrorMessageFacts('the provider said no')).toEqual({})
    expect(turnErrorMessageFacts('status=5000')).toEqual({})
    expect(turnErrorMessageFacts(undefined)).toEqual({})
  })
})
