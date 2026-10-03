import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReferenceMemory } from '../../../../examples/runtime-reference/src/providers/memory.js'
import { createReferenceRetrieval } from '../../../../examples/runtime-reference/src/providers/retrieval.js'
import { createMemoryService as coreMemory } from '../../../../packages/core/src/runtime/providers/memory.js'
import { createRetrievalService as coreRetrieval } from '../../../../packages/core/src/runtime/providers/retrieval.js'
import {
  type MemoryContractBinding,
  registerMemoryContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/memory.js'
import {
  type RetrievalContractBinding,
  registerRetrievalContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/retrieval.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import {
  createMemoryStorage,
  createRetrievalStorage,
} from '../../../../packages/host/src/runtime/providers/memory-storage.js'
import { getConformanceBuildIdentity } from '../build-identity.js'
import { createRemotePeer } from '../fixtures/retrieval-remote-peer.js'

const createMemoryService = (options: Parameters<typeof createReferenceMemory>[0]) =>
  coreMemory({
    ...options,
    identity: (context) => options.identity(context),
    authorize: (method, item, context) => options.authorize(method, item, context),
    sourceAvailable: (source, trust, context) => options.sourceAvailable(source, trust, context),
    storage: createMemoryStorage(options.directory),
  })
const createRetrievalService = (options: Parameters<typeof createReferenceRetrieval>[0]) =>
  coreRetrieval({
    ...options,
    identity: (context) => options.identity(context),
    authorize: (method, item, context) => options.authorize(method, item, context),
    sourceAvailable: (source, trust, context) => options.sourceAvailable(source, trust, context),
    storage: createRetrievalStorage(options.directory),
  })

function cold<T>(provider: string, mode: string, directory: string, ids: readonly string[] = []): T {
  const fixture = fileURLToPath(new URL('../fixtures/memory-cold-process.ts', import.meta.url))
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', fixture, provider, mode, directory, JSON.stringify(ids)],
    { timeout: 30_000, encoding: 'utf8' },
  )
  if (result.error || result.status !== 0)
    throw new Error(`Memory cold process failed: ${result.stderr}`, { cause: result.error })
  return JSON.parse(result.stdout) as T
}
function identity(providerId: 'default' | 'reference', domain: 'memory' | 'retrieval', command: string) {
  const prefix =
    providerId === 'default' ? 'packages/core/src/runtime' : 'examples/runtime-reference/src/providers'
  const files =
    providerId === 'default'
      ? [
          `${prefix}/providers/${domain}.ts`,
          `${prefix}/memory/access.ts`,
          `${prefix}/memory/storage.ts`,
          'packages/host/src/runtime/providers/memory-storage.ts',
          ...(domain === 'retrieval'
            ? [
                `${prefix}/retrieval/index-revisions.ts`,
                `${prefix}/retrieval/remote.ts`,
                `${prefix}/retrieval/storage.ts`,
              ]
            : []),
        ]
      : [
          `${prefix}/${domain}.ts`,
          `${prefix}/memory-store.ts`,
          ...(domain === 'retrieval' ? [`${prefix}/retrieval-remote.ts`] : []),
        ]
  const hash = createHash('sha256')
  for (const file of files)
    hash.update(file).update(readFileSync(new URL(`../../../../${file}`, import.meta.url)))
  return { providerId, providerDigest: hash.digest('hex'), command, build: getConformanceBuildIdentity() }
}
export function memoryBinding(id: 'default' | 'reference', command: string): MemoryContractBinding {
  return {
    ...identity(id, 'memory', command),
    create: id === 'default' ? createMemoryService : createReferenceMemory,
    async coldRead(directory, ids) {
      return cold(id, 'memory', directory, ids)
    },
  }
}
export function retrievalBinding(id: 'default' | 'reference', command: string): RetrievalContractBinding {
  return {
    ...identity(id, 'retrieval', command),
    createMemory: id === 'default' ? createMemoryService : createReferenceMemory,
    create: id === 'default' ? createRetrievalService : createReferenceRetrieval,
    async coldSearch(directory) {
      return cold(id, 'retrieval', directory)
    },
    remoteFixture: createRemotePeer,
    async coldRemote(directory, frame) {
      writeFileSync(join(directory, 'remote-frame.json'), JSON.stringify(frame), { mode: 0o600 })
      return cold(id, 'remote-resume', directory)
    },
  }
}
export async function bindConformance(
  harness: ConformanceHarness,
  request: { command: string; contracts: readonly string[] | 'all'; providers: readonly string[] },
): Promise<{ contracts: readonly string[]; providers: readonly string[] }> {
  const contracts = ['agh.memory', 'agh.retrieval'].filter(
    (contract) => request.contracts === 'all' || request.contracts.includes(contract),
  )
  const providers = request.providers.filter(
    (id): id is 'default' | 'reference' => id === 'default' || id === 'reference',
  )
  for (const id of providers) {
    if (contracts.includes('agh.memory')) registerMemoryContract(harness, memoryBinding(id, request.command))
    if (contracts.includes('agh.retrieval'))
      registerRetrievalContract(harness, retrievalBinding(id, request.command))
  }
  return { contracts, providers: contracts.length ? providers : [] }
}
