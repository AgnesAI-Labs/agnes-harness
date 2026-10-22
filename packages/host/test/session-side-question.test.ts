import { createEnvelopeCache, type Event } from '@agnes/core'
import type { InferenceEvent, RequestBody } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import type { HostSession } from '../src/runtime/lifecycle/host.js'
import { askSideQuestion } from '../src/runtime/sessions/session-side-question.js'

const text = (value: string) => ({ content: [{ type: 'text', text: value }] })

/** Rows 1-4 are a finished turn; row 5 opens turn 2, which `ended` closes. */
function fixture(o: { ended: boolean; cap?: number | null; infer?: () => AsyncGenerator<InferenceEvent> }) {
  const rows: Event[] = [
    { seq: 1, lane: 'main', type: 'turn/start', data: { turn: 1 } },
    { seq: 2, lane: 'main', type: 'user/message', data: text('first question'), trust: 'trusted' },
    { seq: 3, lane: 'main', type: 'assistant/message', data: text('first answer'), trust: 'trusted' },
    { seq: 4, lane: 'main', type: 'turn/end', data: { reason: 'completed' } },
    { seq: 5, lane: 'main', type: 'turn/start', data: { turn: 2 } },
    { seq: 6, lane: 'main', type: 'user/message', data: text('second in flight'), trust: 'trusted' },
    ...(o.ended ? [{ seq: 7, lane: 'main', type: 'turn/end', data: { reason: 'completed' } }] : []),
  ] as unknown as Event[]
  const surface = rows
    .filter((r) => r.type.endsWith('/message'))
    .map((event) => ({
      seq: event.seq,
      kind: event.type === 'user/message' ? 'user' : 'assistant',
      event,
      pinned: false,
    }))
  const calls: RequestBody[] = []
  const infer = vi.fn(
    o.infer ??
      async function* (): AsyncGenerator<InferenceEvent> {
        yield { type: 'text_delta', delta: 'The answer.' }
        yield {
          type: 'usage',
          tokens: { input: 9, output: 3, cacheRead: 0, cacheWrite: 0 },
          credits: 0.2,
          creditSource: 'gateway',
        }
        yield { type: 'done', reason: 'stop' }
      },
  )
  const billingRecord = vi.fn(async () => true)
  const session = {
    key: 'synthetic',
    lane: 'main',
    closingOrClosed: false,
    get lastSeq() {
      return rows.at(-1)?.seq ?? 0
    },
    preset: {
      model: { route: { primary: 'fake' }, id: { primary: 'm' } },
      budget: { perRequestCap: o.cap ?? null },
      treeBudgetCredits: null,
    },
    envelopeCache: createEnvelopeCache(),
    envelopeNonceFor: () => undefined,
    surface: () => surface,
    scan: async (q: {
      type?: string | string[]
      fromSeq?: number
      toSeq?: number
      order?: string
      limit?: number
    }) => {
      const hit = rows.filter(
        (r) =>
          [q.type].flat().includes(r.type) &&
          r.seq >= (q.fromSeq ?? 0) &&
          r.seq <= (q.toSeq ?? Number.MAX_SAFE_INTEGER),
      )
      return (q.order === 'desc' ? hit.reverse() : hit).slice(0, q.limit)
    },
    locked: async (fn: () => Promise<unknown>) => fn(),
    ev: (type: string, data: unknown) => ({ type, data }),
    append: async (events: Array<{ type: string; data: unknown }>) => {
      const firstSeq = rows.length + 1
      for (const e of events) rows.push({ seq: rows.length + 1, lane: 'main', ...e } as Event)
      return { firstSeq }
    },
    d: {
      contract: { contract_id: null, parser_version: '1' },
      provider: {
        models: () => [
          {
            route: 'fake',
            id: 'm',
            slot: 'primary',
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        infer: (request: RequestBody) => {
          calls.push(request)
          return infer()
        },
      },
      runtime: { billingProjected: async () => ({ credits: o.cap === undefined ? 0 : 5 }), billingRecord },
    },
  } as unknown as HostSession
  return { session, rows, calls, infer, billingRecord }
}

it('answers from the conversation before an open turn and records only a side-call cost row', async () => {
  for (const [ended, seen, hidden] of [
    [true, 'second in flight', undefined],
    [false, 'first answer', 'second in flight'],
  ] as const) {
    const f = fixture({ ended })
    const before = f.rows.length
    await expect(askSideQuestion(f.session, 'what now?')).resolves.toEqual({
      text: 'The answer.',
      model: 'm',
      credits: 0.2,
    })
    const sent = JSON.stringify(f.calls[0]?.messages)
    expect(sent).toContain(seen)
    expect(sent).toContain('what now?')
    if (hidden) expect(sent).not.toContain(hidden)
    const added = f.rows.slice(before)
    expect(added.map((r) => [r.type, (r.data as { purpose?: string }).purpose])).toEqual([
      ['cost/ledger', 'side-call'],
    ])
    expect(JSON.stringify(added)).not.toContain('what now?')
    expect(f.billingRecord).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'side-call', model: 'm' }),
    )
  }
})

it('refuses over the per-request cap without calling the provider, and a timeout after dispatch is still accounted', async () => {
  const over = fixture({ ended: true, cap: 1 })
  const before = over.rows.length
  await expect(askSideQuestion(over.session, 'q')).rejects.toMatchObject({ code: 'budget' })
  expect(over.infer).not.toHaveBeenCalled()
  expect(over.rows).toHaveLength(before)

  const slow = fixture({
    ended: true,
    infer: async function* () {
      await new Promise(() => undefined)
      yield { type: 'done', reason: 'stop' } as InferenceEvent
    },
  })
  const rowsBefore = slow.rows.length
  await expect(askSideQuestion(slow.session, 'q', { timeoutMs: 20 })).rejects.toMatchObject({
    code: 'timeout',
  })
  // The provider was called, so tokens may have been billed: one interrupted, estimated row.
  const added = slow.rows.slice(rowsBefore).map((r) => r.data as Record<string, unknown>)
  expect(added).toEqual([
    expect.objectContaining({ purpose: 'side-call', interrupted: true, creditSource: 'estimated' }),
  ])
  expect(slow.billingRecord).toHaveBeenCalledWith(expect.objectContaining({ interrupted: true }))
})
