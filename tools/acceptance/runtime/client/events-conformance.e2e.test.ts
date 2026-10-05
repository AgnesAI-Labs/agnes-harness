import { describe, expect, it } from 'vitest'
import { SCENARIOS } from '../../../../packages/extension-api/testkit/runtime/evidence.js'
import { createConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { bindConformance } from './events-conformance.js'

const CONTRACT = 'agh.events'
const PROVIDERS = ['default', 'reference']

describe('default and reference events providers: conformance', () => {
  it('pass all six classes, the default marked as run on the fixture gate', async () => {
    const harness = createConformanceHarness()
    const request = { command: 'events-conformance', contracts: [CONTRACT], providers: PROVIDERS }
    expect(await bindConformance(harness, request)).toEqual({ contracts: [CONTRACT], providers: PROVIDERS })
    const report = await harness.run({
      ...request,
      clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
    })
    expect(report.assertions.map((row) => [row.providerId, row.scenario, row.status, row.fixture])).toEqual(
      PROVIDERS.flatMap((providerId) =>
        SCENARIOS.map((scenario) => [
          providerId,
          scenario,
          'passed',
          scenario === 'select'
            ? 'test-service-container'
            : providerId === 'default'
              ? 'restricted-effects'
              : null,
        ]),
      ),
    )
    // Every default pass names the fixture gate it ran on; no reference pass claims a stand-in.
    expect(
      report.assertions.map((row) => row.diagnostic?.includes("the suite's fixture gate") ?? false),
    ).toEqual(PROVIDERS.flatMap((providerId) => SCENARIOS.map(() => providerId === 'default')))
    expect(report.status).toBe('passed')
    expect(report.failures).toEqual([])
  }, 60_000)
})
