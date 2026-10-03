import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createMemoryStorage, createRetrievalStorage } from '../../src/runtime/providers/memory-storage.js'

it('rolls back domain revisions, deliveries, outbox and keyword index together and fences another owner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-storage-atomic-'))
  const memory = createMemoryStorage(directory),
    index = createRetrievalStorage(directory)
  memory.assertOwner('tenant-a')
  index.assertOwner('tenant-a')
  const receipt = { deletionId: 'delivery', authorityId: 'memory', watermark: 1, invalidatedRefs: [] }
  try {
    expect(() =>
      memory.transaction(() => {
        memory.setRevision(1)
        memory.putDelivery('delivery', 'fingerprint', { revision: 1 })
        memory.putDeletion(receipt)
        throw new Error('abort commit')
      }),
    ).toThrow('abort commit')
    expect(memory.revision()).toBe(0)
    expect(memory.delivery('delivery')).toBeNull()
    expect(memory.pendingDeletions()).toEqual([])
    expect(() =>
      index.transaction(() => {
        index.replace(
          [
            {
              memoryId: 'document',
              keywordTerms: ['alpha'],
              text: 'alpha',
              vector: [1],
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
          1,
          { alpha: [1] },
          1,
        )
        index.putRemoval('delivery', 'fingerprint', 1, 2)
        throw new Error('abort commit')
      }),
    ).toThrow('abort commit')
    expect(index.revision()).toBe(0)
    expect(index.documents()).toEqual([])
    expect(index.keywordCandidates(['alpha'])).toEqual([])
    expect(index.queryVectors()).toEqual({})
    expect(index.deletionWatermark()).toBe(0)
    memory.transaction(() => {
      memory.setRevision(1)
      memory.putDelivery('delivery', 'fingerprint', { revision: 1 })
      memory.putDeletion(receipt)
    })
    memory.close()
    index.close()
    const reopened = createMemoryStorage(directory)
    try {
      reopened.assertOwner('tenant-a')
      expect(reopened.revision()).toBe(1)
      expect(reopened.delivery('delivery')).toEqual({ fingerprint: 'fingerprint', output: { revision: 1 } })
      expect(reopened.pendingDeletions()).toEqual([receipt])
    } finally {
      reopened.close()
    }
    const foreign = createMemoryStorage(directory)
    expect(() => foreign.assertOwner('tenant-b')).toThrow('memory_scope_mismatch')
    foreign.close()
    const foreignIndex = createRetrievalStorage(directory)
    expect(() => foreignIndex.assertOwner('tenant-b')).toThrow('retrieval_scope_mismatch')
    foreignIndex.close()
  } finally {
    memory.close()
    index.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
