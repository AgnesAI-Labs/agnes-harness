import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { cancelFileUpload, uploadFile, type UploadProgress } from '../src/file-upload.js'

const limits = { maxBytes: 16, chunkBytes: 4, allowedMimeTypes: ['text/plain'] }
const attachment = {
  type: 'resource_link' as const,
  uri: 'agnes-upload://receipt',
  name: 'contract.txt',
  mimeType: 'text/plain',
}
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
afterEach(() => vi.unstubAllGlobals())

it.each([0, 4])(
  'sends bounded chunks, resumes from %i, and retries a lost acknowledgement',
  async (resume) => {
    const chunks: { offset: number; bytes: string }[] = []
    let lost = false
    let digest: string | undefined
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const query = new URL(url, 'http://localhost').searchParams
      if (query.get('operation') === 'chunk') {
        const bytes = new Uint8Array(await (init.body as Blob).arrayBuffer())
        expect(bytes.length).toBeLessThanOrEqual(limits.chunkBytes)
        expect(query.get('sha256')).toBe(createHash('sha256').update(bytes).digest('hex'))
        const offset = Number(query.get('offset'))
        chunks.push({ offset, bytes: new TextDecoder().decode(bytes) })
        if (!lost) {
          lost = true
          throw new TypeError('lost acknowledgement')
        }
        return response({ offset: offset + bytes.length })
      }
      const control = JSON.parse(String(init.body)) as { operation: string; sha256?: string }
      if (control.operation === 'start') return response({ offset: resume })
      digest = control.sha256
      return response({ attachment })
    })
    const progress: UploadProgress[] = []
    const file = new File(['abcdefghij'], 'contract.txt', { type: 'text/plain' })
    expect(
      await uploadFile(file, 'session', 'upload', limits, new AbortController().signal, (value) =>
        progress.push(value),
      ),
    ).toEqual(attachment)
    expect(chunks).toEqual(
      resume === 0
        ? [
            { offset: 0, bytes: 'abcd' },
            { offset: 0, bytes: 'abcd' },
            { offset: 4, bytes: 'efgh' },
            { offset: 8, bytes: 'ij' },
          ]
        : [
            { offset: 4, bytes: 'efgh' },
            { offset: 4, bytes: 'efgh' },
            { offset: 8, bytes: 'ij' },
          ],
    )
    expect(digest).toBe(createHash('sha256').update('abcdefghij').digest('hex'))
    expect(progress.at(-1)).toEqual({ loaded: 10, total: 10, phase: 'verifying' })
  },
)

it.each([
  [new File(['x'.repeat(17)], 'large.txt', { type: 'text/plain' }), 'UPLOAD_SIZE_LIMIT'],
  [new File(['x'], 'scan.png', { type: 'image/png' }), 'UPLOAD_TYPE_LIMIT'],
])('refuses %s before sending or reading file data', async (file, code) => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(
    uploadFile(file, 'session', 'upload', limits, new AbortController().signal, () => undefined),
  ).rejects.toMatchObject({ code })
  expect(fetch).not.toHaveBeenCalled()
})

it('aborts an in-flight chunk and sends a separate cleanup request without finishing', async () => {
  const controller = new AbortController()
  const operations: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const query = new URL(url, 'http://localhost').searchParams
    const operation = query.get('operation') ?? JSON.parse(String(init.body)).operation
    operations.push(operation)
    if (operation === 'start') return response({ offset: 0 })
    if (operation === 'cancel') {
      expect(init.signal).toBeUndefined()
      return response({})
    }
    if (Number(query.get('offset')) === 4) {
      controller.abort()
      throw new DOMException('cancelled', 'AbortError')
    }
    return response({ offset: 4 })
  })
  await expect(
    uploadFile(
      new File(['abcdefgh'], 'contract.txt', { type: 'text/plain' }),
      'session',
      'upload',
      limits,
      controller.signal,
      () => undefined,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' })
  await cancelFileUpload('session', 'upload')
  expect(operations).toEqual(['start', 'chunk', 'chunk', 'cancel'])
})
