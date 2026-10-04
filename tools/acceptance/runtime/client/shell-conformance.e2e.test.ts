import { describe, expect, it } from 'vitest'
import { createConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import { bindConformance } from './shell-conformance.ts'

const CONTRACT = 'agh.shell'
// Recover kills a real client process with SIGKILL and starts a second one, so this run needs more
// than the default timeout on slow hosts.
const CONTRACT_TIMEOUT_MS = 30_000

describe('reference workbench shell: conformance', () => {
  it(
    'passes select, normal, deny, cancel, recover and dispose',
    async () => {
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
      expect(
        report.assertions.map((row) => [
          row.providerId,
          row.scenario,
          row.status,
          row.fixture,
          row.diagnostic,
        ]),
      ).toEqual([
        ['reference', 'select', 'passed', 'test-client-host', undefined],
        ['reference', 'normal', 'passed', 'test-client-host', undefined],
        ['reference', 'deny', 'passed', 'test-client-host', undefined],
        ['reference', 'cancel', 'passed', 'test-client-host', undefined],
        ['reference', 'recover', 'passed', 'test-client-host', undefined],
        ['reference', 'dispose', 'passed', 'test-client-host', undefined],
        // The web app has no default shell to bind yet.
        ['default', 'select', 'failed', null, undefined],
      ])
      expect(report.status).toBe('failed')
      expect(report.failures).toEqual([
        {
          code: 'missing-evidence',
          detail: `required ${CONTRACT} missing binding for provider default`,
        },
      ])
    },
    CONTRACT_TIMEOUT_MS,
  )
})
