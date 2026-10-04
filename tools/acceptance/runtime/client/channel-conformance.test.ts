import { describe, expect, it } from 'vitest'
import { createConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import { bindConformance } from './channel-conformance.ts'

const CONTRACT = 'agh.channel'

describe('reference webhook channel: conformance', () => {
  it('passes all six classes against binding doubles and reports default as missing', async () => {
    const harness = createConformanceHarness()
    const request = {
      command: 'channel-conformance',
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
    expect(
      report.assertions.map((row) => [row.providerId, row.scenario, row.status, row.fixture, row.diagnostic]),
    ).toEqual([
      ...['select', 'normal', 'deny', 'cancel', 'recover', 'dispose'].map((scenario) => [
        'reference',
        scenario,
        'passed',
        scenario === 'select' ? 'test-service-container' : 'restricted-effects',
        // Every pass says what it does not prove.
        'remote, webhook ingress context and client ingress are binding doubles; not evidence for authenticated IM replies',
      ]),
      // No default channel binds until its owners and client ingress exist.
      ['default', 'select', 'failed', null, undefined],
    ])
    expect(report.status).toBe('failed')
    expect(report.failures).toEqual([
      { code: 'missing-evidence', detail: `required ${CONTRACT} missing binding for provider default` },
    ])
  }, 60_000)
})
