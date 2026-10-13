import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { attachmentReceiptFor, createAttachmentStore } from '../src/attachment-store.js'
import {
  ATTACHMENT_LIMIT_DEFAULTS,
  attachmentLimit,
  createUserAttachmentPort,
} from '../src/user-attachments.js'

const dirs: string[] = []
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-user-att-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff)
const plenty = async () => Number.MAX_SAFE_INTEGER
const objectFiles = (dataDir: string) => {
  const root = join(dataDir, 'artifacts', 'sha256')
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((shard) => readdirSync(join(root, shard)))
}
const signal = new AbortController().signal
const input = (b: Uint8Array, sessionBytes = 0) => ({
  bytes: b,
  mimeType: 'application/zip',
  sessionKey: 'k',
  sessionBytes,
})

describe('user attachment port', () => {
  it('stores the bytes once and marks them as a user attachment', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const port = createUserAttachmentPort({ store, limits: {}, storeByReference: true, diskFree: plenty })
    const b = bytes(1000)
    const ref = await port.store(input(b), signal)
    expect(ref).toEqual({ sha256: sha(b), bytes: 1000 })
    expect(await store.stat(sha(b))).toEqual({ sha256: sha(b), bytes: 1000 })
    expect(await store.userAttachment(sha(b))).toMatchObject({
      sha256: sha(b),
      bytes: 1000,
      mimeType: 'application/zip',
      receipts: [],
    })
    expect(Buffer.from(await port.read(sha(b)))).toEqual(Buffer.from(b))
    expect(await port.store(input(b), signal)).toEqual(ref)
    expect(objectFiles(dataDir)).toEqual([sha(b)])
    expect(await port.usage()).toBe(1000)
  })

  it('reads through the user attachment reader: unmarked objects are missing, and the inline cache is offered on request', async () => {
    const store = createAttachmentStore({ dataDir: fresh() })
    const port = createUserAttachmentPort({ store, limits: {}, storeByReference: false, diskFree: plenty })
    const generic = await store.put(bytes(64), { kind: 'request-version', mimeType: 'text/plain' })
    expect(await port.isUserAttachment(generic.sha256)).toBe(false)
    await expect(port.read(generic.sha256)).rejects.toMatchObject({ code: 'ATTACHMENT_MISSING' })
    await expect(port.read(generic.sha256, { offset: 0, length: 8 })).rejects.toMatchObject({
      code: 'ATTACHMENT_MISSING',
    })
    expect(port.cacheInline).toBeUndefined()
    expect(port.cachedInline).toBeUndefined()
    const cached = createUserAttachmentPort({
      store,
      limits: {},
      storeByReference: false,
      cacheInline: true,
      diskFree: plenty,
    })
    expect(typeof cached.cacheInline).toBe('function')
    expect(typeof cached.cachedInline).toBe('function')
  })

  it('authorizes only the session holding an upload receipt, or one that already references it', async () => {
    const store = createAttachmentStore({ dataDir: fresh() })
    const port = createUserAttachmentPort({ store, limits: {}, storeByReference: true, diskFree: plenty })
    const b = bytes(64)
    const object = await store.put(b, { kind: 'user-attachment', mimeType: 'application/zip' })
    await store.markUserAttachment(object, { mimeType: 'application/zip', receiptFor: 'k' })
    const ask = (
      sessionKey: string,
      referenced = false,
      over: Partial<{ sha256: string; bytes: number }> = {},
    ) =>
      port.authorize({
        sha256: sha(b),
        bytes: 64,
        mimeType: 'application/zip',
        sessionKey,
        referenced,
        ...over,
      })
    expect(await ask('k')).toBe('ok')
    expect(await ask('other')).toBe('unauthorized')
    expect(await ask('other', true)).toBe('ok')
    expect(await ask('k', false, { bytes: 65 })).toBe('missing')
    expect(await ask('k', true, { sha256: 'f'.repeat(64) })).toBe('missing')
    // Without a claim on it, an absent object reads the same as someone else's: no probing the store.
    expect(await ask('k', false, { sha256: 'f'.repeat(64) })).toBe('unauthorized')
    // An object that is stored but was never marked as a user attachment is nobody's to reference.
    const plain = await store.put(bytes(10, 9), { kind: 'request-version', mimeType: 'image/png' })
    expect(
      await port.authorize({ ...plain, mimeType: 'image/png', sessionKey: 'k', referenced: false }),
    ).toBe('unauthorized')
    expect((await store.userAttachment(sha(b)))?.receipts).toEqual([attachmentReceiptFor('k')])
  })

  it('refuses past the session quota and leaves no object behind', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const port = createUserAttachmentPort({
      store,
      limits: { 'attachments.session_quota_bytes': 1000 },
      storeByReference: true,
      diskFree: plenty,
    })
    await expect(port.store(input(bytes(600), 500), signal)).rejects.toMatchObject({ code: 'UPLOAD_QUOTA' })
    expect(objectFiles(dataDir)).toEqual([])
    await expect(port.store(input(bytes(500), 500), signal)).resolves.toMatchObject({ bytes: 500 })
  })

  it('refuses past the global quota, counted from the markers when the port starts', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const limits = { 'attachments.global_quota_bytes': 1000 }
    const first = createUserAttachmentPort({ store, limits, storeByReference: true, diskFree: plenty })
    await first.store(input(bytes(700)), signal)
    expect(await first.usage()).toBe(700)
    // A new port (a restart) rebuilds the total from the marker directory.
    const second = createUserAttachmentPort({ store, limits, storeByReference: true, diskFree: plenty })
    expect(await second.usage()).toBe(700)
    await expect(second.store(input(bytes(400, 2)), signal)).rejects.toMatchObject({ code: 'UPLOAD_QUOTA' })
    expect(objectFiles(dataDir)).toHaveLength(1)
    await expect(second.store(input(bytes(300, 3)), signal)).resolves.toMatchObject({ bytes: 300 })
    expect(await second.usage()).toBe(1000)
    // Bytes already stored are not counted twice and need no room.
    await expect(second.store(input(bytes(700)), signal)).resolves.toMatchObject({ bytes: 700 })
    expect(await second.usage()).toBe(1000)
  })

  it('applies the session quota to bytes that are already stored', async () => {
    const store = createAttachmentStore({ dataDir: fresh() })
    const port = createUserAttachmentPort({
      store,
      limits: { 'attachments.session_quota_bytes': 1000 },
      storeByReference: true,
      diskFree: plenty,
    })
    await port.store(input(bytes(600)), signal)
    // Another session already stored these bytes; this one has no room for them all the same.
    await expect(port.store(input(bytes(600), 500), signal)).rejects.toMatchObject({ code: 'UPLOAD_QUOTA' })
  })

  it('lets only one of two concurrent writes take the last room', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const port = createUserAttachmentPort({
      store,
      limits: { 'attachments.global_quota_bytes': 1000 },
      storeByReference: true,
      diskFree: plenty,
    })
    const results = await Promise.allSettled([
      port.store(input(bytes(600, 1)), signal),
      port.store(input(bytes(600, 2)), signal),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(objectFiles(dataDir)).toHaveLength(1)
    expect(await port.usage()).toBe(600)
  })

  it('refuses when the write would leave less than the free-space floor', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    let free = 2_000 + 999
    const port = createUserAttachmentPort({
      store,
      limits: { 'attachments.min_free_bytes': 2_000 },
      storeByReference: true,
      diskFree: async () => free,
    })
    await expect(port.store(input(bytes(1000)), signal)).rejects.toMatchObject({ code: 'UPLOAD_QUOTA' })
    expect(objectFiles(dataDir)).toEqual([])
    free = 3_000
    await expect(port.store(input(bytes(1000)), signal)).resolves.toMatchObject({ bytes: 1000 })
  })

  it('refuses one attachment above the upload size limit', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const port = createUserAttachmentPort({
      store,
      limits: { 'attachments.max_upload_bytes': 100 },
      storeByReference: true,
      diskFree: plenty,
    })
    await expect(port.store(input(bytes(101)), signal)).rejects.toMatchObject({ code: 'UPLOAD_QUOTA' })
    expect(objectFiles(dataDir)).toEqual([])
  })

  it('reads the five limits with their defaults', () => {
    const GIB = 1024 ** 3
    expect(ATTACHMENT_LIMIT_DEFAULTS).toEqual({
      'attachments.max_upload_bytes': 2 * GIB,
      'attachments.session_quota_bytes': 8 * GIB,
      'attachments.global_quota_bytes': 64 * GIB,
      'attachments.min_free_bytes': 2 * GIB,
      'attachments.orphan_grace_ms': 7 * 24 * 60 * 60 * 1000,
    })
    expect(attachmentLimit({}, 'attachments.max_upload_bytes')).toBe(2 * GIB)
    expect(attachmentLimit({ 'attachments.max_upload_bytes': 5 }, 'attachments.max_upload_bytes')).toBe(5)
    expect(attachmentLimit({ 'attachments.max_upload_bytes': -1 }, 'attachments.max_upload_bytes')).toBe(
      2 * GIB,
    )
    expect(attachmentLimit({ 'attachments.max_upload_bytes': 1.5 }, 'attachments.max_upload_bytes')).toBe(
      2 * GIB,
    )
  })
})

