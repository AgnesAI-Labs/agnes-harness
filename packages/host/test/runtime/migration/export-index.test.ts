import { createHash } from 'node:crypto'
import { jcs } from '@agnes/protocol'
import type { AuthorityExportPart, BlobRef, DataRef } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  ASSET_INDEX,
  buildExportIndex,
  compareIndexKeys,
  decodeIndexCursor,
  EXPORT_INDEX,
  encodeIndexCursor,
  exportIndexPage,
  INDEX_MAX_BYTES,
  type IndexItem,
  type IndexStorage,
  initialIndexCheckpoint,
  verifyExportIndex,
  verifyIndexItemBytes,
  walkExportIndex,
} from '../../../src/runtime/migration/export-index.js'

const digest = 'ab'.repeat(32)
export function part(partIndex: number, collectionId = 'events'): AuthorityExportPart {
  return {
    collectionId,
    partIndex,
    schema: { typeId: 'agh.state/events@1', revision: 1, digest },
    firstRecordKey: `record-${partIndex}`,
    lastRecordKey: `record-${partIndex}`,
    records: 1,
    contentDigest: digest,
    chunk: {
      authorityId: 'state',
      blobId: `chunk-${partIndex}`,
      digest,
      bytes: 512,
      mediaType: 'application/json',
      pinId: 'pin',
    },
  }
}
export async function* rows(items: Iterable<IndexItem>): AsyncGenerator<IndexItem> {
  yield* items
}
export function memoryStorage() {
  const blobs = new Map<string, Buffer>()
  const storage: IndexStorage = {
    async put(bytes, typeId) {
      const body = Buffer.from(bytes),
        hash = createHash('sha256').update(body).digest('hex')
      blobs.set(hash, body)
      return {
        kind: 'blob',
        schema: { typeId, revision: 1, digest },
        blob: {
          authorityId: 'index',
          blobId: hash,
          digest: hash,
          bytes: body.length,
          mediaType: 'application/json',
          pinId: 'index-pin',
        },
      }
    },
    async *read(blob: BlobRef) {
      const body = blobs.get(blob.digest)
      if (!body) throw new Error('missing page')
      for (let offset = 0; offset < body.length; offset += 65536) yield body.subarray(offset, offset + 65536)
    },
  }
  return { storage, blobs }
}
async function collect(root: DataRef, type: typeof EXPORT_INDEX | typeof ASSET_INDEX, storage: IndexStorage) {
  const result: IndexItem[] = []
  for await (const row of walkExportIndex(root, type, storage)) result.push(row.item)
  return result
}

