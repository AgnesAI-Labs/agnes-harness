import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createReferenceResources } from '../../../../examples/runtime-reference/src/providers/resources.js'
import {
  type ResourceCatalogContractBinding,
  registerResourceCatalogContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/resources.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { createResourcesService } from '../../../../packages/host/src/runtime/providers/resources.js'
import { getConformanceBuildIdentity } from '../build-identity.js'

export function resourceCatalogBinding(
  providerId: 'default' | 'reference',
  command: string,
): ResourceCatalogContractBinding {
  const source =
    providerId === 'default'
      ? 'packages/host/src/runtime/providers/resources.ts'
      : 'examples/runtime-reference/src/providers/resources.ts'
  const providerDigest = createHash('sha256')
    .update(readFileSync(new URL(`../../../../${source}`, import.meta.url)))
    .digest('hex')
  return {
    providerId,
    providerDigest,
    command,
    build: getConformanceBuildIdentity(),
    create: providerId === 'default' ? createResourcesService : createReferenceResources,
    async coldRead(directory, descriptor) {
      const fixture = fileURLToPath(new URL('../fixtures/resources-cold-process.ts', import.meta.url))
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', fixture, providerId, directory, descriptor.id, descriptor.version],
        { encoding: 'utf8', timeout: 30_000 },
      )
      if (child.status !== 0 || child.error)
        throw new Error(`catalog cold process failed: ${child.stderr}`, { cause: child.error })
      return JSON.parse(child.stdout) as Awaited<ReturnType<ResourceCatalogContractBinding['coldRead']>>
    },
  }
}
export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  if (request.contracts !== 'all' && !request.contracts.includes('agh.resources'))
    return { contracts: [], providers: [] }
  const providers = request.providers.filter(
    (id): id is 'default' | 'reference' => id === 'default' || id === 'reference',
  )
  for (const id of providers)
    registerResourceCatalogContract(harness, resourceCatalogBinding(id, request.command))
  return { contracts: ['agh.resources'], providers }
}
