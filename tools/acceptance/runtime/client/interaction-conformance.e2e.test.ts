import { describe, expect, it } from 'vitest'
import { SCENARIOS } from '../../../../packages/extension-api/testkit/runtime/evidence.js'
import { createConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { bindConformance } from './interaction-conformance.js'

const CONTRACT = 'agh.interaction'
const PROVIDERS = ['default', 'reference']
// The default refuses cancel and expire, and has no provider process of its own for recover to kill.
const NOT_RUN: Record<string, string> = {
  cancel: 'not run: cancel refused as unsupported, expire refused as unsupported',
  recover:
    'not run: the default provider has no process of its own to kill, and its wake commits with the answer',
}
const fixture = (providerId: string, scenario: string) => {
  if (providerId === 'default' && NOT_RUN[scenario] !== undefined) return null
  if (scenario === 'select') return 'test-service-container'
  if (scenario === 'dispose') return providerId === 'default' ? 'restricted-effects' : null
  return 'runtime-inbox'
}

describe('default and reference interaction providers: conformance', () => {
  // Recover kills real reference provider processes, so this run is heavy.
  it('pass every class the default supports and fail cancel and recover, which it cannot run', async () => {
    const harness = createConformanceHarness()
    const request = { command: 'interaction-conformance', contracts: [CONTRACT], providers: PROVIDERS }
    expect(await bindConformance(harness, request)).toEqual({ contracts: [CONTRACT], providers: PROVIDERS })
    const report = await harness.run({
      ...request,
      clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
    })
    const expected = PROVIDERS.flatMap((providerId) =>
      SCENARIOS.map((scenario) => [
        providerId,
        scenario,
        providerId === 'default' && NOT_RUN[scenario] !== undefined ? 'failed' : 'passed',
        fixture(providerId, scenario),
      ]),
    )
    expect(report.assertions.map((row) => [row.providerId, row.scenario, row.status, row.fixture])).toEqual(
      expected,
    )
    // A default pass names the stand-ins it ran on, a default failure why it did not run; reference rows neither.
    expect(report.assertions.map((row) => row.diagnostic ?? null)).toEqual(
      expected.map(([providerId, scenario, status]) =>
        providerId !== 'default'
          ? null
          : status === 'failed'
            ? NOT_RUN[String(scenario)]
            : expect.stringContaining("the Host State test fixture's"),
      ),
    )
    expect(report.status).toBe('failed')
    expect(report.failures).toEqual([])
  }, 60_000)
})
