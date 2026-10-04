import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bindUIRegistryContract } from '../../../../examples/runtime-reference/src/providers/ui-registry.js'
import {
  holdUIRegistryClient,
  recoverUIRegistry,
  registerUIRegistryContract,
  restartUIRegistryClient,
} from '../../../../packages/extension-api/testkit/runtime/contracts/ui-registry.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'
import { createUIRegistry } from '../../../../packages/web-client/src/runtime/providers/ui-registry.js'
import { getConformanceBuildIdentity, withConformanceBuild } from '../build-identity.js'

const CONTRACT = 'agh.ui-registry'
const PROVIDERS = ['default', 'reference'] as const
const RECIPE = 'packages/web-client/src/runtime/providers/ui-registry.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const self = fileURLToPath(import.meta.url)
const sha256 = (path: string) =>
  createHash('sha256')
    .update(readFileSync(join(root, path)))
    .digest('hex')

const build = getConformanceBuildIdentity()

/**
 * Registers the six UI registry cases for the web client's default registry. Its `recover` client
 * processes run this file, which builds the same registry.
 */
export function bindDefaultUIRegistryContract(
  harness: ConformanceHarness,
  command: string,
  providerId = 'default',
): void {
  registerUIRegistryContract(harness, {
    providerId,
    recipe: RECIPE,
    command,
    build,
    providerDigest: sha256(RECIPE),
    configDigest: canonicalJsonDigest({}),
    releaseSetDigest: sha256('packages/web-client/package.json'),
    factory: createUIRegistry,
    restart: (directory) =>
      restartUIRegistryClient(['--import', 'tsx', self, directory, JSON.stringify(build)], root),
  })
}

// The web client's default registry and the reference registry bind here.
export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  if (request.contracts !== 'all' && !request.contracts.includes(CONTRACT))
    return { contracts: [], providers: [] }
  const providers = PROVIDERS.filter((providerId) => request.providers.includes(providerId))
  for (const providerId of providers) {
    if (providerId === 'reference')
      await bindUIRegistryContract(withConformanceBuild(harness), request.command, { providerId })
    else bindDefaultUIRegistryContract(harness, request.command, providerId)
  }
  return { contracts: [CONTRACT], providers }
}

// The client process `recover` starts: `<directory>`.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const directory = process.argv[2]
  if (directory === undefined) throw new Error('expected: <directory>')
  const expectedBuild = process.argv[3]
  if (expectedBuild !== undefined) assert.deepEqual(build, JSON.parse(expectedBuild))
  recoverUIRegistry(createUIRegistry, directory, holdUIRegistryClient)
}
