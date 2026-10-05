import { it } from 'vitest'
import { runToolsContractScenario } from '../../../extension-api/testkit/runtime/contracts/tools.js'
import { openToolsFixture } from './tools-fixture.js'

it.each(['default', 'reference'] as const)(
  'Tools %s recover uses SIGKILL and a fresh PID for the original pure input',
  async (kind) => {
    const cold = await import(
      new URL('../../../../tools/acceptance/runtime/platform/tools-cold.js', import.meta.url).href
    )
    await runToolsContractScenario('recover', {
      open: () => openToolsFixture(kind),
      coldRecover: () => cold.toolsColdRecovery(kind),
    })
  },
  90000,
)
