import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type PricingTrajectory, parsePricingRequest, reestimate } from './pricing.js'

// Resolve declared public exports using an existing package dependency context; root has no SDK deps.
const resolver = createRequire(new URL('../../../packages/cli/package.json', import.meta.url))
const host = await import(pathToFileURL(resolver.resolve('@agnes/host')).href)
const protocol = await import(pathToFileURL(resolver.resolve('@agnes/protocol')).href)
const comparison = await import(
  pathToFileURL(
    createRequire(new URL('../../../packages/host/package.json', import.meta.url)).resolve(
      '@agnes/runtime-comparison',
    ),
  ).href
)
const api = {
  accountComparisonLane: host.accountComparisonLane,
  projectComparisonAttemptEvidence: host.projectComparisonAttemptEvidence,
  accountLane: comparison.accountLane,
  pricingFromModelQuote: comparison.pricingFromModelQuote,
  validModelPricePolicy: protocol.validModelPricePolicy,
  validateEvent: protocol.validateEvent,
}
const captured = JSON.parse(
  readFileSync(
    new URL('../../../packages/core/test/fixtures/comparison-real-pricing.json', import.meta.url),
    'utf8',
  ),
)
type FixtureData = {
  record?: {
    call?: { purpose: string; endpoint: string; backend: string }
    settlement?: {
      usage?: {
        tokens?: Record<string, number>
        billing?: { usdMicros: number; source: 'gateway' | 'estimated'; subscription: boolean }
      }
      error?: { code: string; message: string; retryable: boolean }
    }
  }
}
function capture(index: number): PricingTrajectory {
  const events = structuredClone(captured.reports[index].events)
  return {
    schemaVersion: 1,
    format: 'agh-ledger',
    sessionId: events[0].data.key,
    runtime: events[0].data.runtime,
    throughSeq: events.length,
    complete: true,
    events,
  }
}
const identity = { workspaceReceiptHash: 'a'.repeat(64) }
const policy = {
  currency: 'USD',
  unit: 'per-million-tokens',
  perMillion: { inputUncached: 0.3, cacheRead: 0.006, cacheWrite: 0, output: 1.2 },
}
const request = {
  schemaVersion: 1,
  trajectoryPath: '/tmp/trajectory.json',
  sourceIdentity: identity,
  llmPolicies: [
    { route: 'deepseek', model: 'deepseek-v4-flash', policy, policySource: 'synthetic explicit test policy' },
  ],
}
const originalEndpoint = 'https://api.typesafe.ai/v1/systemone'
const proxyEndpoint = 'http://relay.example.test/jev'
function relayed(): PricingTrajectory {
  const source = capture(1)
  for (const row of source.events) {
    const call = (row.data as unknown as FixtureData)?.record?.call
    if (call?.purpose === 'decision') call.endpoint = proxyEndpoint
  }
  return source
}
const jevRequest = {
  ...request,
  jevIdentities: [{ originalEndpoint, proxyEndpoint, requestedModel: 'jev-latest' }],
}

