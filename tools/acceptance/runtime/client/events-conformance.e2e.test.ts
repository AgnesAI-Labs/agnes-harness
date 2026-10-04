import { describe, expect, it } from 'vitest'
import { createConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import { bindConformance } from './events-conformance.ts'

const CONTRACT = 'agh.events'

describe('reference events: conformance', () => {
  it('passes all six classes and reports default as missing', async () => {
    const harness = createConformanceHarness()
    const request = {
      command: 'events-conformance',
      contracts: [CONTRACT],
      providers: ['default', 'reference'],
    }
    expect(await bindConformance(harness, request)).toEqual({
      contracts: [CONTRACT],
      providers: ['reference'],
    })
    const report = await harness.run({
      ...request,
      clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
    })
    expect(report.assertions.map((row) => [row.providerId, row.scenario, row.status])).toEqual([
      ...['select', 'normal', 'deny', 'cancel', 'recover', 'dispose'].map((scenario) => [
        'reference',
        scenario,
        'passed',
      ]),
      // No default events provider exists in product code.
      ['default', 'select', 'failed'],
    ])
    expect(report.failures).toEqual([
      { code: 'missing-evidence', detail: `required ${CONTRACT} missing binding for provider default` },
    ])
  }, 60_000)
})
