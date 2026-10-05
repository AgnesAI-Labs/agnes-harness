import { describe, expect, it } from 'vitest'
import {
  type ContextContractFixture,
  runContextContractScenario,
} from '../../../extension-api/testkit/runtime/contracts/context.js'

describe.each(['default', 'reference'] as const)('%s Context pure query cold recovery', (id) => {
  it('kills a real query process and reproduces the fixed authorized input in a new process', async () => {
    const module = (await import(
      new URL('../../../../tools/acceptance/runtime/platform/context-conformance.ts', import.meta.url).href
    )) as { openContextFixture(id: 'default' | 'reference'): Promise<ContextContractFixture> }
    const result = await runContextContractScenario('recover', () => module.openContextFixture(id))
    expect(result.providerDigest).toMatch(/^[a-f0-9]{64}$/)
  }, 60_000)
})
