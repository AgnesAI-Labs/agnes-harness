import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AttachmentStoreError,
  attachmentDeadlineMs,
  attachmentReceiptFor,
  createAttachmentStore,
  createAttachmentStoreInternal,
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
    const store = createAttachmentStoreInternal({ dataDir, verifyOnceAtBytes: 1024 })
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
    const store = createAttachmentStoreInternal({ dataDir, verifyOnceAtBytes: 1024 })
    const big = bytes(4096, 3)
    const b = await store.put(big, { kind: 'user-attachment', mimeType: 'application/zip' })
    await store.read(b.sha256)
    const path = join(dataDir, 'artifacts', 'sha256', b.sha256.slice(0, 2), b.sha256)
    // Same size, explicit different mtime: the identity changes without relying on clock resolution.
    writeFileSync(path, bytes(4096, 4))
    utimesSync(path, new Date(1_000), new Date(1_000))
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
      // The marker was last rewritten when session-b's receipt was added.
      lastSeenMs: 2_000,
      receipts: [attachmentReceiptFor('session-a'), attachmentReceiptFor('session-b')],
    })
  })

  it('sweeps staging files older than a day and computes deadlines', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const leftover = await store.stage({ kind: 'user-attachment', mimeType: 'image/png' })
    await leftover.write(bytes(3))
    expect(await store.sweepStaging(Date.now())).toBe(0)
    expect(await store.sweepStaging(Date.now() + 25 * 60 * 60 * 1000)).toBe(1)
    expect(existsSync(join(dataDir, 'artifacts', 'staging'))).toBe(true)
    expect(readdirSync(join(dataDir, 'artifacts', 'staging'))).toEqual([])
    await leftover.abort()
    expect([attachmentDeadlineMs(0), attachmentDeadlineMs(100 * 1024 * 1024)]).toEqual([10_000, 200_000])
    expect(new AttachmentStoreError('ATTACHMENT_MISSING').code).toBe('ATTACHMENT_MISSING')
  })

  it('bounds a write whose handle never settles, even when closing it never settles', async () => {
    const dataDir = fresh()
    const store = createAttachmentStoreInternal({ dataDir, deadlineMs: () => 20 })
    const probe = await open(join(dataDir, 'probe'), 'w')
    const proto = Object.getPrototypeOf(probe)
    const held: { handle: { close: () => Promise<void> }; close: () => Promise<void> }[] = []
    // The first write on the staging handle never settles, and neither does closing that handle.
    const stall = vi.spyOn(proto, 'write').mockImplementation(function (this: {
      close: () => Promise<void>
    }) {
      if (!held.some((entry) => entry.handle === this)) {
        held.push({ handle: this, close: this.close })
        this.close = () => new Promise(() => undefined)
      }
      return new Promise(() => undefined)
    })
    try {
      const staging = await store.stage({ kind: 'user-attachment', mimeType: 'application/zip' })
      expect(readdirSync(join(dataDir, 'artifacts', 'staging'))).toHaveLength(1)
      await expect(staging.write(bytes(16))).rejects.toMatchObject({ code: 'ATTACHMENT_TIMEOUT' })
      await expect(staging.write(bytes(1))).rejects.toMatchObject({ code: 'ATTACHMENT_STAGE_CLOSED' })
      expect(readdirSync(join(dataDir, 'artifacts', 'staging'))).toEqual([])
    } finally {
      stall.mockRestore()
      for (const entry of held) {
        entry.handle.close = entry.close
        await entry.close()
      }
      await probe.close()
    }
  })

  it('orders un-awaited writes and enforces maxBytes across queued writes', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const parts = [bytes(700_000, 1), bytes(300_000, 2), bytes(500_000, 3), bytes(1, 4)]
    const whole = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
    parts.reduce((at, part) => {
      whole.set(part, at)
      return at + part.length
    }, 0)
    const staging = await store.stage({ kind: 'user-attachment', mimeType: 'application/zip' })
    const pending = parts.map((part) => staging.write(part))
    await Promise.all(pending)
    const object = await staging.commit(sha(whole))
    expect(object).toEqual({ sha256: sha(whole), bytes: whole.length })
    expect(await store.read(object.sha256)).toEqual(whole)

    const capped = await store.stage({ kind: 'user-attachment', mimeType: 'image/png', maxBytes: 10 })
    const settled = Promise.allSettled([capped.write(bytes(6)), capped.write(bytes(6))])
    const [first, second] = await settled
    expect(first).toMatchObject({ status: 'rejected', reason: { code: 'ATTACHMENT_STAGE_CLOSED' } })
    expect(second).toMatchObject({ status: 'rejected', reason: { code: 'ATTACHMENT_TOO_LARGE' } })
    expect(readdirSync(join(dataDir, 'artifacts', 'staging'))).toEqual([])
  })

  it('rejects writes after commit starts and a second concurrent commit', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const body = bytes(1000)
    const staging = await store.stage({ kind: 'user-attachment', mimeType: 'image/png' })
    await staging.write(body)
    const committed = staging.commit()
    await expect(staging.write(bytes(5))).rejects.toMatchObject({ code: 'ATTACHMENT_STAGE_CLOSED' })
    await expect(staging.commit()).rejects.toMatchObject({ code: 'ATTACHMENT_STAGE_CLOSED' })
    expect(await committed).toEqual({ sha256: sha(body), bytes: body.length })
    expect(await store.read(sha(body))).toEqual(body)
    await expect(staging.commit()).rejects.toMatchObject({ code: 'ATTACHMENT_STAGE_CLOSED' })
  })

  it('rejects a malformed expected digest as an invalid id and leaves nothing behind', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const staging = await store.stage({ kind: 'user-attachment', mimeType: 'image/png' })
    await staging.write(bytes(4))
    await expect(staging.commit('ABC')).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID_ID' })
    expect(readdirSync(join(dataDir, 'artifacts', 'staging'))).toEqual([])
  })

  it('rejects invalid ranges as such and keeps corrupt for short reads', async () => {
    const store = createAttachmentStore({ dataDir: fresh() })
    const object = await store.put(bytes(10), { kind: 'user-attachment', mimeType: 'image/png' })
    for (const range of [
      { offset: -1, length: 2 },
      { offset: 0, length: -1 },
      { offset: 1.5, length: 2 },
      { offset: 0, length: Number.NaN },
      { offset: Number.MAX_SAFE_INTEGER + 2, length: 1 },
      { offset: 8, length: 5 },
    ])
      await expect(store.read(object.sha256, range)).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID_ID' })
    expect(await store.read(object.sha256, { offset: 10, length: 0 })).toEqual(new Uint8Array())
  })

  it('repairs a corrupt same-size object when the same bytes are stored again', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const body = bytes(2048, 5)
    const object = await store.put(body, { kind: 'user-attachment', mimeType: 'image/png' })
    const path = join(dataDir, 'artifacts', 'sha256', object.sha256.slice(0, 2), object.sha256)
    writeFileSync(path, bytes(2048, 6))
    await expect(store.read(object.sha256)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    expect(await store.put(body, { kind: 'user-attachment', mimeType: 'image/png' })).toEqual(object)
    expect(await store.read(object.sha256)).toEqual(body)
    expect(readdirSync(join(dataDir, 'artifacts', 'staging'))).toEqual([])
  })

  it('refuses a whole read beyond what one read can hold and points at ranges', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const sha256 = 'a'.repeat(64)
    const directory = join(dataDir, 'artifacts', 'sha256', 'aa')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, sha256), '')
    truncateSync(join(directory, sha256), 2 ** 31)
    await expect(store.read(sha256)).rejects.toMatchObject({
      code: 'ATTACHMENT_TOO_LARGE',
      message: expect.stringContaining('range'),
    })
    expect((await store.read(sha256, { offset: 2 ** 31 - 4, length: 4 })).byteLength).toBe(4)
  })

  it('honours an aborted signal on a whole read', async () => {
    const store = createAttachmentStore({ dataDir: fresh() })
    const object = await store.put(bytes(10), { kind: 'user-attachment', mimeType: 'image/png' })
    await expect(store.read(object.sha256, undefined, AbortSignal.abort())).rejects.toThrow()
  })

  it('reports a damaged marker on query, treats it as absent on rewrite and leaves no temp files', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir, clock: () => 7 })
    const object = await store.put(bytes(5), { kind: 'user-attachment', mimeType: 'image/png' })
    await store.markUserAttachment(object, { mimeType: 'image/png' })
    const shard = join(dataDir, 'artifacts', 'user-attachment-meta', object.sha256.slice(0, 2))
    const marker = join(shard, `${object.sha256}.json`)
    writeFileSync(marker, '{')
    await expect(store.userAttachment(object.sha256)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    await store.markUserAttachment(object, { mimeType: 'image/png', receiptFor: 'session-a' })
    expect(await store.userAttachment(object.sha256)).toMatchObject({
      firstSeenMs: 7,
      receipts: [attachmentReceiptFor('session-a')],
    })
    expect(readdirSync(shard)).toEqual([`${object.sha256}.json`])
    expect(JSON.parse(readFileSync(marker, 'utf8')).schemaVersion).toBe(1)
  })

  it('sweeps stale marker temp files and survives directories inside staging', async () => {
    const dataDir = fresh()
    const store = createAttachmentStore({ dataDir })
    const object = await store.put(bytes(5), { kind: 'user-attachment', mimeType: 'image/png' })
    await store.markUserAttachment(object, { mimeType: 'image/png' })
    const shard = join(dataDir, 'artifacts', 'user-attachment-meta', object.sha256.slice(0, 2))
    writeFileSync(join(shard, `${object.sha256}.json.abc.tmp`), 'x')
    const stray = join(dataDir, 'artifacts', 'staging', 'stray')
    mkdirSync(join(stray, 'inner'), { recursive: true })
    writeFileSync(join(stray, 'inner', 'f'), 'x')
    const leftover = await store.stage({ kind: 'user-attachment', mimeType: 'image/png' })
    await leftover.write(bytes(3))
    expect(await store.sweepStaging(Date.now())).toBe(0)
    expect(await store.sweepStaging(Date.now() + 25 * 60 * 60 * 1000)).toBe(3)
    expect(readdirSync(join(dataDir, 'artifacts', 'staging'))).toEqual([])
    expect(readdirSync(shard)).toEqual([`${object.sha256}.json`])
    await leftover.abort()
  })
})
