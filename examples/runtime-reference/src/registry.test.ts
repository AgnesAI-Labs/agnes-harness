import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createConformanceHarness,
  discoverContracts,
  judgeReport,
  providerFileForContract,
  SCENARIOS,
} from '@agnes/extension-api/testkit'
import { describe, expect, it } from 'vitest'
import { createReferenceRegistry } from './index.js'
import { loadReferencePlugin } from './plugin.js'
import { SAMPLE_CONTRACT, SAMPLE_PROVIDER_ID, sampleContractCases } from './sample-contract.js'

describe('reference registry', () => {
  it('opens one empty slot for every generated contract', () => {
    const slots = createReferenceRegistry()
    const discovered = discoverContracts()
    expect(slots.map((slot) => slot.contract)).toEqual(discovered.map((item) => item.contract))
    for (const slot of slots) {
      const found = discovered.find((item) => item.contract === slot.contract)
      expect(slot.provider).toBeNull()
      expect(slot.major).toBe(found?.major)
      expect(slot.methods).toEqual(found?.methods)
      expect(slot.providerFile).toBe(providerFileForContract(slot.contract))
    }
    expect(loadReferencePlugin()).toEqual(slots)
    expect(() =>
      createReferenceRegistry([
        { id: 'twice', contract: 'agh.loop' },
        { id: 'again', contract: 'agh.loop' },
      ]),
    ).toThrow(/already registered/)
    expect(() => createReferenceRegistry([{ id: 'sample-note', contract: SAMPLE_CONTRACT }])).toThrow(
      /not in the catalog/,
    )
    const filled = createReferenceRegistry([{ id: 'loop-reference', contract: 'agh.loop' }])
    expect(filled.find((slot) => slot.contract === 'agh.loop')?.provider).toEqual({
      id: 'loop-reference',
      contract: 'agh.loop',
    })
    expect(filled.filter((slot) => slot.provider !== null)).toHaveLength(1)
    for (const name of ['index.ts', 'plugin.ts']) {
      const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
      expect(source).not.toContain('providers/')
    }
  })

  it('runs the copyable sample across the six scenarios', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reference-sample-'))
    const sample = sampleContractCases(join(directory, 'notes.sqlite'))
    try {
      const harness = createConformanceHarness()
      const clock = {
        startedAt: '2026-10-01T00:00:00.000Z',
        finishedAt: '2026-10-01T00:00:01.000Z',
      } as const
      const assertions = []
      for (const registration of sample.cases) {
        const input = await registration.run({
          contract: registration.contract,
          scenario: registration.scenario,
          qualification: registration.qualification,
          providerId: registration.providerId,
          clock,
          container: harness.container,
          inbox: harness.inbox,
        })
        assertions.push({
          ...input,
          contract: registration.contract,
          scenario: registration.scenario,
          qualification: registration.qualification,
          providerId: registration.providerId,
          startedAt: clock.startedAt,
          finishedAt: clock.finishedAt,
        })
      }
      const report = judgeReport({
        contracts: [SAMPLE_CONTRACT],
        providers: [SAMPLE_PROVIDER_ID],
        unknownContracts: [],
        command: 'sample-contract',
        startedAt: clock.startedAt,
        finishedAt: clock.finishedAt,
        assertions,
      })
      expect(report.assertions.map((item) => item.scenario)).toEqual([...SCENARIOS])
      expect(report.assertions.every((item) => item.status === 'passed')).toBe(true)
      expect(report.status).toBe('passed')
      expect(report.failures).toEqual([])
    } finally {
      sample.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
