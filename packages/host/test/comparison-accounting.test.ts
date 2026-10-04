import { readFileSync } from 'node:fs'
import type { EventEnvelope, JsonValue, RequestBody, RuntimeIdentity } from '@agnes/protocol'
import { type AttemptEvidence, accountLane } from '@agnes/runtime-comparison'
import { describe, expect, it } from 'vitest'
import {
  accountComparisonLane,
  type ComparisonAccountingInput,
  projectComparisonAttemptEvidence,
} from '../src/runtime/comparison-accounting.js'
import { accountingOwnerKey, projectComparisonModelCalls } from '../src/runtime/comparison-model-calls.js'
import { projectComparisonPriceDetails } from '../src/runtime/comparison-price-details.js'
import { aggregateComparisonTreeAccounting } from '../src/runtime/comparison-tree-accounting.js'

// Sanitized real provider captures. These assert projection/accounting, not a runtime replay.
const cancel = JSON.parse(
  readFileSync(new URL('../../core/test/fixtures/comparison-real-cancel.json', import.meta.url), 'utf8'),
) as { reports: { events: EventEnvelope[] }[] }
const trace = JSON.parse(
  readFileSync(new URL('../../core/test/fixtures/jev-real-trace.json', import.meta.url), 'utf8'),
) as { events: EventEnvelope[] }
const modern = JSON.parse(
  readFileSync(new URL('../../core/test/fixtures/comparison-real-accounting.json', import.meta.url), 'utf8'),
) as { reports: { events: EventEnvelope[] }[] }
const priced = JSON.parse(
  readFileSync(new URL('../../core/test/fixtures/comparison-real-pricing.json', import.meta.url), 'utf8'),
) as { reports: { events: EventEnvelope[] }[] }
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing captured evidence')
  return value
}
const native = required(cancel.reports[0]).events
const jevCancel = required(cancel.reports[1]).events
function input(
  events: EventEnvelope[],
  changes: Partial<ComparisonAccountingInput> = {},
): ComparisonAccountingInput {
  const session = required(events[0]).data as unknown as { key: string; runtime: RuntimeIdentity }
  return {
    sessionId: session.key,
    runtime: session.runtime,
    events,
    afterSeq: 0,
    throughSeq: Math.max(...events.map((row) => row.seq)),
    ...changes,
  }
}
function change(events: EventEnvelope[], seq: number, data: unknown): EventEnvelope[] {
  return events.map((row) => (row.seq === seq ? { ...row, data: data as JsonValue } : row))
}
const recordData = (events: EventEnvelope[], seq: number) =>
  structuredClone(required(events.find((row) => row.seq === seq)).data) as unknown as {
    runtime: RuntimeIdentity
    record: {
      id: string
      attempt: string
      turn: string
      step: string
      requested: string
      settlement: { usage: { tokens: Record<string, number>; creditSource: string } }
    }
  }

