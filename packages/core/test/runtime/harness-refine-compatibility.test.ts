import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryRememberResult } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import type { MemoryContractBinding as MemoryBinding } from '../../../extension-api/testkit/runtime/contracts/memory.js'
import {
  memoryContext,
  memoryOptions,
  memoryRequest,
  memoryValue,
} from '../../../extension-api/testkit/runtime/contracts/memory.js'
import type { RetrievalContractBinding as RetrievalBinding } from '../../../extension-api/testkit/runtime/contracts/retrieval.js'
import type { OpContext, RefineProposal } from '../../src/index.js'
import { rollbackRefine } from '../../src/refine/apply.js'
import { fakeProvider } from '../helpers/fake-provider.js'
import { openSession } from '../helpers/open-session.js'
import { loadMemoryBindings as loadBindings } from './memory-fixture.js'

const loadMemoryBindings = () =>
  loadBindings<{
    memoryBinding(id: 'default' | 'reference', command: string): MemoryBinding
    retrievalBinding(id: 'default' | 'reference', command: string): RetrievalBinding
  }>()

describe.each(['default', 'reference'] as const)(
  'legacy refine with %s Memory and Retrieval',
  (providerId) => {
    it('preserves proposal queue, applied harness entry, version and rollback through the existing extension', async () => {
      const base = new URL('../../../base/', import.meta.url)
      const { fakeSeamInit } = await import(new URL('testkit/seam-init.ts', base).href)
      const { refineHarness } = await import(new URL('extensions/refine/src/seam.ts', base).href)
      const { RefineQueue } = await import(new URL('extensions/refine/src/queue.ts', base).href)
      const { refineOperation } = await import(new URL('extensions/refine/src/operation.ts', base).href)
      const directory = mkdtempSync(join(tmpdir(), 'memory-refine-')),
        options = memoryOptions(join(directory, 'memory')),
        bindings = await loadMemoryBindings(),
        selected = bindings.retrievalBinding(providerId, 'vitest refine compatibility'),
        memory = selected.createMemory(options),
        index = selected.create({ ...options, directory: join(directory, 'index'), memory }),
        { session } = await openSession({ provider: fakeProvider([]) })
      try {
        const result = memoryValue<MemoryRememberResult>(
          'MemoryRememberResult',
          await memory.call('remember', memoryRequest(), memoryContext()),
        )
        expect(
          (
            await index.replaceIndex(
              {
                expectedRevision: 0,
                dimensions: 2,
                documents: [
                  {
                    memoryId: result.memoryRefs[0]!.id,
                    text: 'alpha knowledge',
                    vector: [1, 0],
                    createdAt: '2026-01-01T00:00:00Z',
                  },
                ],
                queryVectors: { alpha: [1, 0] },
              },
              memoryContext(),
            )
          ).ok,
        ).toBe(true)
        const init = fakeSeamInit({ preset: { harness: { queue_max: 2 } } }),
          seam = await refineHarness(init),
          queue = new RefineQueue(init.adapters.storage.table('refine_queue'))
        const proposal: RefineProposal = {
          proposalId: 'legacy-proposal',
          trigger: 'manual',
          edits: [
            {
              op: 'upsert',
              entry: {
                kind: 'memory',
                id: 'legacy',
                title: 'legacy',
                content: 'original refine content',
                scope: 'local',
                version: 1,
                source: 'test',
              },
            },
          ],
          baseline: [],
          rationale: 'compatibility fixture',
          evidenceSeqs: [1],
        }
        expect(await seam.propose(proposal)).toBe('queued')
        const operation = refineOperation({ queue, preset: {} })
        const ctx = {
          session,
          preset: session.preset,
          state: { meta: { turn: 1, triggerSeq: 1 }, step: 1, taint: false },
          snapshot: session.d.registry.snapshot(session.lastSeq),
          signal: new AbortController().signal,
          disclosed: [],
          model: { slot: 'primary', route: 'default', model: 'default' },
          verifier: { verdict: 'pass', reasons: [] },
        } as unknown as OpContext
        expect(await operation.applicable(ctx)).toBe('applied')
        await operation.run(ctx)
        const key = 'memory' + String.fromCharCode(0) + 'legacy'
        expect(session.latest('harness/entry', key)).toMatchObject({
          content: 'original refine content',
          version: 1,
          scope: 'local',
        })
        expect(queue.next()).toBeUndefined()
        const applied = await session.scan({ type: 'harness/refine', lane: session.lane, limit: 10 })
        expect(applied).toHaveLength(1)
        await rollbackRefine(session, applied[0]!.seq)
        expect(session.latest('harness/entry', key)).toBeUndefined()
        expect((await memory.call('get', { ids: [], atRevision: null }, memoryContext())).ok).toBe(true)
        await index.close('shutdown')
        await memory.close('shutdown')
        expect(session.latest('harness/entry', key)).toBeUndefined()
      } finally {
        await index.close('shutdown')
        await memory.close('shutdown')
        await session.close()
        rmSync(directory, { recursive: true, force: true })
      }
    })
  },
)
