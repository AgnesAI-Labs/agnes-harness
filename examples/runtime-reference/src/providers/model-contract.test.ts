import { expect, it } from 'vitest'
import { runModelContractScenario } from '../../../../packages/extension-api/testkit/runtime/contracts/model.js'
import { SCENARIOS } from '../../../../packages/extension-api/testkit/runtime/evidence.js'
import { referenceModelFixture } from './model-contract.js'

it.each(SCENARIOS)('selected model implementation reference=true scenario=%s', async (scenario) => {
  const result = await runModelContractScenario(scenario, () => referenceModelFixture())
  expect(result.providerDigest).toMatch(/^[a-f0-9]{64}$/)
})
