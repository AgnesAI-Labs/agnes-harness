import { describe, expect, it } from 'vitest'
import { type ModelDeps, requestLlm } from '../src/model.js'

type Call = { op: string; detail?: unknown }
const text = [
  { type: 'text_delta', delta: 'ok' },
  { type: 'done', reason: 'stop' },
]
const error = (code: string, retryable: boolean, retryAfterMs?: number) => [
  {
    type: 'error',
    reason: 'error',
    code,
    message: code,
    retryable,
    ...(retryAfterMs ? { retryAfterMs } : {}),
  },
]
function deps(
  replies: unknown[][],
  over: { shouldCompact?: boolean; envelopeOnce?: boolean; compaction?: 'running' | 'ended' | 'none' } = {},
) {
  const calls: Call[] = []
  let envelope = over.envelopeOnce ?? false
  const d = {
    prepareRequest: async (options: unknown) => {
      calls.push({ op: 'prepare', detail: options })
      if (envelope) {
        envelope = false
        throw Object.assign(new Error('outside catalog'), { code: 'E_ENVELOPE' })
      }
      return { options } as never
    },
    estimateRequest: async () => ({
      inputTokens: 10,
      source: 'estimate',
      projectedCredits: null,
      contextWindow: 1000,
      reserveTokens: 0,
      remainingTokens: 990,
      shouldCompact: over.shouldCompact === true && calls.filter((c) => c.op === 'compact').length === 0,
    }),
    model: {
      complete: async () => {
        calls.push({ op: 'complete' })
        return (replies.shift() ?? text) as never
      },
      stream: undefined as never,
    },
    turn: {
      view: async () => null,
      endStep: async () => void calls.push({ op: 'endStep' }),
      cancelled: () => false,
    },
    ...(over.compaction === 'none'
      ? {}
      : {
          compaction: {
            run: async () => {
              calls.push({ op: 'compact' })
              return over.compaction === 'ended'
                ? { outcome: 'turn-ended', reason: 'budget' }
                : { outcome: 'running' }
            },
          },
        }),
    wait: {
      delay: async (ms: number) => void calls.push({ op: 'delay', detail: ms }),
      park: async () => {},
      wake: async () => {},
    },
    save: async (llm: unknown, id: string) => void calls.push({ op: 'save', detail: [id, llm] }),
    recomputeToolNames: async () => {
      calls.push({ op: 'recompute' })
      return ['read']
    },
  } as unknown as ModelDeps
  return { d, calls }
}
const req = (over: object = {}) => ({
  idPrefix: 'jev:1:0',
  kind: 'parameters' as const,
  note: '[parameter request] x',
  firstAttempt: 0,
  maxAttempts: 2,
  toolNames: ['ls', 'read'],
  ...over,
})
const signal = new AbortController().signal
const prepares = (calls: Call[]) => calls.filter((c) => c.op === 'prepare').map((c) => c.detail)

describe('requestLlm', () => {
  it('sends the first attempt with the committed note and the fixed tools, after saving', async () => {
    const { d, calls } = deps([text])
    expect(await requestLlm(req(), d, signal)).toMatchObject({
      kind: 'reply',
      attempts: 1,
      ids: ['jev:1:0:m0'],
    })
    expect(prepares(calls)).toEqual([
      {
        tools: ['ls', 'read'],
        invocationId: 'jev:1:0:m0',
        tailNote: { text: '[parameter request] x', commit: true },
      },
    ])
    expect(calls.map((c) => c.op)).toEqual(['save', 'prepare', 'complete'])
  })
  it('retries a retryable error once, without the note, after the backoff', async () => {
    const { d, calls } = deps([error('TRANSPORT', true), text])
    expect(await requestLlm(req(), d, signal)).toMatchObject({
      kind: 'reply',
      attempts: 2,
      ids: ['jev:1:0:m0', 'jev:1:0:m1'],
    })
    expect(prepares(calls)[1]).toEqual({ tools: ['ls', 'read'], invocationId: 'jev:1:0:m1' })
    expect(calls.find((c) => c.op === 'delay')?.detail).toBe(1000)
  })
  it('waits retryAfterMs when given', async () => {
    const { d, calls } = deps([error('RATE_LIMIT', true, 300), text])
    await requestLlm(req(), d, signal)
    expect(calls.find((c) => c.op === 'delay')?.detail).toBe(300)
  })
  it('fails when attempts run out or the error is not retryable', async () => {
    expect(
      await requestLlm(req(), deps([error('TRANSPORT', true), error('TRANSPORT', true)]).d, signal),
    ).toMatchObject({ kind: 'failed', code: 'TRANSPORT', attempts: 2 })
    expect(await requestLlm(req(), deps([error('AUTH', false)]).d, signal)).toMatchObject({
      kind: 'failed',
      code: 'AUTH',
      attempts: 1,
    })
  })
  it('compacts on OVERFLOW and resends without the note', async () => {
    const { d, calls } = deps([error('OVERFLOW', false), text])
    expect(await requestLlm(req(), d, signal)).toMatchObject({ kind: 'reply', attempts: 2 })
    expect(calls.map((c) => c.op)).toEqual([
      'save',
      'prepare',
      'complete',
      'endStep',
      'compact',
      'save',
      'prepare',
      'complete',
    ])
  })
  it('compacts before the first send under the same id and keeps the note', async () => {
    const { d, calls } = deps([text], { shouldCompact: true })
    await requestLlm(req(), d, signal)
    expect(
      prepares(calls).map((p) => (p as { invocationId: string; tailNote?: unknown }).tailNote !== undefined),
    ).toEqual([true, true])
    expect(new Set(prepares(calls).map((p) => (p as { invocationId: string }).invocationId))).toEqual(
      new Set(['jev:1:0:m0']),
    )
  })
  it('returns the compaction outcome when compaction ends the turn', async () => {
    expect(
      await requestLlm(req(), deps([text], { shouldCompact: true, compaction: 'ended' }).d, signal),
    ).toEqual({ kind: 'outcome', outcome: { outcome: 'turn-ended', reason: 'budget' }, ids: [] })
  })
  it('recomputes toolNames once after E_ENVELOPE', async () => {
    const { d, calls } = deps([text], { envelopeOnce: true })
    expect(await requestLlm(req(), d, signal)).toMatchObject({ kind: 'reply', toolNames: ['read'] })
    expect(calls.some((c) => c.op === 'recompute')).toBe(true)
  })
  it('never sends the note when resuming from attempt 1', async () => {
    const { d, calls } = deps([text])
    await requestLlm(req({ firstAttempt: 1 }), d, signal)
    expect(prepares(calls)).toEqual([{ tools: ['ls', 'read'], invocationId: 'jev:1:0:m1' }])
  })
  it('reports an aborted reply', async () => {
    expect(
      await requestLlm(
        req(),
        deps([[{ type: 'error', reason: 'aborted', code: 'ABORTED', message: 'stop', retryable: false }]]).d,
        signal,
      ),
    ).toEqual({ kind: 'aborted', ids: ['jev:1:0:m0'] })
  })
})
