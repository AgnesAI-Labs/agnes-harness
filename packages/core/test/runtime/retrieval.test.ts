import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as W from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import type { MemoryContractBinding as MemoryBinding } from '../../../extension-api/testkit/runtime/contracts/memory.js'
import {
  memoryContext,
  memoryDetail,
  memoryOptions,
  memoryRequest,
  memoryValue,
} from '../../../extension-api/testkit/runtime/contracts/memory.js'
import type { RetrievalContractBinding as RetrievalBinding } from '../../../extension-api/testkit/runtime/contracts/retrieval.js'
import {
  exerciseRemoteRetrieval,
  exerciseRetrieval,
} from '../../../extension-api/testkit/runtime/contracts/retrieval.js'
import { propagateMemoryDeletions } from '../../src/runtime/memory/deletion-propagation.js'
import { loadMemoryBindings as loadBindings } from './memory-fixture.js'

const loadMemoryBindings = () =>
  loadBindings<{
    memoryBinding(id: 'default' | 'reference', command: string): MemoryBinding
    retrievalBinding(id: 'default' | 'reference', command: string): RetrievalBinding
  }>()

describe.each(['default', 'reference'] as const)('%s hybrid Retrieval', (id) => {
  it('snapshots ingestion before an asynchronous authorization read', async () => {
    const { retrievalBinding } = await loadMemoryBindings(),
      binding = retrievalBinding(id, 'vitest ingestion snapshot'),
      directory = mkdtempSync(join(tmpdir(), 'index-ingestion-snapshot-')),
      options = memoryOptions(join(directory, 'memory')),
      memory = binding.createMemory(options),
      index = binding.create({ ...options, directory: join(directory, 'index'), memory }),
      context = memoryContext()
    try {
      const written = memoryValue<W.MemoryRememberResult>(
        'MemoryRememberResult',
        await memory.call('remember', memoryRequest(), context),
      )
      const batch = {
        expectedRevision: 0,
        dimensions: 2,
        documents: [
          {
            memoryId: written.memoryRefs[0]!.id,
            text: 'alpha',
            vector: [1, 0],
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
        queryVectors: { alpha: [1, 0] },
      }
      const original = memory.call
      let release = () => {}
      const fence = new Promise<void>((resolve) => {
        release = resolve
      })
      memory.call = async (...args) => {
        await fence
        return original(...args)
      }
      const build = index.replaceIndex(batch, context)
      batch.documents[0]!.vector.pop()
      batch.queryVectors.alpha.pop()
      release()
      expect((await build).ok).toBe(true)
      memory.call = original
      const result = memoryValue<W.PageRetrievalHit>(
        'PageRetrievalHit',
        await index.call(
          'search',
          { queryText: 'alpha', indexRef: index.indexRef(), topK: 10, filter: {}, cursor: null },
          context,
        ),
      )
      expect(result.items).toHaveLength(1)
      expect(result.items[0]?.score).toBe(1)
    } finally {
      await index.close('shutdown')
      await memory.close('shutdown')
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.each(['select', 'normal', 'deny', 'cancel', 'dispose'] as const)('%s contract', async (scenario) => {
    const { retrievalBinding } = await loadMemoryBindings()
    await exerciseRetrieval(retrievalBinding(id, 'vitest retrieval contract'), scenario)
    await exerciseRemoteRetrieval(retrievalBinding(id, 'vitest remote retrieval contract'), scenario)
  })
  it('retains failed propagation, fences changed deletion deliveries and revokes old cursors', async () => {
    const { retrievalBinding } = await loadMemoryBindings(),
      binding = retrievalBinding(id, 'vitest'),
      directory = mkdtempSync(join(tmpdir(), 'index-revocation-')),
      options = memoryOptions(join(directory, 'memory')),
      memory = binding.createMemory(options),
      retrieval = binding.create({ ...options, directory: join(directory, 'index'), memory }),
      ctx = memoryContext()
    try {
      const request = memoryRequest(),
        added = memoryValue<W.MemoryRememberResult>(
          'MemoryRememberResult',
          await memory.call('remember', { ...request, items: [...request.items, ...request.items] }, ctx),
        ),
        ids = added.memoryRefs.map((ref) => ref.id)
      expect(
        (
          await retrieval.replaceIndex(
            {
              expectedRevision: 0,
              dimensions: 2,
              documents: ids.map((memoryId) => ({
                memoryId,
                text: 'alpha',
                vector: [1, 0],
                createdAt: '2026-01-01T00:00:00Z',
              })),
              queryVectors: { alpha: [1, 0] },
            },
            ctx,
          )
        ).ok,
      ).toBe(true)
      const query = { queryText: 'alpha', indexRef: retrieval.indexRef(), topK: 1, filter: {}, cursor: null }
      const first = memoryValue<W.PageRetrievalHit>(
        'PageRetrievalHit',
        await retrieval.call('search', query, ctx),
      )
      const deleted = memoryValue<W.MemoryForgetResult>(
        'MemoryForgetResult',
        await memory.call(
          'forget',
          { memoryIds: [ids[0]], expectedRevision: 1, reason: 'revoke' },
          memoryContext('forget'),
        ),
      )
      expect(memoryDetail(await retrieval.call('search', { ...query, cursor: first.nextCursor }, ctx))).toBe(
        'retrieval_cursor_stale',
      )
      await expect(
        propagateMemoryDeletions(
          memory,
          [
            {
              removeDeleted: async () => {
                throw new Error('offline')
              },
            },
          ],
          ctx.signal,
        ),
      ).rejects.toThrow('offline')
      expect(memory.pendingDeletions()).toEqual([deleted.deletionReceipt])
      await expect(propagateMemoryDeletions(memory, [retrieval], ctx.signal)).resolves.toBe(1)
      await expect(retrieval.removeDeleted({ ...deleted.deletionReceipt, watermark: 99 })).rejects.toThrow(
        'retrieval_deletion_conflict',
      )
      expect(retrieval.deletionWatermark()).toBe(2)
      expect(memory.pendingDeletions()).toEqual([])
    } finally {
      await retrieval.close('shutdown')
      await memory.close('shutdown')
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

it('keeps reference implementations independent and uses a different indexing algorithm', () => {
  for (const domain of ['memory', 'retrieval']) {
    const source = readFileSync(new URL(`../../src/runtime/providers/${domain}.ts`, import.meta.url), 'utf8'),
      reference = readFileSync(
        new URL(`../../../../examples/runtime-reference/src/providers/${domain}.ts`, import.meta.url),
        'utf8',
      )
    expect(reference).not.toMatch(/@agnes\/core|packages\/core/)
    const lines = (body: string) =>
      new Set(
        body
          .split('\n')
          .map((line) => line.replace(/\s/g, ''))
          .filter(Boolean),
      )
    const a = lines(source),
      b = lines(reference),
      common = [...a].filter((line) => b.has(line)).length
    expect(common / Math.min(a.size, b.size)).toBeLessThanOrEqual(0.5)
    if (domain === 'retrieval') {
      expect(
        readFileSync(
          new URL('../../../../packages/host/src/runtime/providers/memory-storage.ts', import.meta.url),
          'utf8',
        ),
      ).toContain('USING fts5')
      expect(reference).toContain('postings')
      expect(reference).not.toContain('USING fts5')
    }
  }
})

it('returns the same authorized document set and refusal codes across implementations', async () => {
  const { retrievalBinding } = await loadMemoryBindings(),
    results: unknown[] = []
  for (const id of ['default', 'reference'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'hybrid-cross-')),
      options = memoryOptions(join(directory, 'memory')),
      binding = retrievalBinding(id, 'vitest'),
      memory = binding.createMemory(options),
      index = binding.create({ ...options, directory: join(directory, 'index'), memory }),
      ctx = memoryContext()
    try {
      const added = memoryValue<W.MemoryRememberResult>(
        'MemoryRememberResult',
        await memory.call('remember', memoryRequest(), ctx),
      )
      await index.replaceIndex(
        {
          expectedRevision: 0,
          dimensions: 2,
          documents: [
            {
              memoryId: added.memoryRefs[0]!.id,
              text: 'ＡＬＰＨＡ',
              vector: [1, 0],
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
          queryVectors: {},
        },
        ctx,
      )
      const query = { queryText: 'alpha', indexRef: index.indexRef(), topK: 10, filter: {}, cursor: null },
        page = memoryValue<W.PageRetrievalHit>('PageRetrievalHit', await index.call('search', query, ctx))
      results.push({
        documents: page.items.map((hit) => ({
          ref: hit.ref,
          score: hit.score,
          trust: hit.trust,
          sources: hit.source.sourceRefs,
        })),
        denied: memoryDetail(await index.call('search', query, { ...ctx, authorizationRef: 'other-tenant' })),
      })
    } finally {
      await index.close('shutdown')
      await memory.close('shutdown')
      rmSync(directory, { recursive: true, force: true })
    }
  }
  expect(results[0]).toEqual(results[1])
})

it.each([
  ['default', 'default'],
  ['default', 'reference'],
  ['reference', 'default'],
  ['reference', 'reference'],
] as const)('shares current ACL and TTL across %s Memory / %s Retrieval', async (memoryId, retrievalId) => {
  const now = Date.now()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  const directory = mkdtempSync(join(tmpdir(), 'memory-acl-matrix-')),
    bindings = await loadMemoryBindings(),
    options = memoryOptions(join(directory, 'memory'))
  options.authorize = (_method, item, context) =>
    context.principalRef === 'fixture-principal' ||
    (context.principalRef === 'reader' && (item === null || item.labels.includes('public')))
  const memory = bindings.memoryBinding(memoryId, 'vitest mixed providers').create(options),
    index = bindings
      .retrievalBinding(retrievalId, 'vitest mixed providers')
      .create({ ...options, directory: join(directory, 'index'), memory }),
    admin = memoryContext(),
    reader = { ...admin, principalRef: 'reader' }
  try {
    const request = memoryRequest(),
      input = request.items[0]!
    const written = memoryValue<W.MemoryRememberResult>(
      'MemoryRememberResult',
      await memory.call(
        'remember',
        {
          expectedRevision: 0,
          items: [
            { ...input, labels: ['public'] },
            { ...input, labels: ['private'] },
            { ...input, labels: ['public'], expiresAt: new Date(now + 1000).toISOString() },
          ],
        },
        admin,
      ),
    )
    expect(
      (
        await index.replaceIndex(
          {
            expectedRevision: 0,
            dimensions: 2,
            documents: written.memoryRefs.map((ref) => ({
              memoryId: ref.id,
              text: 'alpha',
              vector: [1e308, 1e308],
              createdAt: new Date(now).toISOString(),
            })),
            queryVectors: { alpha: [1e308, 1e308] },
          },
          admin,
        )
      ).ok,
    ).toBe(true)
    vi.setSystemTime(now + 2000)
    const authorized = memoryValue<W.MemoryGetResult>(
        'MemoryGetResult',
        await memory.call('get', { ids: [], atRevision: null }, reader),
      ),
      recalled = memoryValue<W.PageRetrievalHit>(
        'PageRetrievalHit',
        await index.call(
          'search',
          { queryText: 'alpha', indexRef: index.indexRef(), topK: 100, filter: {}, cursor: null },
          reader,
        ),
      )
    expect(authorized.items).toHaveLength(1)
    expect(recalled.items.map((hit) => hit.ref)).toEqual(
      authorized.items.map((item) => ({ kind: 'domain', value: item.ref })),
    )
    expect(recalled.items[0]?.score).toBeCloseTo(1)
  } finally {
    await index.close('shutdown')
    await memory.close('shutdown')
    rmSync(directory, { recursive: true, force: true })
    vi.useRealTimers()
  }
})
