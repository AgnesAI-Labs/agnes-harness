import type { Provider } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { withPhase } from '../src/step/op-state.js'
import { presetDefaults } from '../src/step/preset.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

type Counting = ReturnType<typeof fakeProvider> & { count: NonNullable<Provider['count']> }

const withCount = (tokens: number | 'unsupported' | 'throw'): Counting => {
  const p = fakeProvider([textTurn('ok')]) as Counting
  p.count = async (request) => {
    if (tokens === 'throw') throw new Error('count down')
    return tokens === 'unsupported'
      ? { source: 'unsupported' }
      : {
          tokens,
          source: 'provider',
          boundHash: request.derivedHash,
        }
  }
  return p
}
const preset = (cap: number | null, onExceed: 'quote' | 'deny' = 'deny') => ({
  ...presetDefaults(),
  budget: { preflight: 'count' as const, perRequestCap: cap, onExceed, maxSteps: 50 },
})

describe('count calibration', () => {
  it('writes budget.state.lastPreflight from provider.count in the same transaction as step/start', async () => {
    const { session, log } = await openSession({ provider: withCount(1234), preset: preset(null) })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(session.latest('budget.state')).toMatchObject({
      lastPreflight: {
        tokens: 1234,
        source: 'count',
        boundHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    })
    // The preflight already appended a budget.state BEFORE step/start on this turn, so indexOf finds
    // that one rather than the recount. Assert on the LAST budget.state and on its position relative
    // to the LAST step/start.
    const types = (await log.scan({ fromSeq: 1, limit: 50 })).map((e) => e.type)
    expect(types.lastIndexOf('budget.state')).toBe(types.lastIndexOf('step/start') + 1)
    // Two rows, in this order: the preflight's estimate, then the recount.
    const budgets = (await log.scan({ type: 'budget.state', limit: 10 })).map(
      (e) => (e.data as { lastPreflight?: { source: string } }).lastPreflight?.source,
    )
    expect(budgets).toEqual(['estimate', 'count'])
  })

  // The default path, which no other case in this file takes: presetDefaults() sets
  // preflight: 'estimate', so `preflight !== 'count'` is what every assembly that does not opt in
  // runs, and it was the one branch with no test.
  it('the default preset never calls provider.count and leaves the estimate in place', async () => {
    let calls = 0
    const p = withCount(1234)
    const orig = p.count
    p.count = (req, opts) => {
      calls++
      return orig(req, opts)
    }
    const { session } = await openSession({ provider: p, preset: presetDefaults() })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(calls).toBe(0)
    expect(session.latest('budget.state')).toMatchObject({ lastPreflight: { source: 'estimate' } })
  })

  it('a counted request over the cap is not sent: deny ends the turn with budget, quote asks', async () => {
    const seams = fakeSeams({
      ledger: {
        projected: async ({ tokensEstimate }) => ({ credits: tokensEstimate, creditSource: 'estimated' }),
      },
    })
    const d = await openSession({ provider: withCount(9000), preset: preset(4000), seams })
    await d.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await d.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'budget',
    )
    expect(await d.log.scan({ type: 'effect/intent', limit: 5 })).toHaveLength(0)
    // The count that refused the request is on the ledger beside the refusal, not lost with it.
    expect(
      (await d.log.scan({ type: 'budget.state', limit: 10 })).map(
        (e) => (e.data as { lastPreflight?: { source: string } }).lastPreflight?.source,
      ),
    ).toEqual(['estimate', 'count'])
    const quotedProvider = withCount(9000)
    const q = await openSession({ provider: quotedProvider, preset: preset(4000, 'quote'), seams })
    await q.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await q.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(quotedProvider.calls).toBe(1)
    expect(
      (await q.log.scan({ type: 'approval/asked', limit: 5 })).map((e) => (e.data as { kind: string }).kind),
    ).toEqual(['budget'])
  })

  it.each([
    { tokens: 9000, credits: 2, reason: 'completed' },
    { tokens: 2, credits: 9000, reason: 'budget' },
    { tokens: 9000, credits: 4000, reason: 'completed' },
  ])(
    'compares projected credits, not tokens: $tokens tokens / $credits credits',
    async ({ tokens, credits, reason }) => {
      const provider = withCount(tokens)
      const seen: Array<{ tokensEstimate: number; model: string }> = []
      const seams = fakeSeams({
        ledger: {
          projected: async (input) => {
            seen.push(input)
            return { credits: seen.length === 1 ? 1 : credits, creditSource: 'estimated' }
          },
        },
      })
      const selected = preset(4000)
      selected.model = { ...selected.model, id: { primary: 'priced-model' } }
      const { session } = await openSession({ provider, preset: selected, seams })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        reason,
      )
      // Unconstrained sessions skip tree-budget admission. Coarse estimate then provider-count
      // calibration; both projections stay on the selected model.
      expect(seen).toHaveLength(2)
      expect(seen[1]).toEqual({ tokensEstimate: tokens, model: 'priced-model' })
      expect(provider.calls).toBe(reason === 'completed' ? 1 : 0)
    },
  )

  it('fails closed when counted-request pricing fails after a successful estimate', async () => {
    let projections = 0
    const provider = withCount(2)
    const seams = fakeSeams({
      ledger: {
        projected: async () => {
          if (++projections > 1) throw new Error('pricing unavailable')
          return { credits: 1, creditSource: 'estimated' }
        },
      },
    })
    const { session } = await openSession({ provider, preset: preset(4000), seams })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'budget',
    )
    expect(provider.calls).toBe(0)
    // Coarse estimate, then the failing counted-request projection. No tree-budget admission.
    expect(projections).toBe(2)
    expect(session.latest('budget.state')).toMatchObject({ lastPreflight: { tokens: 2, source: 'count' } })
  })

  it('unsupported or failing count keeps the estimate and continues', async () => {
    for (const mode of ['unsupported', 'throw'] as const) {
      const { session, log } = await openSession({ provider: withCount(mode), preset: preset(null) })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      // The register is never undefined — the preflight populates it on every turn. What "kept the
      // estimate" means is that the recount did NOT overwrite the source.
      expect(session.latest('budget.state')).toMatchObject({ lastPreflight: { source: 'estimate' } })
      expect(await log.scan({ type: 'budget.state', limit: 10 })).toHaveLength(1)
      expect((await log.scan({ type: 'x/core/budget-recount', limit: 5 })).length).toBe(
        mode === 'throw' ? 1 : 0,
      )
    }
  })

  it('uses an explicit image fallback bound for count preflight and enforces the cap', async () => {
    const seams = fakeSeams({
      ledger: {
        projected: async ({ tokensEstimate }) => ({ credits: tokensEstimate, creditSource: 'estimated' }),
      },
    })
    const provider = withCount('unsupported')
    const { session } = await openSession({ provider, preset: preset(4000), seams })
    session.d.imageInputTokenFallback = async ({ imageCount }) => ({ tokens: 9000, imageCount })
    await session.enqueue('next-turn', {
      content: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }],
      actor,
    })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'budget',
    )
    expect(provider.calls).toBe(0)
    expect(session.latest('budget.state')).toMatchObject({
      lastPreflight: { tokens: 9000, source: 'estimate' },
    })
  })

  // quoteBudget's approvalAsk call fires the same approval_request hook as the tool-approval path in
  // tools.ts, the park path in gate.ts, and askUnknownOutcome in resume.ts — the design's ruling that
  // the hook describes "any request for human approval", not "only a tool approval". Unlike those two
  // sites, `asked.risk` here ('budget') is already a member of extension-api's ApprovalRequest risk
  // enum, so the hook must see 'budget' verbatim, not 'always' — the assertion on the raw seen request
  // is what would catch a copy-paste of the wrong risk mapping from gate.ts or resume.ts.
  it('fires approval_request from quoteBudget with risk "budget", and an override reaches the ledger', async () => {
    const seams = fakeSeams({
      ledger: {
        projected: async ({ tokensEstimate }) => ({ credits: tokensEstimate, creditSource: 'estimated' }),
      },
    })
    let seenRequest: unknown
    const { session, log } = await openSession({
      provider: withCount(9000),
      preset: preset(4000, 'quote'),
      seams,
    })
    session.hooks = {
      ...session.hooks,
      approvalRequest: async (p) => {
        seenRequest = p.request
        return { request: { summary: 'escalated by extension' } }
      },
    }
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(seenRequest).toMatchObject({
      tool: 'budget',
      argv: null,
      risk: 'budget',
      actor: expect.objectContaining({ id: 'u' }),
    })
    expect((await log.scan({ type: 'approval/asked', limit: 5 })).at(-1)?.data).toMatchObject({
      kind: 'budget',
      summary: 'escalated by extension',
    })
  })

  // The empty-register branch, walked rather than reasoned about. The preflight writes the cell
  // before every inference, so reaching the recount with an empty one means the counter is broken:
  // a `?? {…}` default would invent a budget row out of the preset and hide that. Getting here needs
  // an inference phase entered without a preflight, which is what the manual transition builds.
  it('a recount that finds no budget register says so and leaves the estimate alone', async () => {
    const { session, log } = await openSession({ provider: withCount(1234), preset: preset(null) })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect(await session.step()).toEqual({ phase: 'checkpoint' })
    const op = session.op()
    if (!op) throw new Error('the accepted turn left no program counter')
    await session.transition([], withPhase(op, { kind: 'inference', gen: { status: 'ready', attempt: 0 } }))
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(session.latest('budget.state')).toBeUndefined()
    expect(
      (await log.scan({ type: 'x/core/invariant', limit: 10 })).map((e) => (e.data as { kind: string }).kind),
    ).toEqual(['budget-register-missing'])
  })
})
