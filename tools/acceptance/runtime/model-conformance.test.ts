import { describe, expect, it, vi } from 'vitest'
import { SCENARIOS } from '../../../packages/extension-api/testkit/runtime/evidence.js'
import { createConformanceHarness } from '../../../packages/extension-api/testkit/runtime/harness.js'
import { bindConformance } from './model-conformance.js'

const opened = vi.hoisted(() => ({ default: 0, reference: 0, breakRetarget: false }))
vi.mock('../../../packages/host/test/runtime/model-contract-fixture.js', async (original) => {
  const real =
    await original<typeof import('../../../packages/host/test/runtime/model-contract-fixture.js')>()
  return {
    ...real,
    defaultModelFixture: (...args: Parameters<typeof real.defaultModelFixture>) => {
      opened.default++
      const fixture = real.defaultModelFixture(...args)
      return opened.breakRetarget ? { ...fixture, retarget: async () => {} } : fixture
    },
  }
})
vi.mock('../../../examples/runtime-reference/src/providers/model-contract.js', async (original) => {
  const real =
    await original<typeof import('../../../examples/runtime-reference/src/providers/model-contract.js')>()
  return {
    ...real,
    referenceModelFixture: (...args: Parameters<typeof real.referenceModelFixture>) => {
      opened.reference++
      return real.referenceModelFixture(...args)
    },
  }
})

const clock = { startedAt: '2026-10-05T00:00:00.000Z', finishedAt: '2026-10-05T00:00:01.000Z' }

async function runBound(providers: readonly string[]) {
  const harness = createConformanceHarness()
  const bound = await bindConformance(harness, {
    command: 'model-conformance-test',
    contracts: ['agh.model'],
    providers,
  })
  const report = await harness.run({
    contracts: ['agh.model'],
    providers: bound.providers,
    command: 'model-conformance-test',
    clock,
  })
  return { bound, report }
}

describe('model conformance entry', () => {
  it('claims nothing for other contracts', async () => {
    const harness = createConformanceHarness()
    expect(
      await bindConformance(harness, { command: 'x', contracts: ['agh.pricing'], providers: ['default'] }),
    ).toEqual({
      contracts: [],
      providers: [],
    })
  })

  for (const provider of ['default', 'reference'] as const)
    it(`reports all six scenarios for ${provider}, recover not passing`, async () => {
      const { bound, report } = await runBound([provider])
      expect(bound.providers).toEqual([provider])
      const rows = report.assertions.filter((a) => a.contract === 'agh.model' && a.providerId === provider)
      expect(rows.map((row) => row.scenario).sort()).toEqual([...SCENARIOS].sort())
      for (const row of rows) {
        if (row.scenario === 'recover') {
          expect(row.status).toBe('failed')
          expect(row.diagnostic).toContain('no real State consumer')
        } else {
          expect(row.status, `${provider}/${row.scenario}`).toBe('passed')
          expect(row.providerDigest).toMatch(/^[a-f0-9]{64}$/)
        }
      }
    })

  it('registers each implementation separately and ignores unknown providers', async () => {
    const { bound, report } = await runBound(['default', 'reference', 'other'])
    expect(bound.providers).toEqual(['default', 'reference'])
    expect(new Set(report.assertions.map((a) => a.providerId))).toEqual(new Set(['default', 'reference']))
    const digests = new Set(
      report.assertions.filter((a) => a.scenario === 'select').map((a) => a.releaseSetDigest),
    )
    expect(digests.size).toBe(2)
  })

  it('opens each implementation fixture exactly once per scenario', async () => {
    opened.default = 0
    opened.reference = 0
    await runBound(['default', 'reference'])
    expect([opened.default, opened.reference]).toEqual([SCENARIOS.length, SCENARIOS.length])
  })

  it('reports a scenario the implementation really fails as not passed', async () => {
    opened.breakRetarget = true
    try {
      const { report } = await runBound(['default'])
      const deny = report.assertions.find((a) => a.scenario === 'deny')
      expect(deny?.status).toBe('failed')
      expect(report.assertions.find((a) => a.scenario === 'select')?.status).toBe('passed')
    } finally {
      opened.breakRetarget = false
    }
  })
})
