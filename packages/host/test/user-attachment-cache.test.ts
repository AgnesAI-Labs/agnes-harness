import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { attachmentReceiptFor, createAttachmentStore } from '../src/attachment-store.js'
import { createUserAttachmentReader } from '../src/user-attachment-cache.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const plenty = async () => 1024 ** 4
async function fresh() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agh-att-cache-'))
  dirs.push(dataDir)
  const store = createAttachmentStore({ dataDir })
  return { dataDir, store, reader: createUserAttachmentReader({ store, diskFree: plenty }) }
}
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const bytes = (text: string) => new TextEncoder().encode(text)
const copy = (o: {
  seq: number
  kind?: string
  index?: number
  rowId?: string
  text: string
  key?: string
}) => ({
  sessionKey: o.key ?? 'k',
  seq: o.seq,
  kind: o.kind ?? 'file',
  index: o.index ?? 1,
  rowId: o.rowId ?? `row-${o.seq}`,
  bytes: bytes(o.text),
  mimeType: 'text/plain',
})

describe('user attachment reader', () => {
  it('serves only objects the store marks as user attachments, refusing others as missing', async () => {
    const { store, reader } = await fresh()
    const generic = await store.put(bytes('spilled tool output'), {
      kind: 'request-version',
      mimeType: 'text/plain',
    })
    expect(await reader.isUserAttachment(generic.sha256)).toBe(false)
    await expect(reader.read(generic.sha256)).rejects.toMatchObject({ code: 'ATTACHMENT_MISSING' })
    await expect(reader.read(generic.sha256, { offset: 0, length: 4 })).rejects.toMatchObject({
      code: 'ATTACHMENT_MISSING',
    })
    // The same answer as for an object that is not there at all: no existence oracle.
    await expect(reader.read('f'.repeat(64))).rejects.toMatchObject({ code: 'ATTACHMENT_MISSING' })
    expect(await reader.isUserAttachment('not a digest')).toBe(false)
    const thumb = await store.put(bytes('thumb'), { kind: 'thumbnail', mimeType: 'image/jpeg' })
    await store.markUserAttachment(thumb, { mimeType: 'image/jpeg', receiptFor: 's' })
    expect(await reader.read(thumb.sha256)).toEqual(bytes('thumb'))
    expect(await reader.read(thumb.sha256, { offset: 1, length: 2 })).toEqual(bytes('hu'))
  })
})

