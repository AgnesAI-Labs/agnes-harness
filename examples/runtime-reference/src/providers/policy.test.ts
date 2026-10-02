import { describe, it } from 'vitest'
import { createPolicyFixture } from '../../../../packages/core/test/runtime/policy-fixture.js'
import { runPolicyContractScenario } from '../../../../packages/extension-api/testkit/runtime/contracts/policy.js'
import { SCENARIOS } from '../../../../packages/extension-api/testkit/runtime/evidence.js'
import { createReferencePolicyFactory } from './policy.js'

describe('independent reference Policy public factory', () => {
  for (const scenario of SCENARIOS)
    it(`public TCK ${scenario}`, async () => {
      await runPolicyContractScenario(scenario, async () =>
        createPolicyFixture(createReferencePolicyFactory, 'reference'),
      )
    })
})