describe('Host durable comparison accounting', () => {
  it('binds v2 historical language prices to the persisted provider route, not its HTTP endpoint', () => {
    const source = input(structuredClone(required(priced.reports[1]).events))
    const original = accountComparisonLane(source)
    for (const row of source.events) {
      const data = row.data as unknown as {
        record?: {
          kind: string
          call?: { codec: string; endpoint: string; requestedModel: string; input: JsonValue }
        }
      }
      const call = data.record?.kind === 'model.requested' ? data.record.call : undefined
      if (call?.codec !== 'agnes-language-v1') continue
      const request: RequestBody = {
        kind: 'inference',
        sessionKey: source.sessionId,
        slot: 'primary',
        route: call.endpoint,
        model: call.requestedModel,
        contractId: null,
        system: 'Sanitized test policy.',
        messages: [],
        tools: [],
        derivedHash: 'a'.repeat(64),
      }
      call.codec = 'agnes-language-v2'
      call.endpoint = 'https://gateway.example.test/v1'
      call.input = {
        ...(call.input as Record<string, JsonValue>),
        request: request as unknown as JsonValue,
        providerRequest: {
          codec: 'agnes-provider-request-v1',
          endpoint: call.endpoint,
          request: { ...request, system: 'Actual contract policy.' } as unknown as JsonValue,
        },
      }
    }
    const result = accountComparisonLane(source)
    expect(result.llm.costs).toEqual(original.llm.costs)
    expect(result.llm.tokens).toEqual(original.llm.tokens)
    expect(result.llm.unpricedAttempts).toBe(0)
    expect(result.llm.reportedBilling).toEqual(original.llm.reportedBilling)
    expect(result.jev.unpricedAttempts).toBe(0)
    expect(result.jev.currentPriceAttempts).toBe(result.jev.attempts)
    const details = projectComparisonPriceDetails(source)
    expect(
      details.entries.filter((entry) => entry.family === 'llm').every((entry) => entry.issues.length === 0),
    ).toBe(true)
    const requested = required(
      source.events.find((row) => {
        const data = row.data as unknown as { record?: { call?: { codec?: string } } }
        return data.record?.call?.codec === 'agnes-language-v2'
      }),
    )
    for (const kind of ['session', 'model', 'endpoint', 'effective', 'quote', 'missing-request'] as const) {
      const events = structuredClone(source.events)
      const row = required(events.find((event) => event.seq === requested.seq))
      const call = (
        row.data as unknown as {
          record: {
            call: {
              endpoint: string
              input: {
                request?: RequestBody
                providerRequest: { request: RequestBody; endpoint: string }
                pricing: { route: string }
              }
            }
          }
        }
      ).record.call
      if (kind === 'session') required(call.input.request).sessionKey = 'different-session'
      if (kind === 'model') required(call.input.request).model = 'different-model'
      if (kind === 'endpoint') call.input.providerRequest.endpoint = 'https://other.example.test/v1'
      if (kind === 'effective') call.input.providerRequest.request.route = 'different-route'
      if (kind === 'quote') call.input.pricing.route = 'different-route'
      if (kind === 'missing-request') delete call.input.request
      const changed = projectComparisonPriceDetails({ ...source, events })
      const detail = required(changed.entries.find((entry) => entry.originSeq === requested.seq))
      expect(detail.estimate.state).toBe('unknown')
      expect(detail.issues).toContain('quote_binding_mismatch')
      expect(detail.tokens.output.value).toBeGreaterThan(0)
    }
  })

  it('explains real frozen Flash quotes per canonical call, estimating Jev total input with explicit current provenance and separate billing', () => {
    for (const report of priced.reports) {
      const source = input(report.events)
      const detail = projectComparisonPriceDetails(source)
      const aggregate = accountComparisonLane(source)
      expect(detail.evidenceComplete).toBe(true)
      expect(detail.entries.filter((entry) => entry.family === 'llm')).toHaveLength(4)
      const sum = detail.entries
        .filter((entry) => entry.family === 'llm')
        .reduce((sum, entry) => {
          expect(entry.quote?.basis).toBe('catalog-estimate')
          expect(entry.quote?.model).toBe(entry.model)
          expect(entry.multiplier).toBe(1)
          expect(entry.estimate.state).toBe('complete')
          expect(entry.issues).toEqual([])
          const bucketSum = Object.values(entry.bucketCosts).reduce((n, total) => n + (total.value ?? 0), 0)
          expect(bucketSum).toBeCloseTo(required(entry.estimate.value ?? undefined), 12)
          expect(entry.reportedBilling?.source).toBe('estimated')
          return sum + required(entry.estimate.value ?? undefined)
        }, 0)
      expect(sum).toBeCloseTo(required(required(aggregate.llm.costs.USD).value ?? undefined), 12)
      expect(aggregate.llm.priceMultipliers).toEqual([1])
      expect(
        Object.values(aggregate.llm.bucketCosts?.USD ?? {}).reduce(
          (n, bucket) => n + (bucket?.value ?? 0),
          0,
        ),
      ).toBeCloseTo(sum, 12)
      expect(aggregate.totalCosts?.USD?.value).toBeCloseTo(sum + (aggregate.jev.costs.USD?.value ?? 0), 12)
      for (const entry of detail.entries.filter((entry) => entry.family === 'jev')) {
        expect(entry.quote?.policy.perMillion.inputUncached).toBe(0.042)
        expect(entry.priceBasis).toBe('current')
        expect(entry.estimate.state).toBe('complete')
        expect(entry.estimate.value).toBeCloseTo(((entry.tokens.inputTotal?.value ?? 0) * 0.042) / 1e6, 12)
        expect(entry.bucketCosts.inputTotal?.value).toBe(entry.estimate.value)
        expect(entry.bucketCosts.output.value).toBe(0)
        expect(entry.tokens.inputUncached.state).toBe('unknown')
        expect(required(entry.tokens.inputTotal).state).toBe('complete')
        expect(required(entry.tokens.inputTotal).value).toBeGreaterThan(0)
        expect(entry.tokens.cacheRead.state).toBe('unknown')
        expect(required(entry.tokens.total).value).toBe(
          (required(entry.tokens.inputTotal).value ?? 0) + (entry.tokens.output.value ?? 0),
        )
        expect(entry.issues).toEqual([])
      }
      const decisions = detail.entries.filter((entry) => entry.family === 'jev')
      if (decisions.length) {
        const first = required(decisions[0])
        const frozen = structuredClone(source.events)
        const event = required(frozen.find((row) => row.seq === first.originSeq))
        const call = (event.data as unknown as { record: { call: Record<string, unknown> } }).record.call
        call.pricing = first.quote
        const recorded = required(
          projectComparisonPriceDetails({ ...source, events: frozen }).entries.find(
            (e) => e.originSeq === first.originSeq,
          ),
        )
        expect(recorded.priceBasis).toBe('recorded')
        expect(recorded.estimate).toEqual(first.estimate)
        const snapshot = JSON.stringify(frozen)
        const tree = aggregateComparisonTreeAccounting(
          [accountComparisonLane({ ...source, events: frozen })],
          source.throughSeq,
          true,
        )
        expect(tree.jev.currentPriceAttempts).toBe(decisions.length - 1)
        expect(tree.jev.priceMultipliers).toEqual([1])
        expect(tree.jev.bucketCosts?.USD?.inputTotal?.value).toBe(tree.jev.costs.USD?.value)
        expect(tree.jev.bucketCosts?.USD?.cacheRead).toBeUndefined()
        expect(JSON.stringify(frozen)).toBe(snapshot)
        call.pricing = { broken: true }
        const refused = required(
          projectComparisonPriceDetails({ ...source, events: frozen }).entries.find(
            (e) => e.originSeq === first.originSeq,
          ),
        )
        expect(refused.estimate.state).toBe('unknown')
        expect(refused.quote).toBeNull()
        expect(refused.tokens.inputTotal?.value).toBe(first.tokens.inputTotal?.value)
        delete call.pricing
        call.endpoint = 'https://other.example.test/systemone'
        expect(
          required(
            projectComparisonPriceDetails({ ...source, events: frozen }).entries.find(
              (e) => e.originSeq === first.originSeq,
            ),
          ).estimate.state,
        ).toBe('unknown')
      }
      expect(JSON.stringify(detail)).not.toMatch(
        /"(input|output|reasoning)":\s*"|"(content|messages|questions|response)":/,
      )
    }
  })

  it('fixes pending and incomplete prefixes and refuses mismatched quotes without losing real usage', () => {
    const source = input(required(priced.reports[0]).events)
    const first = required(projectComparisonPriceDetails(source).entries[0])
    const pending = required(
      projectComparisonPriceDetails({ ...source, throughSeq: first.originSeq }).entries[0],
    )
    expect(pending.outcome).toBe('pending')
    expect(pending.settledSeq).toBeNull()
    expect(pending.quote).toEqual(first.quote)
    expect(pending.estimate.state).toBe('unknown')
    const incomplete = projectComparisonPriceDetails({ ...source, complete: false })
    expect(incomplete.evidenceComplete).toBe(false)
    expect(incomplete.entries.every((entry) => entry.estimate.value === null)).toBe(true)
    const events = structuredClone(source.events)
    const settlement = required(events.find((row) => row.seq === first.settledSeq))
    ;(settlement.data as unknown as { observedModel: string }).observedModel = 'different-real-model'
    const mismatch = required(projectComparisonPriceDetails({ ...source, events }).entries[0])
    expect(mismatch.tokens.output.value).toBe(first.tokens.output.value)
    expect(mismatch.quote).toEqual(first.quote)
    expect(mismatch.estimate.state).toBe('unknown')
    expect(mismatch.issues).toContain('observed_model_mismatch')
    const conflicting = projectComparisonPriceDetails({
      ...source,
      events: [
        ...events,
        { ...settlement, data: required(source.events.find((row) => row.seq === settlement.seq)).data },
      ],
    })
    expect(conflicting.evidenceComplete).toBe(false)
    expect(conflicting.entries[0]?.quote).toBeNull()
    for (const kind of ['expired', 'missing-rate', 'binding'] as const) {
      const changed = structuredClone(source.events)
      for (const row of changed.filter(
        (row) => row.seq === first.originSeq || row.seq === first.settledSeq,
      )) {
        const call = row.data as unknown as { pricing: NonNullable<typeof first.quote> }
        if (kind === 'expired') call.pricing.policy.validUntil = call.pricing.admittedAt
        if (kind === 'missing-rate') delete call.pricing.policy.perMillion.inputUncached
        if (kind === 'binding') call.pricing.route = 'other-route'
      }
      const projected = projectComparisonPriceDetails({ ...source, events: changed })
      const detail = required(projected.entries[0])
      if (kind === 'binding') {
        // Native readModelCall rejects the entire contradictory attribution before quote projection.
        expect(projected.evidenceComplete).toBe(false)
        expect(projected.issues).toContain('invalid_model_call_record')
        expect(detail.quote).toBeNull()
        expect(detail.estimate.value).toBeNull()
        continue
      }
      expect(detail.quote).not.toBeNull()
      expect(detail.tokens.output.value).toBe(first.tokens.output.value)
      expect(detail.issues).toContain(kind === 'expired' ? 'invalid_price_interval' : 'missing_rate')
      if (kind === 'missing-rate') {
        expect(detail.estimate.state).toBe('partial')
        expect(detail.bucketCosts.inputUncached.state).toBe('unknown')
        expect(detail.bucketCosts.output.value).toBe(first.bucketCosts.output.value)
      } else expect(detail.estimate.state).toBe('unknown')
    }
  })

  it('projects admitted quote estimates from real Native and language usage without replacing reported billing', () => {
    // Actual frozen catalog quotes from three browser-submitted rounds. No price is
    // injected into these records; reported integer micros keep their own rounding.
    for (const [side, usd, micros] of [
      [0, 0.003294528, 3295],
      [1, 0.003516618, 3516],
    ] as const) {
      const captured = accountComparisonLane(input(required(priced.reports[side]).events))
      expect(captured.issues).toEqual([])
      expect(captured.llm.attempts).toBe(4)
      expect(captured.llm.unpricedAttempts).toBe(0)
      expect(captured.llm.costs.USD).toMatchObject({ state: 'complete', value: usd, missing: 0 })
      expect(captured.llm.reportedBilling.estimated.usdMicros.value).toBe(micros)
      expect(captured.llm.reportedBilling.gateway.attempts).toBe(0)
      if (side === 0) expect(captured.jev.costs).toEqual({})
      else expect(captured.jev.costs.USD).toMatchObject({ state: 'complete', value: 0.001627332, missing: 0 })
      expect(captured.jev.unpricedAttempts).toBe(0)
      expect(captured.jev.currentPriceAttempts).toBe(side === 0 ? 0 : 3)
    }
    const events = structuredClone(required(modern.reports[0]).events)
    const start = required(
      events.find(
        (row) => row.type === 'x/core/model-call' && (row.data as { stage?: string }).stage === 'started',
      ),
    )
    const data = start.data as unknown as { id: string; route: string; model: string; pricing?: unknown }
    const settled = required(
      events.find(
        (row) =>
          row.type === 'x/core/model-call' &&
          (row.data as { stage?: string; id?: string }).stage === 'settled' &&
          (row.data as { id?: string }).id === data.id,
      ),
    )
    // The real usage is unchanged; the configured CNY policy is controlled contract-test input.
    const pricing = {
      version: 1,
      basis: 'configured',
      route: data.route,
      model: data.model,
      admittedAt: Date.parse(start.ts),
      policy: {
        currency: 'CNY',
        unit: 'per-million-tokens',
        perMillion: { inputUncached: 1, cacheRead: 1, cacheWrite: 1, output: 1 },
      },
    }
    Object.assign(start.data as object, { pricing })
    Object.assign(settled.data as object, { pricing })
    const before = accountComparisonLane(input(events, { throughSeq: settled.seq - 1 }))
    expect(before.llm.costs).toEqual({})
    const after = accountComparisonLane(input(events, { throughSeq: settled.seq }))
    expect(after.llm.costs.CNY?.knownSubtotal).toBeGreaterThan(0)
    expect(after.llm.reportedBilling.estimated.attempts).toBe(1)
    Object.assign(settled.data as object, { observedModel: 'different-model' })
    const mismatch = accountComparisonLane(input(events, { throughSeq: settled.seq }))
    expect(mismatch.llm.costs).toEqual({})
    expect(mismatch.llm.tokens.output.knownSubtotal).toBeGreaterThan(0)

    const language = structuredClone(trace.events)
    const requested = required(
      language.find(
        (row) =>
          (row.data as { record?: { kind?: string; call?: { codec?: string } } }).record?.kind ===
            'model.requested' &&
          (row.data as { record?: { call?: { codec?: string } } }).record?.call?.codec ===
            'agnes-language-v1',
      ),
    )
    const record = (
      requested.data as unknown as {
        record: { call: { endpoint: string; requestedModel: string; input: object } }
      }
    ).record
    Object.assign(record.call.input, {
      pricing: {
        ...pricing,
        route: record.call.endpoint,
        model: record.call.requestedModel,
        admittedAt: Date.parse(requested.ts),
      },
    })
    const result = accountComparisonLane(input(language))
    expect(result.llm.costs.CNY?.knownSubtotal).toBeGreaterThan(0)
    expect(result.llm.reportedBilling.estimated.usdMicros.value).toBe(2667)
    expect(result.jev.costs.USD?.state).toBe('complete')
    expect(result.jev.currentPriceAttempts).toBe(4)
  })

  it.each([
    { side: 0, calls: 9, jev: 0 },
    { side: 1, calls: 3, jev: 2 },
  ])(
    'counts real inference, title and parallel compaction calls once on side $side',
    ({ side, calls, jev }) => {
      const events = required(modern.reports[side]).events
      const result = accountComparisonLane(input(events))
      expect(result.issues).toEqual([])
      expect(result.llm.attempts).toBe(calls)
      expect(result.llm.outcomes.completed).toBe(calls)
      expect(result.llm.byPurpose.title?.attempts).toBe(1)
      expect(result.jev.attempts).toBe(jev)
      expect(result.llm.reportedBilling.estimated.attempts).toBe(calls)
      expect(result.llm.reportedBilling.gateway.attempts).toBe(0)
      if (side !== 0) return
      expect(result.llm.byPurpose.compaction?.attempts).toBe(3)
      const partial = accountComparisonLane(input(events, { throughSeq: 107 }))
      expect(partial.llm.byPurpose.compaction).toMatchObject({ attempts: 2, outcomes: { pending: 2 } })
      expect(partial.llm.reportedBilling.missingAttempts).toBe(2)
      const costs = events.filter(
        (row) => row.type === 'cost/ledger' && (row.data as { purpose?: string }).purpose === 'compaction',
      )
      expect(costs).toHaveLength(3)
      const starts = events.filter(
        (row) =>
          row.type === 'x/core/model-call' &&
          (row.data as { stage?: string; purpose?: string }).stage === 'started' &&
          (row.data as { purpose?: string }).purpose === 'compaction',
      )
      expect(new Set(starts.map((row) => (row.data as { parentEffectId: string }).parentEffectId)).size).toBe(
        2,
      )
      expect(costs.map((row) => (row.data as { effectId: string }).effectId).sort()).toEqual(
        starts.map((row) => (row.data as { id: string }).id).sort(),
      )
    },
  )

  it.each(['duplicate-settlement', 'duplicate-origin', 'wrong-purpose'] as const)(
    'keeps canonical ownership conservative for %s in the real capture',
    (kind) => {
      const events = structuredClone(required(modern.reports[0]).events)
      const started = required(events.find((row) => row.seq === 16))
      const settled = required(events.find((row) => row.seq === 20))
      const origin = started.data as { id: string; parentEffectId: string; purpose: string }
      const foreign = 'unrelated-legacy-owner'
      if (kind === 'duplicate-settlement') events.push({ ...settled, seq: 151 })
      if (kind === 'duplicate-origin')
        events.push({ ...started, seq: 151, data: { ...origin, parentEffectId: foreign } as JsonValue })
      if (kind === 'wrong-purpose') {
        origin.purpose = 'title'
        ;(settled.data as { purpose: string }).purpose = 'title'
      }
      const calls = projectComparisonModelCalls(events, new Set())
      expect(calls.issues.length).toBeGreaterThan(0)
      expect(calls.parents.has(accountingOwnerKey(started.lane, foreign))).toBe(false)
      expect(calls.parents.has(accountingOwnerKey(started.lane, origin.parentEffectId))).toBe(
        kind !== 'wrong-purpose',
      )
      const evidence = required(calls.events.find((row) => row.originSeq === 16 && row.stage === 'settled'))
      expect(evidence).toMatchObject({ usage: null, billing: null, outcome: 'unknown' })
      if (kind !== 'wrong-purpose') expect(accountComparisonLane(input(events)).llm.attempts).toBe(9)
    },
  )

  it('counts the real cancelled Native dispatch without billing Core fallback token estimates', () => {
    const projected = projectComparisonAttemptEvidence(input(native))
    expect(projected.complete).toBe(true)
    expect(projected.events).toMatchObject([
      { seq: 15, originSeq: 15, family: 'llm', stage: 'started' },
      { seq: 21, originSeq: 15, family: 'llm', stage: 'settled', usage: null, pricing: null },
    ])
    const result = accountComparisonLane(input(native))
    expect(result.llm.attempts).toBe(1)
    expect(result.jev.attempts).toBe(0)
    expect(result.llm.tokens.output).toMatchObject({ state: 'unknown', value: null, knownSubtotal: null })
    expect(result.llm.unpricedAttempts).toBe(1)
    expect(result.llm.outcomes.cancelled).toBe(1)
    expect(result.llm.reportedBilling.missingAttempts).toBe(1)
    expect(result.state).toBe('unknown')
    expect(accountComparisonLane(input(native, { throughSeq: 19 })).llm.attempts).toBe(1)
  })

  it('separates the real Jev cancellation decision and language usage, ignoring the Host cost duplicate', () => {
    const projected = projectComparisonAttemptEvidence(input(jevCancel))
    expect(projected.complete).toBe(true)
    expect(projected.events.filter((event) => event.stage === 'started')).toHaveLength(2)
    const result = accountComparisonLane(input(jevCancel))
    expect(result.jev.attempts).toBe(1)
    expect(result.llm.attempts).toBe(1)
    expect(result.jev.tokens.inputUncached).toMatchObject({ state: 'unknown', knownSubtotal: null })
    expect(result.jev.tokens.cacheRead).toMatchObject({ state: 'unknown', knownSubtotal: null })
    expect(result.llm.tokens.inputUncached.value).toBe(1389)
    expect(result.llm.tokens.cacheRead.value).toBe(8192)
    expect(result.llm.tokens.output.value).toBe(1206)
    expect(result.llm.tokens.reasoning.value).toBe(77)
    expect(result.llm.costs).toEqual({})
    expect(result.llm.tokens.inputTotal.value).toBe(1389 + 8192)
    expect(result.llm.unpricedAttempts).toBe(1)
    expect(result.state).toBe('partial')
  })

  it('accounts all eight actual trace model attempts once, keeping reported billing separate from historical rates', () => {
    const result = accountComparisonLane(input(trace.events))
    expect(result.issues).toEqual([])
    expect(result.jev.attempts).toBe(4)
    expect(result.llm.attempts).toBe(4)
    expect(result.jev.tokens.inputUncached).toMatchObject({ state: 'unknown', knownSubtotal: null })
    expect(result.jev.tokens.output.value).toBe(3340)
    expect(result.jev.tokens.cacheWrite.value).toBeNull()
    expect(result.llm.tokens.inputUncached.value).toBe(13753)
    expect(result.llm.tokens.output.value).toBe(883)
    expect(result.llm.tokens.cacheRead.value).toBe(24576)
    expect(result.llm.tokens.cacheWrite.value).toBe(0)
    expect(result.llm.tokens.reasoning.value).toBe(511)
    expect(result.llm.unpricedAttempts).toBe(4)
    expect(result.jev.unpricedAttempts).toBe(0)
    expect(result.jev.currentPriceAttempts).toBe(4)
    expect(result.jev.costs.USD?.value).toBeCloseTo(
      ((result.jev.tokens.inputTotal.value ?? 0) * 0.042) / 1e6,
      12,
    )
    expect(result.llm.costs).toEqual({})
    expect(result.llm.outcomes.completed).toBe(4)
    expect(result.llm.byPurpose.parameters?.attempts).toBe(3)
    expect(result.llm.byPurpose.answer?.attempts).toBe(1)
    expect(result.llm.reportedBilling.estimated).toMatchObject({
      attempts: 4,
      usdMicros: { state: 'complete', value: 2667 },
      subscriptionAttempts: 0,
    })
    expect(result.llm.reportedBilling.gateway.attempts).toBe(0)
    expect(result.llm.reportedBilling.missingAttempts).toBe(0)
  })

  it('fixes throughSeq and excludes attempts inherited across afterSeq even when they settle inside the window', () => {
    const result = accountComparisonLane(input(trace.events, { afterSeq: 22, throughSeq: 88 }))
    expect(result.afterSeq).toBe(22)
    expect(result.throughSeq).toBe(88)
    expect(result.jev.attempts).toBe(3)
    expect(result.llm.attempts).toBe(2)
    expect(result.llm.tokens.inputUncached.value).toBe(9536 + 1467)
    expect(accountComparisonLane(input(native, { afterSeq: 15 })).llm.attempts).toBe(0)
    const duplicate = [...trace.events, required(trace.events[22])]
    expect(accountComparisonLane(input(duplicate))).toEqual(accountComparisonLane(input(trace.events)))
  })

  it.each([
    'gap',
    'reader',
    'identity',
    'runtime',
    'record-runtime',
    'sequence-conflict',
    'untrusted',
    'contradictory-result',
  ] as const)('keeps the real capture conservative for %s evidence', (kind) => {
    let events = structuredClone(trace.events)
    let changes: Partial<ComparisonAccountingInput> = {}
    if (kind === 'gap') events = events.filter((row) => row.seq !== 2)
    if (kind === 'reader') changes = { complete: false }
    if (kind === 'identity') changes = { sessionId: 'foreign-session' }
    if (kind === 'runtime') changes = { runtime: { id: 'native', version: '1' } }
    if (kind === 'record-runtime') {
      const data = recordData(events, 23)
      data.runtime = { id: 'native', version: '1' }
      events = change(events, 23, data)
    }
    if (kind === 'sequence-conflict') {
      const data = recordData(events, 23)
      data.record.settlement.usage.tokens.input = required(data.record.settlement.usage.tokens.input) + 1
      events.push({ ...required(events[22]), data: data as unknown as JsonValue })
    }
    if (kind === 'untrusted') {
      const row = required(events[22])
      row.origin = 'principal'
      row.trust = 'untrusted'
    }
    if (kind === 'contradictory-result') {
      const data = recordData(events, 23)
      Object.assign(data.record.settlement, {
        error: { code: 'ABORTED', message: 'cancelled', retryable: false },
      })
      events = change(events, 23, data)
    }
    const projection = projectComparisonAttemptEvidence(input(events, changes))
    const result = accountComparisonLane(input(events, changes))
    expect(projection.complete).toBe(false)
    expect(result.state).not.toBe('complete')
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.llm.tokens.inputUncached.value).toBeNull()
    if (kind === 'gap' || kind === 'reader') expect(result.llm.tokens.inputUncached.knownSubtotal).toBe(13753)
    if (kind === 'sequence-conflict') expect(result.llm.tokens.inputUncached.knownSubtotal).toBe(13753 - 1151)
  })

  it.each([
    'wrong-attempt',
    'wrong-request',
    'wrong-turn',
    'wrong-step',
    'contradictory-usage',
    'invalid-count',
    'missing-cache',
  ] as const)('does not invent or trust usage for %s in captured settlements', (kind) => {
    let events = structuredClone(trace.events)
    const data = recordData(events, 23)
    if (kind === 'wrong-attempt') data.record.attempt = 'foreign-attempt'
    if (kind === 'wrong-request') data.record.requested = 'foreign-request'
    if (kind === 'wrong-turn') data.record.turn = 'foreign-turn'
    if (kind === 'wrong-step') data.record.step = 'foreign-step'
    if (kind === 'invalid-count') data.record.settlement.usage.tokens.reasoning = 10000
    if (kind === 'missing-cache') delete data.record.settlement.usage.tokens.cacheRead
    if (kind === 'contradictory-usage') {
      data.record.id = 'contradictory-settlement'
      data.record.settlement.usage.tokens.input = required(data.record.settlement.usage.tokens.input) + 1
      events[100] = {
        ...required(events[22]),
        seq: required(events[100]).seq,
        data: data as unknown as JsonValue,
      }
    } else events = change(events, 23, data)
    const result = accountComparisonLane(input(events))
    expect(result.llm.attempts).toBe(4)
    expect(result.llm.tokens.cacheRead.value).toBeNull()
    expect(result.llm.tokens.cacheRead.knownSubtotal).toBe(16384)
    if (kind === 'missing-cache') {
      expect(result.llm.tokens.inputUncached.value).toBe(13753)
      expect(result.issues).toEqual([])
    } else {
      expect(result.llm.tokens.inputUncached.value).toBeNull()
      expect(result.llm.tokens.inputUncached.knownSubtotal).toBe(13753 - 1151)
      expect(result.issues.length).toBeGreaterThan(0)
    }
  })

  it('accepts real provider token evidence with estimated prices instead of treating estimated as absent usage', () => {
    const captured = recordData(trace.events, 23).record.settlement.usage
    const cost = required(native.find((row) => row.type === 'cost/ledger')).data as unknown as Record<
      string,
      unknown
    >
    const events = change(native, 20, {
      ...cost,
      tokens: captured.tokens,
      credits: 0,
      creditSource: 'estimated',
    })
    const result = accountComparisonLane(input(events))
    expect(result.llm.tokens.inputUncached.value).toBe(1151)
    expect(result.llm.tokens.cacheRead.value).toBe(8192)
    expect(result.llm.costs).toEqual({})
    expect(result.llm.unpricedAttempts).toBe(1)
  })

  it('refuses to turn aggregated compaction usage into a guessed model attempt count', () => {
    const events = structuredClone(native)
    const intent = required(events[14]).data as unknown as Record<string, unknown>
    const cost = required(events[19]).data as unknown as Record<string, unknown>
    events[14] = { ...required(events[14]), data: { ...intent, kind: 'compaction' } as JsonValue }
    events[19] = { ...required(events[19]), data: { ...cost, purpose: 'compaction' } as JsonValue }
    const result = accountComparisonLane(input(events))
    expect(result.llm.attempts).toBe(0)
    expect(result.issues).toContain('unsupported_native_model_accounting')
    expect(result.llm.tokens.output.knownSubtotal).toBeNull()
    expect(result.state).toBe('unknown')
  })

  it('rejects invalid windows instead of changing the caller accounting boundaries', () => {
    expect(() => accountComparisonLane(input(native, { afterSeq: 25, throughSeq: 24 }))).toThrow()
    expect(() => accountComparisonLane(input(native, { throughSeq: Number.NaN }))).toThrow()
  })
})