describe('Terminal-Bench read-only current pricing', () => {
  it('uses the real Host algorithms, restores exact Jev relay identity in memory, and retains source quotes/billing', async () => {
    const source = relayed()
    const original = structuredClone(source)
    const result = await reestimate(jevRequest, source, api)
    expect(source).toEqual(original)
    expect(result.basis).toBe('current-reestimate')
    expect(result.originalAccounting.jev.unpricedAttempts).toBe(3)
    expect(result.derivedAccounting.jev.currentPriceAttempts).toBe(3)
    expect(result.derivedAccounting.jev.costs.USD.value).toBeCloseTo(0.001627332, 12)
    expect(result.restoredIdentity.map((entry) => entry.requestedSeq)).toEqual([19, 52, 80])
    expect(result.derivedAccounting.llm.reportedBilling).toEqual(
      result.originalAccounting.llm.reportedBilling,
    )
    expect(result.units.reportedBilling).toBe('USD-micros')
    expect(result.units.costs).toBe('currency-units-by-currency')
    const noReasoning = structuredClone(source)
    for (const row of noReasoning.events) {
      const usage = (row.data as unknown as FixtureData)?.record?.settlement?.usage
      if (usage?.tokens) delete usage.tokens.reasoning
    }
    const without = await reestimate(jevRequest, noReasoning, api)
    expect(without.derivedAccounting.llm.costs).toEqual(result.derivedAccounting.llm.costs)
    const billed = structuredClone(source)
    const usage = (billed.events.find((row) => row.seq === 26)?.data as unknown as FixtureData)?.record
      ?.settlement?.usage
    if (!usage) throw new Error('Missing captured provider usage')
    usage.billing = { usdMicros: 321, source: 'gateway', subscription: false }
    const actual = await reestimate(jevRequest, billed, api)
    expect(actual.derivedAccounting.llm.reportedBilling.gateway.attempts).toBe(1)
    expect(actual.derivedAccounting.llm.reportedBilling.gateway.usdMicros.knownSubtotal).toBe(321)
    expect(actual.derivedAccounting.llm.costs).toEqual(result.derivedAccounting.llm.costs)
  })

  it('keeps cancelled missing usage unknown even when the configured Jev output rate is zero', async () => {
    const source = relayed()
    const row = source.events.find((event) => event.seq === 20)
    if (!row) throw new Error('Missing captured settlement')
    const record = (row.data as unknown as FixtureData).record
    if (!record) throw new Error('Missing captured record')
    record.settlement = { error: { code: 'ABORTED', message: 'Synthetic cancellation', retryable: false } }
    const result = await reestimate(jevRequest, source, api)
    expect(result.derivedAccounting.jev.outcomes.cancelled).toBe(1)
    expect(result.derivedAccounting.jev.costs.USD.state).not.toBe('complete')
    expect(result.coverage.jev.missingUsageAttempts).toBe(1)
    expect(result.coverage.jev.zeroOutputRateWithoutOutputUsageAttempts).toBe(1)
    expect(result.derivedAccounting.jev.reportedBilling.gateway.attempts).toBe(0)
  })

  it('refuses mismatched identities, owner perturbations, and non-contiguous evidence', async () => {
    const source = relayed()
    for (const changed of [
      { ...jevRequest.jevIdentities[0], requestedModel: 'other' },
      { ...jevRequest.jevIdentities[0], proxyEndpoint: 'http://other.example.test/jev' },
    ])
      await expect(reestimate({ ...jevRequest, jevIdentities: [changed] }, source, api)).rejects.toThrow(
        'JEV_IDENTITY_MISMATCH',
      )
    await expect(
      reestimate(
        { ...request, llmPolicies: [{ ...request.llmPolicies[0], model: 'other' }] },
        capture(0),
        api,
      ),
    ).rejects.toThrow('POLICY_IDENTITY_UNUSED')
    const wrongBackend = relayed()
    const call = (wrongBackend.events.find((row) => row.seq === 19)?.data as unknown as FixtureData)?.record
      ?.call
    if (!call) throw new Error('Missing captured call')
    call.backend = 'laya'
    await expect(reestimate(jevRequest, wrongBackend, api)).rejects.toThrow('JEV_IDENTITY_MISMATCH')
    const bad = capture(0)
    bad.events.splice(20, 1)
    await expect(reestimate(request, bad, api)).rejects.toThrow('TRAJECTORY_INCOMPLETE')
    await expect(reestimate(request, { ...capture(0), sessionId: 'other-session' }, api)).rejects.toThrow(
      'SOURCE_ACCOUNTING_UNVERIFIED',
    )
    expect(() =>
      parsePricingRequest({
        ...jevRequest,
        jevIdentities: [...jevRequest.jevIdentities, ...jevRequest.jevIdentities],
      }),
    ).toThrow('JEV_IDENTITY_AMBIGUOUS')
  })
})
