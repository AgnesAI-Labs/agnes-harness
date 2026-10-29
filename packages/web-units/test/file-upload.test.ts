import { createHash } from 'node:crypto'
import { attachmentLink } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { cancelFileUpload, type UploadProgress, uploadFile } from '../src/file-upload.js'

const limits = { maxBytes: 16, chunkBytes: 4, allowedMimeTypes: ['text/plain'] }
const attachment = {
  type: 'resource_link' as const,
  uri: 'agnes-upload://receipt',
  name: 'contract.txt',
  mimeType: 'text/plain',
}
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const busy = () =>
  new Response(JSON.stringify({ error: 'UPLOAD_BUSY' }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  })

it.each([
  [0, 'workspace'],
  [4, 'workspace'],
  [0, 'original'],
  [4, 'original'],
] as const)(
  'sends bounded chunks, resumes from %i into %s, and retries a lost acknowledgement',
  async (resume, destination) => {
    const expected =
      destination === 'original'
        ? attachmentLink(
            { sha256: createHash('sha256').update('abcdefghij').digest('hex'), size: 10, mime: 'text/plain' },
            'contract.txt',
            { receiptId: '00000000-0000-4000-8000-000000000001' },
          )
        : attachment
    const chunks: { offset: number; bytes: string }[] = []
    let lost = false
    let digest: string | undefined
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const query = new URL(url, 'http://localhost').searchParams
      if (query.get('operation') === 'chunk') {
        expect(query.get('destination')).toBe(destination)
        expect(query.get('laneId')).toBe('main')
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
      expect((JSON.parse(String(init.body)) as { destination: string }).destination).toBe(destination)
      return response({ attachment: expected })
    })
    const progress: UploadProgress[] = []
    const file = new File(['abcdefghij'], 'contract.txt', { type: 'text/plain' })
    expect(
      await uploadFile(
        file,
        'session',
        'upload',
        limits,
        new AbortController().signal,
        (value) => progress.push(value),
        destination,
      ),
    ).toEqual(expected)
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

it('retries a busy chunk on 250, 500, 1000 and 2000 ms, then surfaces the error', async () => {
  vi.useFakeTimers()
  let chunks = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const query = new URL(url, 'http://localhost').searchParams
    if (query.get('operation') === 'chunk') {
      chunks += 1
      return busy()
    }
    const control = JSON.parse(String(init.body)) as { operation: string }
    if (control.operation === 'start') return response({ offset: 0 })
    return response({ attachment })
  })
  const pending = uploadFile(
    new File(['abcd'], 'contract.txt', { type: 'text/plain' }),
    'session',
    'upload',
    limits,
    new AbortController().signal,
    () => undefined,
  )
  const surfaced = expect(pending).rejects.toMatchObject({ code: 'UPLOAD_BUSY' })
  await vi.advanceTimersByTimeAsync(0)
  expect(chunks).toBe(1)
  await vi.advanceTimersByTimeAsync(249)
  expect(chunks).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(chunks).toBe(2)
  await vi.advanceTimersByTimeAsync(499)
  expect(chunks).toBe(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(chunks).toBe(3)
  await vi.advanceTimersByTimeAsync(999)
  expect(chunks).toBe(3)
  await vi.advanceTimersByTimeAsync(1)
  expect(chunks).toBe(4)
  await vi.advanceTimersByTimeAsync(1_999)
  expect(chunks).toBe(4)
  await vi.advanceTimersByTimeAsync(1)
  expect(chunks).toBe(5)
  await surfaced
  expect(chunks).toBe(5)
})

it('stops a busy retry when the upload is aborted during the backoff', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  let chunks = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const query = new URL(url, 'http://localhost').searchParams
    if (query.get('operation') === 'chunk') {
      chunks += 1
      return busy()
    }
    const control = JSON.parse(String(init.body)) as { operation: string }
    if (control.operation === 'start') return response({ offset: 0 })
    return response({ attachment })
  })
  const pending = uploadFile(
    new File(['abcd'], 'contract.txt', { type: 'text/plain' }),
    'session',
    'upload',
    limits,
    controller.signal,
    () => undefined,
  )
  const aborted = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(0)
  expect(chunks).toBe(1)
  controller.abort()
  await vi.advanceTimersByTimeAsync(2_000)
  await aborted
  expect(chunks).toBe(1)
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