it('preserves measured bucket costs, currencies, multiplier provenance and unknown families across a tree', () => {
  const request: AttemptEvidence = {
    seq: 1,
    originSeq: 1,
    attemptId: 'one',
    stage: 'settled',
    family: 'llm',
    usage: { inputUncached: 10, cacheRead: 0, cacheWrite: 0, output: 5 },
    pricing: { currency: 'USD', perMillion: { inputUncached: 1, output: 4 }, multiplier: 0.5 },
  }
  const decision: AttemptEvidence = {
    ...request,
    family: 'jev',
    priceBasis: 'current',
    usage: { inputTotal: 100, output: 5 },
    pricing: {
      currency: 'USD',
      inputBasis: 'inputTotal',
      multiplier: 1,
      perMillion: { inputUncached: 0.042, cacheRead: 0.042, cacheWrite: 0.042, output: 0 },
    },
  }
  const parent = accountLane([request], { afterSeq: 0, throughSeq: 1 }, true)
  const child = accountLane(
    [
      decision,
      {
        ...request,
        seq: 2,
        originSeq: 2,
        attemptId: 'two',
        pricing: { currency: 'CNY', perMillion: { inputUncached: 1, output: 4 }, multiplier: 2 },
      },
    ],
    { afterSeq: 0, throughSeq: 2 },
    true,
  )
  const tree = aggregateComparisonTreeAccounting([parent, child], 1, true)
  expect(tree.totalCosts?.USD?.value).toBeCloseTo(0.0000192, 12)
  expect(tree.totalCosts?.CNY?.value).toBeCloseTo(0.00006, 12)
  expect(tree.llm.bucketCosts?.USD?.output?.value).toBeCloseTo(0.00001, 12)
  expect(tree.llm.priceMultipliers).toEqual([0.5, 2])
  expect(tree.jev.priceMultipliers).toEqual([1])
  expect(tree.jev.currentPriceAttempts).toBe(1)
  expect(tree.jev.bucketCosts?.USD?.inputTotal?.value).toBeCloseTo(0.0000042, 12)
  expect(tree.jev.tokens.cacheRead.value).toBeNull()
  const unknown = accountLane([{ ...decision, pricing: null }], { afterSeq: 0, throughSeq: 1 }, true)
  const partial = aggregateComparisonTreeAccounting([parent, unknown], 1, true)
  expect(partial.totalCosts?.USD).toMatchObject({ state: 'partial', value: null, missing: 1 })
  expect(partial.totalCosts?.USD?.knownSubtotal).toBeCloseTo(0.000015, 12)
  const incomplete = aggregateComparisonTreeAccounting([parent, child], 1, false)
  expect(incomplete.totalCosts?.USD?.value).toBeNull()
  expect(incomplete.llm.bucketCosts?.USD?.output?.value).toBeNull()
  const legacy = structuredClone(parent)
  delete legacy.llm.bucketCosts
  const legacyTree = aggregateComparisonTreeAccounting([legacy, parent], 1, true)
  expect(legacyTree.llm.bucketCosts?.USD?.output).toMatchObject({ state: 'partial', value: null })
})

