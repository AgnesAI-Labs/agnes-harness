import { canonicalJson, type EventInput, presetDefaults, type SessionImpl, sha256Hex } from '@agnes/core'
import type { DecisionBackend, LanguageBackend, PreparedModelCall } from '@agnes/jev-runtime'
import type { CountResult, RequestBody } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { JEV_COST_OUTBOX } from '../src/runtime/jev-cost.js'
import { createJevModelPolicy, type JevModelPolicyOptions } from '../src/runtime/jev-model-policy.js'

const signal = () => new AbortController().signal
const request: RequestBody = {
  kind: 'inference',
  sessionKey: 's',
  slot: 'primary',
  route: 'test',
  model: 'model',
  contractId: null,
  derivedHash: 'a'.repeat(64),
  system: 'Host instructions',
  tools: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'actual payload' }] }],
}
const decisionCall: PreparedModelCall = {
  purpose: 'decision',
  backend: 'jev',
  endpoint: 'https://decision.invalid',
  requestedModel: 'decision',
  codec: 'systemone-json-v1',
  input: { model: 'decision', state: {}, questions: {} },
  inputCursor: '1',
}
const languageCall: PreparedModelCall = {
  purpose: 'answer',
  backend: 'agnes-provider',
  endpoint: 'test',
  requestedModel: 'model',
  codec: 'agnes-language-v1',
  input: { request },
  inputCursor: '1',
}

