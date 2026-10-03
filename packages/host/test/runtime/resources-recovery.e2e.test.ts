import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createReferenceResources } from '../../../../examples/runtime-reference/src/providers/resources.js'
import {
  exerciseResourceCatalog,
  type ResourceCatalogContractBinding,
} from '../../../extension-api/testkit/runtime/contracts/resources.js'
import { createResourcesService } from '../../src/runtime/providers/resources.js'

it.each(['default', 'reference'] as const)(
  '%s recovers the exact catalog in a fresh process',
  async (providerId) => {
    const binding: ResourceCatalogContractBinding = {
      providerId,
      providerDigest: 'a'.repeat(64),
      command: 'heavy-fixture',
      build: {
        codeSha: 'a'.repeat(40),
        buildDigest: 'b'.repeat(64),
        lockDigest: 'c'.repeat(64),
        specVersion: 'fixture',
        sdkVersion: 'fixture',
        sdkDigest: 'd'.repeat(64),
        platform: 'fixture',
      },
      create: providerId === 'default' ? createResourcesService : createReferenceResources,
      async coldRead(directory, descriptor) {
        const entry = fileURLToPath(
          new URL('../../../../tools/acceptance/runtime/fixtures/resources-cold-process.ts', import.meta.url),
        )
        const process = spawnSync(
          globalThis.process.execPath,
          ['--import', 'tsx', entry, providerId, directory, descriptor.id, descriptor.version],
          { encoding: 'utf8', timeout: 30_000 },
        )
        expect(process.status, process.stderr).toBe(0)
        return JSON.parse(process.stdout)
      },
    }
    await exerciseResourceCatalog(binding, 'recover')
  },
)
