import { describe, expect, it } from 'vitest'
import { runMediaContractScenario } from '../../../extension-api/testkit/runtime/contracts/media.js'
import { createMediaContractFixture } from '../../../extension-api/testkit/runtime/contracts/media-fixture.js'
import { SCENARIOS } from '../../../extension-api/testkit/runtime/evidence.js'
import { createDefaultMediaFactory } from '../../src/runtime/providers/media.js'

describe('default media provider contract', () => {
  it.each(SCENARIOS)('%s', async (scenario) => {
    const result = await runMediaContractScenario(scenario, () =>
      createMediaContractFixture((d) => createDefaultMediaFactory(d)),
    )
    expect(result.providerDigest).toBe('f'.repeat(64))
  })
})
