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
async function fresh() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agh-att-cache-'))
  dirs.push(dataDir)
  const store = createAttachmentStore({ dataDir })
  return { dataDir, store, reader: createUserAttachmentReader({ store }) }
}
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const bytes = (text: string) => new TextEncoder().encode(text)

describe('user attachment reader and inline cache', () => {
  it('keeps an inline copy in the store and maps its place in the session to it, on disk', async () => {
    const { dataDir, store, reader } = await fresh()
    const data = bytes('old inline file')
    const object = await reader.cacheInline?.({
      sessionKey: 'k',
      seq: 5,
      kind: 'file',
      index: 1,
      bytes: data,
      mimeType: 'text/plain',
    })
    expect(object).toEqual({ sha256: hex(data), bytes: data.byteLength })
    expect(await store.read(hex(data))).toEqual(data)
    // Marked as a user attachment, but with no receipt: a cache copy authorizes nobody.
    expect(await store.userAttachment(hex(data))).toMatchObject({ mimeType: 'text/plain', receipts: [] })
    const file = join(dataDir, 'artifacts', 'user-attachment-cache', `${attachmentReceiptFor('k')}.json`)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ '5/file/1': object })
    expect(await reader.cachedInline?.('k', 5, 'file', 1)).toEqual(object)
    expect(await reader.cachedInline?.('k', 5, 'image', 1)).toBeUndefined()
    expect(await reader.cachedInline?.('other', 5, 'file', 1)).toBeUndefined()
    // A second process (a new reader) finds it from the file.
    const again = createUserAttachmentReader({ store: createAttachmentStore({ dataDir }) })
    expect(await again.cachedInline?.('k', 5, 'file', 1)).toEqual(object)
    // No temporary file is left behind.
    expect(
      (await readdir(join(dataDir, 'artifacts', 'user-attachment-cache'))).filter((n) => n.endsWith('.tmp')),
    ).toEqual([])
  })

  it('records every copy when several are kept at once, and leaves an existing marker as it is', async () => {
    const { store, reader } = await fresh()
    const shared = bytes('uploaded elsewhere')
    const uploaded = await store.put(shared, { kind: 'user-attachment', mimeType: 'text/plain' })
    await store.markUserAttachment(uploaded, { mimeType: 'text/plain', receiptFor: 'uploader' })
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        reader.cacheInline?.({
          sessionKey: 'k',
          seq: i + 1,
          kind: 'file',
          index: 1,
          bytes: i === 0 ? shared : bytes(`copy ${i}`),
          mimeType: 'text/plain',
        }),
      ),
    )
    for (let i = 0; i < 8; i++) expect(await reader.cachedInline?.('k', i + 1, 'file', 1)).toBeDefined()
    expect((await store.userAttachment(uploaded.sha256))?.receipts).toEqual([
      attachmentReceiptFor('uploader'),
    ])
  })

  it('treats a damaged map as empty and refuses a malformed position', async () => {
    const { dataDir, store, reader } = await fresh()
    const dir = join(dataDir, 'artifacts', 'user-attachment-cache')
    await reader.cacheInline?.({
      sessionKey: 'k',
      seq: 1,
      kind: 'image',
      index: 1,
      bytes: bytes('x'),
      mimeType: 'image/png',
    })
    const file = join(dir, `${attachmentReceiptFor('k')}.json`)
    await writeFile(file, '{"1/image/1": {"sha256": "nope", "bytes": 1}, "../x": 1')
    expect(await createUserAttachmentReader({ store }).cachedInline?.('k', 1, 'image', 1)).toBeUndefined()
    // Readable JSON keeps only its well-formed entries.
    const good = { sha256: 'a'.repeat(64), bytes: 1 }
    await writeFile(
      file,
      JSON.stringify({
        '1/image/1': { sha256: 'nope', bytes: 1 },
        '2/file/1': { sha256: 'b'.repeat(64), bytes: -1 },
        '../x/1': good,
        '3/file/1': good,
      }),
    )
    const reopened = createUserAttachmentReader({ store })
    expect(await reopened.cachedInline?.('k', 1, 'image', 1)).toBeUndefined()
    expect(await reopened.cachedInline?.('k', 2, 'file', 1)).toBeUndefined()
    expect(await reopened.cachedInline?.('k', 3, 'file', 1)).toEqual(good)
    await expect(
      reader.cacheInline?.({
        sessionKey: 'k',
        seq: 0,
        kind: 'file',
        index: 1,
        bytes: bytes('x'),
        mimeType: 'text/plain',
      }),
    ).rejects.toThrow('invalid attachment position')
    await expect(
      reader.cacheInline?.({
        sessionKey: 'k',
        seq: 1,
        kind: 'audio',
        index: 1,
        bytes: bytes('x'),
        mimeType: 'text/plain',
      }),
    ).rejects.toThrow('invalid attachment position')
    expect(await reader.cachedInline?.('k', 1, '../../x', 1)).toBeUndefined()
  })

  it('offers reads only when the inline cache is off', async () => {
    const { store } = await fresh()
    const reader = createUserAttachmentReader({ store, cacheInline: false })
    expect(reader.cacheInline).toBeUndefined()
    expect(reader.cachedInline).toBeUndefined()
    const object = await store.put(bytes('ref'), { kind: 'user-attachment', mimeType: 'text/plain' })
    expect(await reader.read(object.sha256)).toEqual(bytes('ref'))
    await expect(reader.read('f'.repeat(64))).rejects.toMatchObject({ code: 'ATTACHMENT_MISSING' })
  })
})