describe('user attachment markers across processes', () => {
  it('a receipt-less mark leaves a damaged marker for the next receipt to repair', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const b = bytes(32)
    const object = await store.put(b, { kind: 'user-attachment', mimeType: 'application/zip' })
    await store.markUserAttachment(object, { mimeType: 'application/zip' })
    const marker = join(dataDir, 'artifacts', 'user-attachment-meta', sha(b).slice(0, 2), `${sha(b)}.json`)
    writeFileSync(marker, '{')
    await store.markUserAttachment(object, { mimeType: 'application/zip' })
    expect(readFileSync(marker, 'utf8')).toBe('{')
    await store.markUserAttachment(object, { mimeType: 'application/zip', receiptFor: 'k' })
    expect((await store.userAttachment(sha(b)))?.receipts).toEqual([attachmentReceiptFor('k')])
  })

  it('a mark without a receipt never replaces a marker another process wrote', async () => {
    const dataDir = fresh()
    // Two stores over one directory stand in for the upload process and a session worker.
    const uploads = createAttachmentStore({ dataDir })
    const worker = createAttachmentStore({ dataDir })
    const b = bytes(32)
    const object = await uploads.put(b, { kind: 'user-attachment', mimeType: 'application/zip' })
    await uploads.markUserAttachment(object, { mimeType: 'application/zip', receiptFor: 'k' })
    await worker.markUserAttachment(object, { mimeType: 'application/zip' })
    expect((await worker.userAttachment(sha(b)))?.receipts).toEqual([attachmentReceiptFor('k')])
  })

  it('concurrent receipt-less marks from many stores leave one well-formed marker', async () => {
    const dataDir = fresh()
    const stores = Array.from({ length: 8 }, () => createAttachmentStore({ dataDir }))
    const b = bytes(32)
    const [first] = stores
    if (!first) throw new Error('no store')
    const object = await first.put(b, { kind: 'user-attachment', mimeType: 'application/zip' })
    await Promise.all(stores.map((s) => s.markUserAttachment(object, { mimeType: 'application/zip' })))
    expect(await first.userAttachment(sha(b))).toMatchObject({ sha256: sha(b), bytes: 32, receipts: [] })
    const shard = join(dataDir, 'artifacts', 'user-attachment-meta', sha(b).slice(0, 2))
    expect(readdirSync(shard)).toEqual([`${sha(b)}.json`])
  })
})
