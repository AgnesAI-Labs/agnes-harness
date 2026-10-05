import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contracts } from '../../../packages/extension-api/testkit/index.js'
import type { ConformanceHarness } from '../../../packages/extension-api/testkit/runtime/harness.js'
import { canonicalJsonDigest } from '../../../packages/protocol/src/runtime/index.js'
import { getConformanceBuildIdentity } from './build-identity.js'
import { createPricingContractFixture } from './fixtures/pricing.js'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
type Kind = 'default' | 'reference'

function releaseDigest(kind: Kind): string {
  const files = [
    kind === 'default'
      ? 'packages/ai/src/runtime/providers/pricing.ts'
      : 'examples/runtime-reference/src/providers/pricing.ts',
    'tools/acceptance/runtime/fixtures/pricing.ts',
    'tools/acceptance/runtime/fixtures/pricing-recovery.ts',
    'tools/acceptance/runtime/fixtures/pricing-recovery-worker.ts',
  ]
  return canonicalJsonDigest(
    files.map((path) => ({
      path,
      digest: createHash('sha256')
        .update(readFileSync(join(ROOT, path)))
        .digest('hex'),
    })),
  )
}

export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  if (request.contracts !== 'all' && !request.contracts.includes('agh.pricing'))
    return { contracts: [], providers: [] }
  const providers = request.providers.filter((id): id is Kind => id === 'default' || id === 'reference')
  const build = getConformanceBuildIdentity()
  for (const providerId of providers)
    contracts.registerPricingContract(harness, {
      providerId,
      command: request.command,
      build,
      releaseSetDigest: releaseDigest(providerId),
      async create() {
        const directory = mkdtempSync(join(tmpdir(), `pricing-${providerId}-`))
        try {
          const fixture = createPricingContractFixture(providerId, {
            databasePath: join(directory, 'catalog.sqlite'),
            providerId,
            recover: true,
          })
          return {
            ...fixture,
            async finish() {
              try {
                await fixture.finish()
              } finally {
                rmSync(directory, { recursive: true, force: true })
              }
            },
          }
        } catch (error) {
          rmSync(directory, { recursive: true, force: true })
          throw error
        }
      },
    })
  return { contracts: ['agh.pricing'], providers }
}
