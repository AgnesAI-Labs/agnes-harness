import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { referenceModelFixture } from '../../../examples/runtime-reference/src/providers/model-contract.js'
import { runModelContractScenario } from '../../../packages/extension-api/testkit/runtime/contracts/model.js'
import { SCENARIOS } from '../../../packages/extension-api/testkit/runtime/evidence.js'
import type { ConformanceHarness } from '../../../packages/extension-api/testkit/runtime/harness.js'
import { defaultModelFixture } from '../../../packages/host/test/runtime/model-contract-fixture.js'
import { canonicalJsonDigest } from '../../../packages/protocol/src/runtime/index.js'
import { getConformanceBuildIdentity } from './build-identity.js'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
type Kind = 'default' | 'reference'

const SOURCES: Record<Kind, readonly string[]> = {
  default: [
    'packages/core/src/runtime/providers/model.ts',
    'packages/host/test/runtime/model-contract-fixture.ts',
  ],
  reference: [
    'examples/runtime-reference/src/providers/model.ts',
    'examples/runtime-reference/src/providers/model-contract.ts',
  ],
}
const SHARED = ['packages/extension-api/testkit/runtime/contracts/model.ts']

function releaseDigest(kind: Kind): string {
  return canonicalJsonDigest(
    [...SOURCES[kind], ...SHARED].map((path) => ({
      path,
      digest: createHash('sha256')
        .update(readFileSync(join(ROOT, path)))
        .digest('hex'),
    })),
  )
}

/** The model contract's State peer is a restricted in-memory stand-in, so recovery across a restart is not claimed as passing. */
const RECOVER_PENDING =
  'recover is not claimed: the restart reopens the service in the same process over the restricted in-memory child peer; no real State consumer or fresh process reads the published child result yet'

export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  if (request.contracts !== 'all' && !request.contracts.includes('agh.model'))
    return { contracts: [], providers: [] }
  const providers = request.providers.filter((id): id is Kind => id === 'default' || id === 'reference')
  const build = getConformanceBuildIdentity()
  for (const providerId of providers) {
    const open = () =>
      providerId === 'default' ? Promise.resolve(defaultModelFixture()) : referenceModelFixture()
    for (const scenario of SCENARIOS)
      harness.registerCase({
        contract: 'agh.model',
        scenario,
        qualification: 'required',
        providerId,
        async run() {
          const proof = await runModelContractScenario(scenario, open)
          const pending = scenario === 'recover'
          return {
            id: `agh.model/${providerId}/${scenario}`,
            providerDigest: proof.providerDigest,
            configDigest: proof.inputDigest,
            recipe: 'selected-model-prepare-infer',
            features: [],
            build,
            consumer: 'public-model-spi-restricted-peer',
            command: request.command,
            status: pending ? 'failed' : 'passed',
            ...(pending ? { diagnostic: RECOVER_PENDING } : {}),
            releaseSetDigest: releaseDigest(providerId),
            attachmentDigest: null,
            fixture: 'test-service-container',
            sharedEvidenceId: null,
            perImplementation: true,
            gate: null,
          }
        },
      })
  }
  return { contracts: ['agh.model'], providers }
}