it('accounts the real four-session tree and excludes the inherited parent prefix of a derived fork', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/comparison-tree-accounting-real.json', import.meta.url), 'utf8'),
  ) as {
    members: Array<ComparisonAccountingInput & { side: 'left' | 'right'; parentSessionId: string | null }>
  }
  const projected = fixture.members.map((member) => ({
    member,
    accounting: accountComparisonLane({ ...member, afterSeq: 0 }),
  }))
  expect(projected.map(({ accounting }) => accounting.issues)).toEqual([[], [], [], []])
  const left = aggregateComparisonTreeAccounting(
    projected.filter(({ member }) => member.side === 'left').map(({ accounting }) => accounting),
    115,
    true,
  )
  const right = aggregateComparisonTreeAccounting(
    projected.filter(({ member }) => member.side === 'right').map(({ accounting }) => accounting),
    120,
    true,
  )
  expect(left.llm.attempts).toBe(9)
  expect(right.llm.attempts).toBe(7)
  expect(right.jev.attempts).toBe(6)
  for (const side of ['left', 'right'] as const) {
    const parent = required(fixture.members.find((member) => member.side === side && !member.parentSessionId))
    const child = required(fixture.members.find((member) => member.side === side && member.parentSessionId))
    const boundary = parent.events.length
    const own = child.events.map((event, index) => ({
      ...event,
      seq: event.seq + boundary,
      ...(event.sourceEventSeqs
        ? { sourceEventSeqs: event.sourceEventSeqs.map((seq) => seq + boundary) }
        : {}),
      ...(event.type === 'x/core/model-call' && (event.data as { startedSeq?: number }).startedSeq
        ? {
            data: {
              ...(event.data as Record<string, JsonValue>),
              startedSeq: Number((event.data as { startedSeq: number }).startedSeq) + boundary,
            },
          }
        : {}),
      ...(index === 0
        ? {
            data: {
              ...(event.data as Record<string, JsonValue>),
              parent: { key: parent.sessionId, boundarySeq: boundary },
            },
          }
        : {}),
    }))
    const fork = {
      ...child,
      events: [...parent.events, ...own],
      inheritedThroughSeq: boundary,
      afterSeq: boundary,
      throughSeq: boundary + child.events.length,
    }
    const actual = accountComparisonLane(fork)
    const original = accountComparisonLane({ ...child, afterSeq: 0 })
    expect(actual.issues).toEqual([])
    expect(actual.llm).toEqual(original.llm)
    expect(actual.jev).toEqual(original.jev)
    expect(projectComparisonPriceDetails(fork).entries).toHaveLength(
      original.llm.attempts + original.jev.attempts,
    )
    expect(projectComparisonPriceDetails(fork).entries.every((entry) => entry.originSeq > boundary)).toBe(
      true,
    )
    const incomplete = aggregateComparisonTreeAccounting([original], child.throughSeq, false)
    expect(incomplete.issues).toContain('incomplete_tree')
    expect(incomplete.llm.tokens.output.value).toBeNull()
  }
})
