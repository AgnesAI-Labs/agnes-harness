import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as W from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import type { MemoryContractBinding as MemoryBinding } from '../../../extension-api/testkit/runtime/contracts/memory.js'
import {
  exerciseMemory,
  memoryContext,
  memoryDetail,
  memoryOptions,
  memoryRequest,
  memoryValue,
} from '../../../extension-api/testkit/runtime/contracts/memory.js'
import type { RetrievalContractBinding as RetrievalBinding } from '../../../extension-api/testkit/runtime/contracts/retrieval.js'
import { loadMemoryBindings as loadBindings } from './memory-fixture.js'

const loadMemoryBindings = () =>
  loadBindings<{
    memoryBinding(id: 'default' | 'reference', command: string): MemoryBinding
    retrievalBinding(id: 'default' | 'reference', command: string): RetrievalBinding
  }>()

describe.each(['default', 'reference'] as const)('%s sourced Memory', (id) => {
  it.each(['select', 'normal', 'deny', 'cancel', 'dispose'] as const)('%s contract', async (scenario) => {
    const { memoryBinding } = await loadMemoryBindings()
    await exerciseMemory(memoryBinding(id, 'vitest memory contract'), scenario)
  })
  it('does not grant historical reads, empty provenance, or stale identity', async () => {
    const { memoryBinding } = await loadMemoryBindings(),
      directory = mkdtempSync(join(tmpdir(), 'memory-access-')),
      options = memoryOptions(directory),
      memory = memoryBinding(id, 'vitest').create(options)
    try {
      expect(
        memoryDetail(
          await memory.call(
            'remember',
            { ...memoryRequest(), items: [{ ...memoryRequest().items[0], sourceRefs: [] }] },
            memoryContext(),
          ),
        ),
      ).toBe('memory_source_denied')
      const added = memoryValue<W.MemoryRememberResult>(
        'MemoryRememberResult',
        await memory.call('remember', memoryRequest(), memoryContext()),
      )
      expect(
        memoryDetail(
          await memory.call(
            'get',
            { ids: added.memoryRefs.map((ref) => ref.id), atRevision: 0 },
            memoryContext(),
          ),
        ),
      ).toBe('memory_revision_conflict')
      const resolve = options.identity
      options.identity = (context) => ({ ...resolve(context), expiresAt: '2000-01-01T00:00:00Z' })
      expect(memoryDetail(await memory.call('get', { ids: [], atRevision: null }, memoryContext()))).toBe(
        'tenant_denied',
      )
    } finally {
      await memory.close('shutdown')
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
