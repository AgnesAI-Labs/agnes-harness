import { describe, expect, it } from 'vitest'
import { createConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import { bindConformance } from './shell-conformance.ts'

const CONTRACT = 'agh.shell'

describe('reference workbench shell: conformance', () => {
  it('passes select, normal, deny, cancel and dispose and reports recover as missing evidence', async () => {
    const harness = createConformanceHarness()
    const request = {
      command: 'shell-conformance',
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
    expect(report.assertions.map((row) => [row.providerId, row.scenario, row.status, row.fixture])).toEqual([
      ['reference', 'select', 'passed', 'test-client-host'],
      ['reference', 'normal', 'passed', 'test-client-host'],
      ['reference', 'deny', 'passed', 'test-client-host'],
      ['reference', 'cancel', 'passed', 'test-client-host'],
      ['reference', 'recover', 'skipped', 'test-client-host'],
      ['reference', 'dispose', 'passed', 'test-client-host'],
      // The web app has no default shell to bind yet.
      ['default', 'select', 'failed', null],
    ])
    expect(report.status).toBe('failed')
    expect(report.failures).toEqual([
      {
        code: 'missing-evidence',
        detail: `required ${CONTRACT} missing binding for provider default`,
      },
      {
        code: 'missing-evidence',
        detail: `required ${CONTRACT} recover ${CONTRACT}/reference/recover skipped`,
      },
    ])
  })
})
