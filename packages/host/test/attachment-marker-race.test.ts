import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Lets a test make one marker read report "absent" while the file is there: exactly what a
// session worker sees when the upload process writes the marker between its read and its write.
const hidden = vi.hoisted(() => ({ paths: new Set<string>(), noLinks: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: ((path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      if (typeof path === 'string' && hidden.paths.delete(path))
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.readFile,
    // A file system without hard links.
    link: ((...args: Parameters<typeof actual.link>) =>
      hidden.noLinks
        ? Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
        : actual.link(...args)) as typeof actual.link,
  }
})

const { attachmentReceiptFor, createAttachmentStore } = await import('../src/attachment-store.js')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('user attachment markers written from two processes', () => {
  afterEach(() => {
    hidden.noLinks = false
  })

  it.each([false, true])(
    'a receipt-less mark that raced a receipt write keeps the receipt (no hard links: %s)',
    async (noLinks) => {
      hidden.noLinks = noLinks
      const dataDir = mkdtempSync(join(tmpdir(), 'agh-marker-race-'))
      dirs.push(dataDir)
      const uploads = createAttachmentStore({ dataDir })
      const worker = createAttachmentStore({ dataDir })
      const bytes = Uint8Array.from({ length: 40 }, (_, i) => i)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const object = await uploads.put(bytes, { kind: 'user-attachment', mimeType: 'application/zip' })
      await uploads.markUserAttachment(object, { mimeType: 'application/zip', receiptFor: 'k' })
      hidden.paths.add(
        join(dataDir, 'artifacts', 'user-attachment-meta', sha256.slice(0, 2), `${sha256}.json`),
      )
      await worker.markUserAttachment(object, { mimeType: 'application/zip' })
      expect(hidden.paths.size).toBe(0)
      expect((await uploads.userAttachment(sha256))?.receipts).toEqual([attachmentReceiptFor('k')])
    },
  )
})
