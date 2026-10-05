import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { openToolsFixture } from '../../../../packages/core/test/runtime/tools-fixture.js'
import { registerToolsContract } from '../../../../packages/extension-api/testkit/runtime/contracts/tools.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { getConformanceBuildIdentity } from '../build-identity.js'
import { toolsColdRecovery } from './tools-cold.js'

export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  if (request.contracts !== 'all' && !request.contracts.includes('agh.tools'))
    return { contracts: [], providers: [] }
  const providers = request.providers.filter(
    (id): id is 'default' | 'reference' => id === 'default' || id === 'reference',
  )
  for (const providerId of providers) {
    const paths = [
      'packages/extension-api/src/runtime/tool-authoring.ts',
      'packages/extension-api/testkit/runtime/contracts/tools.ts',
      'packages/core/test/runtime/tools-fixture.ts',
      'packages/core/test/runtime/fixtures/tools-recovery-worker.ts',
      'tools/acceptance/runtime/platform/tools-cold.ts',
      providerId === 'default'
        ? 'packages/core/src/runtime/providers/tools.ts'
        : 'examples/runtime-reference/src/providers/tools.ts',
      ...(providerId === 'default' ? ['packages/core/src/runtime/tools/definitions.ts'] : []),
    ]
    const hash = createHash('sha256')
    for (const path of paths)
      hash.update(path).update(readFileSync(new URL(`../../../../${path}`, import.meta.url)))
    registerToolsContract(harness, {
      providerId,
      providerDigest: hash.digest('hex'),
      build: getConformanceBuildIdentity(),
      command: request.command,
      open: () => openToolsFixture(providerId),
      coldRecover: () => toolsColdRecovery(providerId),
    })
  }
  return { contracts: ['agh.tools'], providers }
}
