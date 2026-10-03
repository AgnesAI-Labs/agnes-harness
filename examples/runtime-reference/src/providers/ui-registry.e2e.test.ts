import { createConformanceHarness, SCENARIOS } from '@agnes/extension-api/testkit'
import { describe, expect, it } from 'vitest'
import { bindUIRegistryContract, type UIRegistryChange } from './ui-registry.js'

// Recover kills a real client process with SIGKILL, so every run of the contract is heavy.
// Each run starts two client processes; the default timeout leaves too little room on slow hosts.
const CONTRACT_TIMEOUT_MS = 30_000

async function run(change?: UIRegistryChange) {
  const harness = createConformanceHarness()
  await bindUIRegistryContract(harness, 'reference-ui-registry-conformance', {
    providerId: 'reference',
    ...(change ? { change } : {}),
  })
  return harness.run({
    contracts: ['agh.ui-registry'],
    providers: ['reference'],
    command: 'reference-ui-registry-conformance',
    clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
  })
}

describe('reference ui registry: conformance', () => {
  it(
    'passes select, normal, deny, cancel, recover and dispose',
    async () => {
      const report = await run()
      expect(report.assertions.map((item) => [item.scenario, item.status])).toEqual(
        SCENARIOS.map((scenario) => [scenario, 'passed']),
      )
      expect(report.status).toBe('passed')
      expect(report.failures).toEqual([])
    },
    CONTRACT_TIMEOUT_MS,
  )

  it.each([
    ['accepts a same-cell conflict', 'acceptsConflicts', ['deny']],
    ['lets a stale dispose remove the newer registration', 'staleDisposeRemovesNewer', ['cancel']],
    ['turns a host refusal into a fallback', 'hostRefusalBecomesFallback', ['deny']],
    ['selects by registration order', 'latestRegisteredWins', ['normal', 'deny', 'recover']],
  ] as const)(
    'fails a registry that %s',
    async (_name, name, failed) => {
      const report = await run({ module: new URL('./ui-registry-faults.ts', import.meta.url), name })
      expect(
        report.assertions.filter((item) => item.status === 'failed').map((item) => item.scenario),
      ).toEqual(failed)
      expect(report.status).toBe('failed')
    },
    CONTRACT_TIMEOUT_MS,
  )
})