function fixture(
  options: {
    count?: (body: RequestBody) => Promise<CountResult>
    countDecision?: boolean
    projectCost?: JevModelPolicyOptions['projectCost']
    request?: RequestBody
    languageCall?: PreparedModelCall
  } = {},
) {
  const preset = presetDefaults()
  const events: EventInput[] = []
  let cap: number | null = null
  let credits = 1
  let calls = 0
  let deliveryAvailable = true
  const projections: { tokensEstimate: number; model: string }[] = []
  const decision: DecisionBackend = {
    prepare: async () => structuredClone(decisionCall),
    invoke: async () => {
      calls++
      return { output: {} }
    },
  }
  const language: LanguageBackend = {
    maxFormatRetries: 1,
    prepare: async () =>
      structuredClone(
        options.languageCall ?? { ...languageCall, input: { request: options.request ?? request } },
      ),
    invoke: async () => {
      calls++
      return { output: {} }
    },
  }
  const session = {
    key: 's',
    get lastSeq() {
      return events.length
    },
    scan: async (query: { type: string[]; fromSeq?: number; toSeq?: number; limit?: number }) =>
      events
        .map((event, i) => ({ ...event, seq: i + 1, lane: 'main' }))
        .filter(
          (event) =>
            query.type.includes(event.type) &&
            event.seq >= (query.fromSeq ?? 1) &&
            event.seq <= (query.toSeq ?? events.length),
        )
        .slice(0, query.limit),
    preset,
    state: { creditsUsed: 2 },
    turnBudgetCap: () => cap,
    locked: async (fn: () => Promise<void>) => fn(),
    ev: (type: string, data: unknown, extra: object) => ({ type, data, ...extra }),
    d: {
      log: {
        storage: {},
        append: async (batch: EventInput[]) => {
          events.push(...batch)
        },
      },
      provider: { ...(options.count ? { count: options.count } : {}) },
      runtime: {
        ledgerRecord: async () => deliveryAvailable,
        ledgerProjected: async (input: { tokensEstimate: number; model: string }) => {
          projections.push(input)
          return { credits, creditSource: 'estimated' }
        },
      },
    },
  } as unknown as SessionImpl
  const policy = createJevModelPolicy({
    session,
    decision,
    language,
    ...(options.projectCost ? { projectCost: options.projectCost } : {}),
    ...(options.countDecision
      ? {
          countDecision: async (call: PreparedModelCall) => ({
            tokens: 21,
            boundHash: sha256Hex(canonicalJson(call.input)),
          }),
        }
      : {}),
  })
  return {
    ...policy,
    preset,
    events,
    projections,
    calls: () => calls,
    deliveryAvailable: (value: boolean) => {
      deliveryAvailable = value
    },
    queueCost: () => {
      const costSeq = events.length + 1,
        effectId = `pending-${costSeq}`
      events.push({
        type: 'cost/ledger',
        data: {
          purpose: 'inference',
          model: 'model',
          effectId,
          credits: 1,
          creditSource: 'estimated',
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      } as unknown as EventInput)
      events.push({
        type: JEV_COST_OUTBOX,
        data: { effectId, costSeq, turn: 1, step: 1 },
      } as unknown as EventInput)
    },
    cap: (next: number | null) => {
      cap = next
    },
    credits: (next: number) => {
      credits = next
    },
  }
}

describe('Jev prepared model spending policy', () => {
  it.each(['absent', 'unsupported'] as const)(
    'keeps media pricing unknown with an %s counter, admits uncapped work and rechecks new caps',
    async (counter) => {
      const media: RequestBody = {
        ...request,
        messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'aQ==' }] }],
      }
      const h = fixture({
        request: media,
        ...(counter === 'unsupported' ? { count: async () => ({ source: 'unsupported' as const }) } : {}),
      })
      const first = await h.language.prepare({} as never, signal())
      expect(h.events).toMatchObject([{ type: 'budget.state', data: { creditsCap: null } }])
      expect(h.events[0]!.data).not.toHaveProperty('lastPreflight')
      await h.language.invoke(first, signal())
      expect(h.calls()).toBe(1)
      expect(h.projections).toEqual([])
      const second = await h.language.prepare({} as never, signal())
      h.cap(10)
      await expect(h.language.invoke(second, signal())).rejects.toThrow('supported counter')
      await expect(h.language.prepare({} as never, signal())).rejects.toThrow('supported counter')
      h.cap(null)
      h.preset.budget.preflight = 'count'
      await expect(h.language.prepare({} as never, signal())).rejects.toThrow('cannot count')
      expect(h.calls()).toBe(1)
      expect(h.projections).toEqual([])
    },
  )

  it('uses a request-bound media counter in estimate mode and refuses a mismatched receipt', async () => {
    const media: RequestBody = {
      ...request,
      messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'aQ==' }] }],
    }
    let mismatch = false
    const h = fixture({
      request: media,
      count: async (body) => {
        expect(body).toEqual(media)
        return { source: 'provider', tokens: 42, boundHash: mismatch ? 'b'.repeat(64) : body.derivedHash }
      },
    })
    h.cap(10)
    const call = await h.language.prepare({} as never, signal())
    await h.language.invoke(call, signal())
    expect(h.events[0]!.data).toMatchObject({ lastPreflight: { tokens: 42, source: 'count' } })
    expect(h.projections.every((value) => value.tokensEstimate === 42)).toBe(true)
    mismatch = true
    await expect(h.language.prepare({} as never, signal())).rejects.toThrow('not bound')
    expect(h.calls()).toBe(1)
  })

  it('blocks preparation and invocation while durable usage is undelivered', async () => {
    const h = fixture()
    h.queueCost()
    h.deliveryAvailable(false)
    await expect(h.decision.prepare({} as never, signal())).rejects.toThrow('pending Jev cost delivery')
    expect(h.projections).toHaveLength(0)
    h.deliveryAvailable(true)
    const call = await h.decision.prepare({} as never, signal())
    h.queueCost()
    h.deliveryAvailable(false)
    await expect(h.decision.invoke(call, signal())).rejects.toThrow('pending Jev cost delivery')
    expect(h.calls()).toBe(0)
  })

  it('accepts an explicit request-bound cost upper limit and falls back only when absent', async () => {
    const quoted: PreparedModelCall[] = []
    const h = fixture({
      projectCost: async (call, tokens) => {
        expect(tokens).toBeGreaterThan(0)
        quoted.push(call)
        return call.purpose === 'decision' ? { credits: 2, creditSource: 'estimated' } : undefined
      },
    })
    h.cap(10)
    h.credits(0)
    const call = await h.decision.prepare({} as never, signal())
    await h.decision.invoke(call, signal())
    expect(quoted).toEqual([call, call])
    expect(h.projections).toHaveLength(0)
    await expect(h.language.prepare({} as never, signal())).rejects.toThrow('price is unknown')
    expect(h.projections).toHaveLength(1)
    expect(h.events.every((event) => event.type !== 'cost/ledger')).toBe(true)
    const zero = fixture({ projectCost: async () => ({ credits: 0, creditSource: 'estimated' }) })
    zero.cap(10)
    await expect(zero.decision.prepare({} as never, signal())).rejects.toThrow('price is unknown')
  })

  it.each(['agnes-language-v1', 'agnes-language-v2'])(
    'prices %s, records its bound preflight and consumes admission once',
    async (codec) => {
      const h = fixture({
        languageCall:
          codec === 'agnes-language-v1'
            ? languageCall
            : {
                ...languageCall,
                codec,
                endpoint: 'https://provider.invalid/v1',
                input: {
                  request,
                  providerRequest: {
                    codec: 'agnes-provider-request-v1',
                    request,
                    endpoint: 'https://provider.invalid/v1',
                  },
                },
              },
      })
      const call = await h.language.prepare({} as never, signal())
      expect(h.projections).toMatchObject([{ model: 'model', tokensEstimate: expect.any(Number) }])
      expect(h.events).toMatchObject([
        {
          type: 'budget.state',
          data: { creditsUsed: 2, lastPreflight: { source: 'estimate', boundHash: request.derivedHash } },
        },
      ])
      await h.language.invoke(call, signal())
      await expect(h.language.invoke(call, signal())).rejects.toThrow('not admitted')
      expect(h.calls()).toBe(1)
    },
  )

  it('counts the exact provider wire and refuses incorrect count receipts or missing decision counters', async () => {
    let counted: RequestBody | undefined
    const h = fixture({
      count: async (body) => {
        counted = body
        return { source: 'provider', tokens: 42, boundHash: body.derivedHash }
      },
    })
    h.preset.budget.preflight = 'count'
    await h.language.prepare({} as never, signal())
    expect(counted).toEqual(request)
    expect(h.projections[0]?.tokensEstimate).toBe(42)
    await expect(h.decision.prepare({} as never, signal())).rejects.toThrow('Decision transport cannot count')
    const wrong = fixture({
      count: async () => ({ source: 'provider', tokens: 42, boundHash: 'b'.repeat(64) }),
    })
    wrong.preset.budget.preflight = 'count'
    await expect(wrong.language.prepare({} as never, signal())).rejects.toThrow('not bound')
    expect(wrong.calls()).toBe(0)
  })

  it('refuses missing prices under a cap, an exceeded quote cap, and tree requests without reservations', async () => {
    const h = fixture()
    h.cap(10)
    h.credits(0)
    await expect(h.decision.prepare({} as never, signal())).rejects.toThrow('price is unknown')
    h.credits(11)
    h.preset.budget.onExceed = 'quote'
    await expect(h.language.prepare({} as never, signal())).rejects.toThrow('quote approval is unavailable')
    h.cap(null)
    h.preset.treeBudgetCredits = 100
    await expect(h.decision.prepare({} as never, signal())).rejects.toThrow('tree-budget reservation')
    expect(h.calls()).toBe(0)
    expect(h.events).toEqual([])
  })

  it('rechecks cap changes before invoke and rejects changed or cross-backend prepared calls', async () => {
    const h = fixture()
    const call = await h.decision.prepare({} as never, signal())
    h.cap(0.5)
    await expect(h.decision.invoke(call, signal())).rejects.toThrow('exceeds its cap')
    h.cap(null)
    const changed = await h.language.prepare({} as never, signal())
    ;(changed as { input: unknown }).input = { different: true }
    await expect(h.language.invoke(changed, signal())).rejects.toThrow('changed after admission')
    const decision = await h.decision.prepare({} as never, signal())
    await expect(h.language.invoke(decision, signal())).rejects.toThrow('not admitted')
    expect(h.calls()).toBe(0)
  })
})
