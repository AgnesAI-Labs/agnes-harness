import { readFileSync } from 'node:fs'
import { discoverContracts, providerFileForContract, SCENARIOS } from '@agnes/extension-api/testkit'
import { describe, expect, it } from 'vitest'
import { runConformance } from '../../../tools/acceptance/runtime/run-conformance.js'
import { createReferenceRegistry } from './index.js'
import { loadReferencePlugin } from './plugin.js'
import { configReferenceProvider, exerciseReferenceConfig } from './providers/config.js'
import { SAMPLE_CONTRACT, SAMPLE_PROVIDER_ID } from './sample-contract.js'

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
    const loaded = loadReferencePlugin()
    expect(loaded.map((slot) => slot.contract)).toEqual(slots.map((slot) => slot.contract))
    expect(loaded.filter((slot) => slot.provider !== null)).toEqual([
      {
        ...slots.find((slot) => slot.contract === 'agh.config'),
        provider: configReferenceProvider,
      },
    ])
    expect(loaded.find((slot) => slot.contract === 'agh.config')?.providerFile).toBe(
      'examples/runtime-reference/src/providers/config.ts',
    )
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
    const registration = readFileSync(new URL('./register.ts', import.meta.url), 'utf8')
    expect(registration).toContain('./providers/config.js')
    const implementation = readFileSync(new URL('./providers/config.ts', import.meta.url), 'utf8')
    expect(implementation.includes('@agnes/host')).toBe(false)
    expect(implementation.includes('createFileConfigProvider')).toBe(false)
    expect(implementation.includes('createFetchConfigProvider')).toBe(false)
    expect(implementation.includes('createConfigProvider')).toBe(false)
  })

  it('runs the reference configuration provider across the six scenarios', async () => {
    await exerciseReferenceConfig()
  })

  it('runs the copyable sample across the six scenarios', async () => {
    const run = await runConformance({
      contracts: [SAMPLE_CONTRACT],
      providers: [SAMPLE_PROVIDER_ID],
      command: 'sample-contract',
      clock: {
        startedAt: '2026-10-01T00:00:00.000Z',
        finishedAt: '2026-10-01T00:00:01.000Z',
      },
      reportPath: null,
    })
    const rows = run.report.assertions.filter((item) => item.contract === SAMPLE_CONTRACT)
    expect(rows.map((item) => item.scenario)).toEqual([...SCENARIOS])
    expect(rows.every((item) => item.status === 'passed')).toBe(true)
    expect(run.report.failures).toEqual([
      { code: 'missing-evidence', detail: `unknown contract ${SAMPLE_CONTRACT}` },
    ])
  })
})
