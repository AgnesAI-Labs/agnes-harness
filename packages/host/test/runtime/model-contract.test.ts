import { expect, it } from 'vitest'
import { runModelContractScenario } from '../../../extension-api/testkit/runtime/contracts/model.js'
import { SCENARIOS } from '../../../extension-api/testkit/runtime/evidence.js'
import { defaultModelFixture } from './model-contract-fixture.js'

for (const reference of [false])
  it.each(SCENARIOS)(`selected model implementation reference=${reference} scenario=%s`, async (scenario) => {
    const result = await runModelContractScenario(scenario, async () => defaultModelFixture())
    expect(result.providerDigest).toMatch(/^[a-f0-9]{64}$/)
  })
