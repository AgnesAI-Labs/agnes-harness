import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AttachmentStoreError,
  attachmentDeadlineMs,
  attachmentReceiptFor,
  createAttachmentStore,
} from '../src/attachment-store.js'

const dirs: string[] = []
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-store-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff)

describe('attachment store', () => {
  it('stages in order, commits to the content address and deduplicates', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const body = bytes(3 * 1024 * 1024 + 7)
    const staging = await store.stage({ kind: 'user-attachment', mimeType: 'application/zip' })
    for (let at = 0; at < body.length; at += 1024 * 1024)
      await staging.write(body.subarray(at, at + 1024 * 1024))
    expect(staging.bytes).toBe(body.length)
    const object = await staging.commit(sha(body))
    expect(object).toEqual({ sha256: sha(body), bytes: body.length })
    const path = join(dataDir, 'artifacts', 'sha256', object.sha256.slice(0, 2), object.sha256)
    expect(statSync(path).size).toBe(body.length)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(await store.put(body, { kind: 'user-attachment', mimeType: 'application/zip' })).toEqual(object)
    expect(readdirSync(join(dataDir, 'artifacts', 'staging'))).toEqual([])
  })

  it('refuses a digest mismatch and leaves nothing behind', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const staging = await store.stage({ kind: 'user-attachment', mimeType: 'image/png' })
    await staging.write(bytes(10))
    await expect(staging.commit('0'.repeat(64))).rejects.toMatchObject({ code: 'ATTACHMENT_HASH_MISMATCH' })
    expect(readdirSync(join(dataDir, 'artifacts', 'staging'))).toEqual([])
    await expect(staging.write(bytes(1))).rejects.toMatchObject({ code: 'ATTACHMENT_STAGE_CLOSED' })
  })

  it('enforces maxBytes while writing', async () => {
    const store = createAttachmentStore({ dataDir: fresh() })
    const staging = await store.stage({ kind: 'user-attachment', mimeType: 'image/png', maxBytes: 8 })
    await expect(staging.write(bytes(9))).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' })
  })

  it('reads ranges, verifies whole reads and reports corruption', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir, verifyOnceAtBytes: 1024 })
    const small = bytes(100)
    const big = bytes(4096, 7)
    const a = await store.put(small, { kind: 'user-attachment', mimeType: 'image/png' })
    const b = await store.put(big, { kind: 'user-attachment', mimeType: 'application/zip' })
    expect(Array.from(await store.read(b.sha256, { offset: 10, length: 5 }))).toEqual(
      Array.from(big.subarray(10, 15)),
    )
    expect(await store.read(a.sha256)).toEqual(small)
    writeFileSync(join(dataDir, 'artifacts', 'sha256', a.sha256.slice(0, 2), a.sha256), bytes(100, 9))
    await expect(store.read(a.sha256)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    await expect(store.read('f'.repeat(64))).rejects.toMatchObject({ code: 'ATTACHMENT_MISSING' })
    await expect(store.read('../x')).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID_ID' })
    expect(await store.stat(b.sha256)).toEqual(b)
  })

  it('verifies a large object once per process until its file identity changes', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir, verifyOnceAtBytes: 1024 })
    const big = bytes(4096, 3)
    const b = await store.put(big, { kind: 'user-attachment', mimeType: 'application/zip' })
    await store.read(b.sha256)
    const path = join(dataDir, 'artifacts', 'sha256', b.sha256.slice(0, 2), b.sha256)
    rmSync(path)
    writeFileSync(path, bytes(4096, 4))
    await expect(store.read(b.sha256)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })

  it('records user attachment markers with merged receipts', async () => {
    const dataDir = fresh()
    let now = 1_000
    const store = createAttachmentStore({ dataDir, clock: () => now })
    const object = await store.put(bytes(5), { kind: 'user-attachment', mimeType: 'image/png' })
    await store.markUserAttachment(object, { mimeType: 'image/png', receiptFor: 'session-a' })
    now = 2_000
    await store.markUserAttachment(object, { mimeType: 'image/png', receiptFor: 'session-b' })
    await store.markUserAttachment(object, { mimeType: 'image/png', receiptFor: 'session-a' })
    expect(await store.userAttachment(object.sha256)).toEqual({
      schemaVersion: 1,
      sha256: object.sha256,
      bytes: 5,
      mimeType: 'image/png',
      firstSeenMs: 1_000,
      receipts: [attachmentReceiptFor('session-a'), attachmentReceiptFor('session-b')],
    })
  })

  it('sweeps staging files older than a day and computes deadlines', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    await (await store.stage({ kind: 'user-attachment', mimeType: 'image/png' })).write(bytes(3))
    expect(await store.sweepStaging(Date.now())).toBe(0)
    expect(await store.sweepStaging(Date.now() + 25 * 60 * 60 * 1000)).toBe(1)
    expect(existsSync(join(dataDir, 'artifacts', 'staging'))).toBe(true)
    expect(readdirSync(join(dataDir, 'artifacts', 'staging'))).toEqual([])
    expect([attachmentDeadlineMs(0), attachmentDeadlineMs(100 * 1024 * 1024)]).toEqual([10_000, 200_000])
    expect(new AttachmentStoreError('ATTACHMENT_MISSING').code).toBe('ATTACHMENT_MISSING')
  })

  it('bounds a stalled write, discards the staging file and reports a timeout', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir, deadlineMs: () => 20 })
    const probe = await open(join(dataDir, 'probe'), 'w')
    const stall = vi
      .spyOn(Object.getPrototypeOf(probe), 'write')
      .mockImplementation(() => new Promise(() => undefined))
    await probe.close()
    try {
      const staging = await store.stage({ kind: 'user-attachment', mimeType: 'application/zip' })
      await expect(staging.write(bytes(16))).rejects.toMatchObject({ code: 'ATTACHMENT_TIMEOUT' })
      await expect(staging.write(bytes(1))).rejects.toMatchObject({ code: 'ATTACHMENT_STAGE_CLOSED' })
      expect(readdirSync(join(dataDir, 'artifacts', 'staging'))).toEqual([])
    } finally {
      stall.mockRestore()
    }
  })

  it('reports an unreadable user attachment marker as corrupt', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const object = await store.put(bytes(5), { kind: 'user-attachment', mimeType: 'image/png' })
    await store.markUserAttachment(object, { mimeType: 'image/png' })
    writeFileSync(
      join(dataDir, 'artifacts', 'user-attachment-meta', object.sha256.slice(0, 2), `${object.sha256}.json`),
      '{',
    )
    await expect(store.userAttachment(object.sha256)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })
})
