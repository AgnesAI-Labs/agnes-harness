import { contracts, SCENARIOS } from '@agnes/extension-api/testkit'
import { describe, expect, it } from 'vitest'
import { embeddingInput } from './embedding-fixture.js'
import { embeddingProcessDriver } from './embedding-process.js'

for (const kind of ['default', 'reference'] as const)
  describe(`${kind} embedding cold recovery`, () => {
    it.each(SCENARIOS)(
      'satisfies restricted contract %s through a real process',
      async (scenario) => {
        const observations = await contracts.runEmbeddingContractScenario(
          embeddingProcessDriver(kind, scenario),
          scenario,
        )
        expect(observations.length).toBeGreaterThan(1)
      },
      60000,
    )
    it('recovers an acknowledged usage receipt lost before the embedding result was committed', async () => {
      const d = embeddingProcessDriver(kind, 'recover', { crashAfterUsage: true })
      try {
        await d.start()
        await expect(d.encode(embeddingInput)).rejects.toThrow('process exited')
        expect(await d.counts()).toEqual({ deliveries: 1, usages: 1 })
        const reboot = await d.restart()
        expect(reboot.pid).not.toBe(reboot.previousPid)
        const recovered = await d.reconcile(embeddingInput)
        expect(recovered.kind).toBe('resolved')
        expect(await d.counts()).toEqual({ deliveries: 1, usages: 1 })
        if (recovered.kind !== 'resolved') throw Error('No resolved receipt')
        expect(await d.encode(embeddingInput)).toEqual(recovered.result)
      } finally {
        await d.close()
      }
    }, 60000)
  })
