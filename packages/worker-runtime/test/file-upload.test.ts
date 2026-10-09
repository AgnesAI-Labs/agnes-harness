import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type FileUploadRequest, uploadedAttachment } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { FileUploadStore } from '../src/file-upload-store.js'

const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
type WithoutIdentity<T> = T extends unknown ? Omit<T, 'sessionId' | 'uploadId'> : never
type UploadInput = WithoutIdentity<FileUploadRequest>
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agnes-upload-')))
  const store = new FileUploadStore('session', {
    maxBytes: 8,
    chunkBytes: 4,
    allowedMimeTypes: ['text/plain'],
  })
  const fs = {
    authorizeWrite: async (_path: string) => undefined,
    authorizeRemove: async (_path: string) => undefined,
    rm: (path: string, opts?: { recursive?: boolean }) => rm(path, opts),
    stat,
    write: async (path: string, bytes: Uint8Array) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)
    },
    list: async (path: string) => (await readdir(path)).map((name) => ({ name })),
  }
  const base = { sessionId: 'session', uploadId: randomUUID() }
  const request = (input: UploadInput) => store.request({ ...base, ...input } as FileUploadRequest, root, fs)
  const start = (extra = {}) =>
    request({ operation: 'start', name: '../合同.txt', mimeType: 'text/plain', size: 8, ...extra })
  const chunk = (text: string, offset: number) =>
    request({
      operation: 'chunk',
      offset,
      data: Buffer.from(text).toString('base64'),
      sha256: digest(Buffer.from(text)),
    })
  return {
    root,
    store,
    fs,
    base,
    request,
    start,
    chunk,
    close: async () => {
      await store.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

it('writes ordered chunks, retries a lost acknowledgement, and verifies a content-addressed original', async () => {
  const h = await fixture()
  try {
    await h.start()
    expect(await h.chunk('abcd', 0)).toEqual({ offset: 4 })
    expect(await h.chunk('abcd', 0)).toEqual({ offset: 4 })
    await expect(h.chunk('xxxx', 0)).rejects.toMatchObject({ code: 'UPLOAD_OFFSET_MISMATCH' })
    await expect(h.chunk('a', 5)).rejects.toMatchObject({ code: 'UPLOAD_OFFSET_MISMATCH' })
    await h.chunk('efgh', 4)
    const result = await h.request({ operation: 'finish', sha256: digest(Buffer.from('abcdefgh')) })
    const ref = uploadedAttachment(result.attachment?.uri ?? '')
    if (!ref) throw new Error('missing uploaded artifact')
    expect(result.attachment).toMatchObject({ name: '../合同.txt', mimeType: 'text/plain' })
    expect(await readFile(join(h.root, ref.path), 'utf8')).toBe('abcdefgh')
    expect((await readdir(dirname(join(h.root, ref.path)))).some((name) => name.startsWith('.partial'))).toBe(
      false,
    )
    expect(await h.request({ operation: 'finish', sha256: ref.sha256 })).toEqual(result)
    const denied = { ...h.fs, authorizeRemove: async () => { throw new Error('read-only') } }
    for (const store of [h.store, new FileUploadStore('session')]) {
      try {
        await expect(store.request({ ...h.base, operation: 'cancel' }, h.root, denied)).rejects.toThrow('read-only')
        expect(await readFile(join(h.root, ref.path), 'utf8')).toBe('abcdefgh')
        // Refusal must not install a cancellation tombstone.
        if (store === h.store) expect(await h.request({ operation: 'status' })).toEqual(result)
        else await store.request({ ...h.base, operation: 'cancel' }, h.root, h.fs)
      } finally { if (store !== h.store) await store.close() }
    }
    await h.request({ operation: 'cancel' })
    await expect(stat(join(h.root, ref.path))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await h.close()
  }
})

it.each(['cancel', 'close', 'hash', 'recover', 'publication-recover'] as const)(
  'cleans every partial byte on %s',
  async (reason) => {
    const h = await fixture()
    try {
      await h.start()
      await h.chunk('abcd', 0)
      const dir = join(h.root, '.agnes-attachments', digest(Buffer.from('session')))
      if (reason === 'cancel') {
        await h.request({ operation: 'cancel' })
        await h.request({ operation: 'cancel' })
      } else if (reason === 'close') await h.store.close()
      else if (reason === 'recover' || reason === 'publication-recover') {
        if (reason === 'publication-recover') {
          await mkdir(join(dir, h.base.uploadId))
          await writeFile(join(dir, h.base.uploadId, 'a'.repeat(64)), 'incomplete publication')
        }
        const next = new FileUploadStore('session')
        try {
          await next.recover(h.root, h.fs)
        } finally {
          await next.close()
        }
      } else {
        await h.chunk('efgh', 4)
        await expect(
          h.request({ operation: 'finish', sha256: digest(Buffer.from('mismatch')) }),
        ).rejects.toMatchObject({ code: 'UPLOAD_HASH_MISMATCH' })
      }
      expect(await readdir(dir)).toEqual([])
    } finally {
      await h.close()
    }
  },
)

it('refuses size, type, chunk corruption and oversized chunks without publishing bytes', async () => {
  const h = await fixture()
  try {
    await expect(h.start({ size: 9 })).rejects.toMatchObject({ code: 'UPLOAD_SIZE_LIMIT' })
    await expect(h.start({ mimeType: 'image/png' })).rejects.toMatchObject({ code: 'UPLOAD_TYPE_LIMIT' })
    expect(await readdir(h.root)).toEqual([])
    await h.start()
    await expect(h.chunk('abcde', 0)).rejects.toMatchObject({ code: 'UPLOAD_CHUNK_LIMIT' })
    await expect(
      h.request({
        operation: 'chunk',
        offset: 0,
        data: 'YWJjZA==',
        sha256: digest(Buffer.from('bad')),
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_HASH_MISMATCH' })
    expect(await h.request({ operation: 'status' })).toEqual({ offset: 0 })
    const denied = {
      ...h.fs,
      authorizeWrite: async () => {
        throw new Error('write policy revoked')
      },
    }
    await expect(
      h.store.request(
        { ...h.base, operation: 'chunk', offset: 0, data: 'YWJjZA==', sha256: digest(Buffer.from('abcd')) },
        h.root,
        denied,
      ),
    ).rejects.toThrow('write policy revoked')
    expect(await readdir(join(h.root, '.agnes-attachments', digest(Buffer.from('session'))))).toEqual([])
  } finally {
    await h.close()
  }
})

it('refuses a substituted upload directory before native disk access', async () => {
  const h = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'agnes-upload-outside-'))
  try {
    await h.start()
    const dir = join(h.root, '.agnes-attachments', digest(Buffer.from('session')))
    await rm(dir, { recursive: true })
    await symlink(outside, dir)
    await writeFile(join(outside, `.partial-${h.base.uploadId}`), '')
    await expect(h.chunk('abcd', 0)).rejects.toMatchObject({ code: 'UPLOAD_PATH_DENIED' })
    expect(await readFile(join(outside, `.partial-${h.base.uploadId}`), 'utf8')).toBe('')
    await rm(dir)
  } finally {
    await h.close()
    await rm(outside, { recursive: true, force: true })
  }
})

it.each(['cancel', 'close'] as const)(
  'cleans a start still waiting on filesystem admission during %s',
  async (operation) => {
    const h = await fixture()
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const admission = new Promise<void>((resolve) => {
      entered = resolve
    })
    const fs = {
      ...h.fs,
      write: async (path: string, bytes: Uint8Array) => {
        entered()
        await hold
        await h.fs.write(path, bytes)
      },
    }
    try {
      const start = h.store.request(
        { ...h.base, operation: 'start', name: 'contract.txt', mimeType: 'text/plain', size: 8 },
        h.root,
        fs,
      )
      await admission
      const cleanup = operation === 'close' ? h.store.close() : h.request({ operation: 'cancel' })
      const settled = Promise.allSettled([start, cleanup])
      release()
      await settled
      expect(await readdir(join(h.root, '.agnes-attachments', digest(Buffer.from('session'))))).toEqual([])
    } finally {
      release()
      await h.close()
    }
  },
)

it('rejects a queued chunk while another chunk owns the write slot', async () => {
  const h = await fixture()
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const admission = new Promise<void>((resolve) => {
    entered = resolve
  })
  try {
    await h.start()
    const fs = {
      ...h.fs,
      stat: async (path: string) => {
        entered()
        await hold
        return stat(path)
      },
    }
    const first = h.store.request(
      {
        ...h.base,
        operation: 'chunk',
        offset: 0,
        data: Buffer.from('abcd').toString('base64'),
        sha256: digest(Buffer.from('abcd')),
      },
      h.root,
      fs,
    )
    await admission
    await expect(h.chunk('efgh', 4)).rejects.toMatchObject({ code: 'UPLOAD_BUSY' })
    release()
    expect(await first).toEqual({ offset: 4 })
    expect(await h.chunk('efgh', 4)).toEqual({ offset: 8 })
  } finally {
    release()
    await h.close()
  }
})