describe('bounded migration indexes', () => {
  it('orders UTF-8 collection IDs and numeric parts, bounds every page, and binds cursors to the fence and manifest', async () => {
    const { storage, blobs } = memoryStorage()
    const parts = Array.from({ length: 1001 }, (_, index) => part(index))
    const root = await buildExportIndex(EXPORT_INDEX, rows(parts), storage)
    expect(await collect(root, EXPORT_INDEX, storage)).toEqual(parts)
    for (const bytes of blobs.values()) {
      expect(bytes.length).toBeLessThanOrEqual(INDEX_MAX_BYTES)
      expect((JSON.parse(bytes.toString()) as { entries: unknown[] }).entries.length).toBeLessThanOrEqual(500)
    }
    expect(compareIndexKeys(EXPORT_INDEX, JSON.stringify(['é', 0]), JSON.stringify(['😀', 0]))).toBeLessThan(
      0,
    )
    expect(
      compareIndexKeys(EXPORT_INDEX, JSON.stringify(['events', 2]), JSON.stringify(['events', 10])),
    ).toBeLessThan(0)
    const nearEnd = await exportIndexPage(
      root,
      EXPORT_INDEX,
      digest,
      encodeIndexCursor({
        ...initialIndexCheckpoint(root, EXPORT_INDEX, digest),
        consumed: 1000,
        after: '["events",999]',
      }),
      2,
      storage,
    )
    expect(nearEnd.items).toEqual([part(1000)])
    let cursor: string | null = null,
      count = 0
    do {
      const page = await exportIndexPage(root, EXPORT_INDEX, digest, cursor, 500, storage)
      expect(Buffer.byteLength(jcs(page))).toBeLessThanOrEqual(INDEX_MAX_BYTES)
      count += page.items.length
      cursor = page.nextCursor
      expect(page.complete).toBe(cursor === null)
    } while (cursor)
    expect(count).toBe(1001)
    const first = await exportIndexPage(root, EXPORT_INDEX, digest, null, 2, storage)
    await expect(
      exportIndexPage(root, EXPORT_INDEX, 'cd'.repeat(32), first.nextCursor, 2, storage),
    ).rejects.toMatchObject({ detailCode: 'cursor_invalid' })
    const other = await buildExportIndex(EXPORT_INDEX, rows([part(99)]), storage)
    await expect(
      exportIndexPage(other, EXPORT_INDEX, digest, first.nextCursor, 2, storage),
    ).rejects.toMatchObject({ detailCode: 'cursor_invalid' })
    const checkpoint = initialIndexCheckpoint(root, EXPORT_INDEX, digest)
    expect(() => decodeIndexCursor('bad', checkpoint)).toThrow()
    await expect(
      exportIndexPage(
        root,
        EXPORT_INDEX,
        digest,
        encodeIndexCursor({ ...checkpoint, consumed: 2, after: '["events",99]' }),
        2,
        storage,
      ),
    ).rejects.toMatchObject({ detailCode: 'checkpoint_invalid' })
    await expect(exportIndexPage(root, EXPORT_INDEX, digest, null, 501, storage)).rejects.toMatchObject({
      detailCode: 'page_limit',
    })
  })

  it('rejects missing pages, changed digest, false child counts and duplicate/unsorted parts', async () => {
    for (const mode of ['missing', 'digest', 'count', 'duplicate'] as const) {
      const { storage, blobs } = memoryStorage()
      let root = await buildExportIndex(
        EXPORT_INDEX,
        rows(Array.from({ length: 501 }, (_, index) => part(index))),
        storage,
      )
      const node = JSON.parse(
        blobs.get(root.kind === 'blob' ? root.blob.digest : root.digest)!.toString(),
      ) as {
        typeId: string
        level: number
        entries: { child: DataRef; count: number }[]
      }
      const child = node.entries[0]!.child
      const childDigest = child.kind === 'blob' ? child.blob.digest : child.digest
      if (mode === 'missing') blobs.delete(childDigest)
      if (mode === 'digest') blobs.set(childDigest, Buffer.from('{}'))
      if (mode === 'count') {
        node.entries[0]!.count++
        root = await storage.put(Buffer.from(jcs(node)), EXPORT_INDEX)
      }
      if (mode === 'duplicate') {
        node.entries[1] = node.entries[0]!
        root = await storage.put(Buffer.from(jcs(node)), EXPORT_INDEX)
      }
      await expect(collect(root, EXPORT_INDEX, storage)).rejects.toThrow()
    }
    for (const items of [
      [part(0), part(0)],
      [part(2), part(1)],
    ]) {
      await expect(
        buildExportIndex(EXPORT_INDEX, rows(items), memoryStorage().storage),
      ).rejects.toMatchObject({ detailCode: 'duplicate_or_unsorted' })
    }
    const bytes = Buffer.from('actual immutable chunk bytes')
    const actual = part(0)
    actual.contentDigest = createHash('sha256').update(bytes).digest('hex')
    actual.chunk = { ...actual.chunk, digest: actual.contentDigest, bytes: bytes.length }
    const reader = {
      async *read() {
        yield bytes.subarray(0, 5)
        yield bytes.subarray(5)
      },
    }
    await expect(verifyIndexItemBytes(EXPORT_INDEX, actual, reader)).resolves.toBeUndefined()
    await expect(
      verifyIndexItemBytes(EXPORT_INDEX, actual, {
        async *read() {
          yield Buffer.from('bad')
        },
      }),
    ).rejects.toMatchObject({ detailCode: 'bad_digest' })
    const bad = part(0)
    bad.contentDigest = 'cd'.repeat(32)
    await expect(buildExportIndex(EXPORT_INDEX, rows([bad]), memoryStorage().storage)).rejects.toMatchObject({
      detailCode: 'part_content',
    })
  })

  it('resumes after an accepted checkpoint, detects false positions, and encodes empty indexes as leaves', async () => {
    const { storage } = memoryStorage()
    const root = await buildExportIndex(EXPORT_INDEX, rows([part(0), part(1), part(2)]), storage)
    let checkpoint = initialIndexCheckpoint(root, EXPORT_INDEX, digest)
    await expect(
      verifyExportIndex(root, checkpoint, storage, async (_item, next) => {
        if (next.consumed === 2) throw new Error('interrupt before acceptance')
        checkpoint = next
      }),
    ).rejects.toThrow('interrupt')
    const accepted: IndexItem[] = []
    const final = await verifyExportIndex(
      root,
      JSON.parse(JSON.stringify(checkpoint)) as typeof checkpoint,
      storage,
      async (item) => {
        accepted.push(item)
      },
    )
    expect(accepted).toEqual([part(1), part(2)])
    expect(final.consumed).toBe(3)
    await expect(
      verifyExportIndex(root, { ...final, consumed: 4 }, storage, async () => {}),
    ).rejects.toMatchObject({ detailCode: 'checkpoint_invalid' })
    const empty = await buildExportIndex(EXPORT_INDEX, rows([]), storage)
    expect(await collect(empty, EXPORT_INDEX, storage)).toEqual([])
  })

  it('spills an oversized asset item into a blob, while a paginated asset remains a typed data reference', async () => {
    const { storage, blobs } = memoryStorage()
    const asset: DataRef = {
      kind: 'blob',
      schema: { typeId: 'agh.example/asset@1', revision: 1, digest },
      blob: {
        authorityId: 'asset',
        blobId: 'large-descriptor',
        digest,
        bytes: 123,
        mediaType: 'x'.repeat(INDEX_MAX_BYTES - 1000),
        pinId: 'asset-pin',
      },
    }
    const root = await buildExportIndex(ASSET_INDEX, rows([asset]), storage)
    expect(await collect(root, ASSET_INDEX, storage)).toEqual([asset])
    const node = JSON.parse(blobs.get(root.kind === 'blob' ? root.blob.digest : root.digest)!.toString()) as {
      entries: { itemRef?: DataRef }[]
    }
    expect(node.entries[0]!.itemRef?.kind).toBe('blob')
    const readOnly = {
      ...storage,
      async put(): Promise<DataRef> {
        throw new Error('Paging must reuse persisted descriptors')
      },
    }
    const page = await exportIndexPage(root, ASSET_INDEX, digest, null, 500, readOnly)
    expect(await exportIndexPage(root, ASSET_INDEX, digest, null, 500, readOnly)).toEqual(page)
    const ref = page.items[0] as DataRef
    expect(ref.kind).toBe('blob')
    expect(ref.schema.typeId).toBe('agh.migration/asset-index-item@1')
    expect(ref.kind === 'blob' && ref.blob.digest).toBe(createHash('sha256').update(jcs(asset)).digest('hex'))
    expect(Buffer.byteLength(jcs(page))).toBeLessThanOrEqual(INDEX_MAX_BYTES)
  })
})
