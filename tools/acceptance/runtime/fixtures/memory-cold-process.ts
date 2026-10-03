import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createReferenceMemory } from '../../../../examples/runtime-reference/src/providers/memory.js'
import { createReferenceRetrieval } from '../../../../examples/runtime-reference/src/providers/retrieval.js'
import { propagateMemoryDeletions } from '../../../../packages/core/src/runtime/memory/deletion-propagation.js'
import { createMemoryService as coreMemory } from '../../../../packages/core/src/runtime/providers/memory.js'
import { createRetrievalService as coreRetrieval } from '../../../../packages/core/src/runtime/providers/retrieval.js'
import {
  memoryContext,
  memoryOptions,
  memoryRequest,
  memoryValue,
} from '../../../../packages/extension-api/testkit/runtime/contracts/memory.js'
import {
  createMemoryStorage,
  createRetrievalStorage,
} from '../../../../packages/host/src/runtime/providers/memory-storage.js'
import type { ActionFrame, MemoryRememberResult } from '../../../../packages/protocol/src/runtime/index.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'
import {
  remoteHandlerScope,
  remotePeerBinding,
  remotePeerPorts,
  remoteStateBinding,
  remoteTarget,
} from './retrieval-remote-peer.js'

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

const [provider, mode, directory, encoded] = process.argv.slice(2)
if (
  !directory ||
  !['default', 'reference'].includes(provider ?? '') ||
  !['memory', 'retrieval', 'crash-write', 'crash-index-write', 'remote-resume'].includes(mode ?? '')
)
  throw new Error('invalid cold fixture arguments')
const options = memoryOptions(mode === 'memory' ? directory : join(directory, 'memory'))
const memory = (provider === 'default' ? createMemoryService : createReferenceMemory)(options)
try {
  if (mode === 'memory')
    process.stdout.write(
      JSON.stringify({
        result: await memory.call(
          'get',
          { ids: JSON.parse(encoded ?? '[]'), atRevision: null },
          memoryContext('cold-get'),
        ),
        pending: memory.pendingDeletions(),
      }),
    )
  else {
    const index = (provider === 'default' ? createRetrievalService : createReferenceRetrieval)({
      ...options,
      directory: join(directory, 'index'),
      memory,
      remote: {
        state: remoteStateBinding,
        select: (target) =>
          canonicalJsonDigest(target) === canonicalJsonDigest(remoteTarget) ? remotePeerBinding : null,
      },
    })
    try {
      if (mode === 'remote-resume') {
        const frame = JSON.parse(readFileSync(join(directory, 'remote-frame.json'), 'utf8')) as ActionFrame
        const action = await index.actions!.searchRemote!.create(remoteHandlerScope(index.binding))
        if (action.kind !== 'composite') throw new Error('remote cold action is not composite')
        try {
          process.stdout.write(JSON.stringify(await action.resume(frame, remotePeerPorts(directory))))
        } finally {
          await action.close('shutdown')
        }
        process.exitCode = 0
      } else {
        if (mode === 'crash-write' || mode === 'crash-index-write') {
          const request = memoryRequest(),
            added = memoryValue<MemoryRememberResult>(
              'MemoryRememberResult',
              await memory.call(
                'remember',
                { ...request, items: [...request.items, ...request.items] },
                memoryContext(),
              ),
            )
          const built = await index.replaceIndex(
            {
              expectedRevision: 0,
              dimensions: 2,
              documents: added.memoryRefs.map((ref) => ({
                memoryId: ref.id,
                text: 'alpha',
                vector: [1, 0],
                createdAt: '2026-01-01T00:00:00Z',
              })),
              queryVectors: { alpha: [1, 0] },
            },
            memoryContext(),
          )
          if (!built.ok) throw new Error('crash fixture index failed')
          const deleted = await memory.call(
            'forget',
            { memoryIds: [added.memoryRefs[0]!.id], expectedRevision: 1, reason: 'crash' },
            memoryContext('forget'),
          )
          if (!deleted.ok) throw new Error('crash fixture deletion failed')
          if (mode === 'crash-index-write')
            for (const receipt of memory.pendingDeletions()) await index.removeDeleted(receipt)
          await new Promise<never>(() => {
            process.stdout.write('committed', () => process.kill(process.pid, 'SIGKILL'))
          })
        }
        await propagateMemoryDeletions(memory, [index], new AbortController().signal)
        const result = await index.call(
          'search',
          { queryText: 'alpha', indexRef: index.indexRef(), topK: 100, filter: {}, cursor: null },
          memoryContext('cold-search'),
        )
        process.stdout.write(
          JSON.stringify({
            result,
            watermark: index.deletionWatermark(),
            indexRevision: index.indexRef().revision,
            pending: memory.pendingDeletions().length,
          }),
        )
      }
    } finally {
      await index.close('shutdown')
    }
  }
} finally {
  await memory.close('shutdown')
}