describe('inline attachment cache', () => {
  it('keeps an inline copy in the store and maps its place and row in the session to it, on disk', async () => {
    const { dataDir, store, reader } = await fresh()
    const data = bytes('old inline file')
    const object = await reader.cacheInline?.(copy({ seq: 5, text: 'old inline file' }))
    expect(object).toEqual({ sha256: hex(data), bytes: data.byteLength })
    expect(await reader.read(hex(data))).toEqual(data)
    // Marked as a user attachment, but with no receipt: a cache copy authorizes nobody.
    expect(await store.userAttachment(hex(data))).toMatchObject({ mimeType: 'text/plain', receipts: [] })
    const file = join(dataDir, 'artifacts', 'user-attachment-cache', `${attachmentReceiptFor('k')}.json`)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ '5/file/1': { ...object, rowId: 'row-5' } })
    expect(await reader.cachedInline?.('k', 5, 'file', 1, 'row-5')).toEqual(object)
    expect(await reader.cachedInline?.('k', 5, 'image', 1, 'row-5')).toBeUndefined()
    expect(await reader.cachedInline?.('other', 5, 'file', 1, 'row-5')).toBeUndefined()
    // A seq reused by another row (an import, a rewritten session) never matches the old copy.
    expect(await reader.cachedInline?.('k', 5, 'file', 1, 'row-other')).toBeUndefined()
    // A second process (a new reader) finds it from the file.
    const again = createUserAttachmentReader({ store: createAttachmentStore({ dataDir }) })
    expect(await again.cachedInline?.('k', 5, 'file', 1, 'row-5')).toEqual(object)
    expect(
      (await readdir(join(dataDir, 'artifacts', 'user-attachment-cache'))).filter((n) => n.endsWith('.tmp')),
    ).toEqual([])
  })

  it('records every copy when several are kept at once, and leaves an existing marker as it is', async () => {
    const { store, reader } = await fresh()
    const uploaded = await store.put(bytes('uploaded elsewhere'), {
      kind: 'user-attachment',
      mimeType: 'text/plain',
    })
    await store.markUserAttachment(uploaded, { mimeType: 'text/plain', receiptFor: 'uploader' })
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        reader.cacheInline?.(copy({ seq: i + 1, text: i === 0 ? 'uploaded elsewhere' : `copy ${i}` })),
      ),
    )
    for (let i = 0; i < 8; i++)
      expect(await reader.cachedInline?.('k', i + 1, 'file', 1, `row-${i + 1}`)).toBeDefined()
    expect((await store.userAttachment(uploaded.sha256))?.receipts).toEqual([
      attachmentReceiptFor('uploader'),
    ])
  })

  it('skips the copy when the volume would be left with too little free space', async () => {
    const { store } = await fresh()
    const reader = createUserAttachmentReader({ store, minFreeBytes: 1000, diskFree: async () => 1005 })
    await expect(reader.cacheInline?.(copy({ seq: 1, text: 'too big' }))).rejects.toMatchObject({
      code: 'ATTACHMENT_TOO_LARGE',
    })
    expect(await store.stat(hex(bytes('too big')))).toBeUndefined()
    expect(await reader.cachedInline?.('k', 1, 'file', 1, 'row-1')).toBeUndefined()
    const roomy = createUserAttachmentReader({ store, minFreeBytes: 1000, diskFree: async () => 2000 })
    await expect(roomy.cacheInline?.(copy({ seq: 1, text: 'fits' }))).resolves.toBeDefined()
  })

  it('treats a damaged map as empty and refuses a malformed position', async () => {
    const { dataDir, store, reader } = await fresh()
    const dir = join(dataDir, 'artifacts', 'user-attachment-cache')
    await reader.cacheInline?.(copy({ seq: 1, kind: 'image', text: 'x' }))
    const file = join(dir, `${attachmentReceiptFor('k')}.json`)
    await writeFile(file, '{"1/image/1": {"sha256": "nope", "bytes": 1}, "../x": 1')
    expect(
      await createUserAttachmentReader({ store }).cachedInline?.('k', 1, 'image', 1, 'row-1'),
    ).toBeUndefined()
    // Readable JSON keeps only its well-formed entries.
    const good = { sha256: 'a'.repeat(64), bytes: 1, rowId: 'r' }
    await writeFile(
      file,
      JSON.stringify({
        '1/image/1': { sha256: 'nope', bytes: 1, rowId: 'r' },
        '2/file/1': { sha256: 'b'.repeat(64), bytes: -1, rowId: 'r' },
        '4/file/1': { sha256: 'b'.repeat(64), bytes: 1 },
        '../x/1': good,
        '3/file/1': good,
      }),
    )
    const reopened = createUserAttachmentReader({ store })
    expect(await reopened.cachedInline?.('k', 1, 'image', 1, 'r')).toBeUndefined()
    expect(await reopened.cachedInline?.('k', 2, 'file', 1, 'r')).toBeUndefined()
    expect(await reopened.cachedInline?.('k', 4, 'file', 1, 'r')).toBeUndefined()
    expect(await reopened.cachedInline?.('k', 3, 'file', 1, 'r')).toEqual({
      sha256: 'a'.repeat(64),
      bytes: 1,
    })
    await expect(reader.cacheInline?.(copy({ seq: 0, text: 'x' }))).rejects.toThrow(
      'invalid attachment position',
    )
    await expect(reader.cacheInline?.(copy({ seq: 1, kind: 'audio', text: 'x' }))).rejects.toThrow(
      'invalid attachment position',
    )
    await expect(reader.cacheInline?.(copy({ seq: 1, rowId: '', text: 'x' }))).rejects.toThrow(
      'invalid attachment position',
    )
    expect(await reader.cachedInline?.('k', 1, '../../x', 1, 'r')).toBeUndefined()
  })

  it('offers reads only when the inline cache is off', async () => {
    const { store } = await fresh()
    const reader = createUserAttachmentReader({ store, cacheInline: false })
    expect(reader.cacheInline).toBeUndefined()
    expect(reader.cachedInline).toBeUndefined()
    const object = await store.put(bytes('ref'), { kind: 'user-attachment', mimeType: 'text/plain' })
    await store.markUserAttachment(object, { mimeType: 'text/plain' })
    expect(await reader.read(object.sha256)).toEqual(bytes('ref'))
  })
})
