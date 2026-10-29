import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { FILE_UPLOAD_CHUNK_BYTES, rpcError } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { fileUploadRoute } from '../src/upload-route.js'

async function request(
  body: Uint8Array,
  headers = {},
  invoke = async (_input: unknown) => ({ offset: body.length }),
  route = fileUploadRoute('http://127.0.0.1:4177', invoke),
) {
  const input = Object.assign(Readable.from([body]), {
    method: 'POST',
    url:
      '/api/attachments/upload?operation=chunk&sessionId=owned&uploadId=00000000-0000-4000-8000-000000000001&offset=0&sha256=' +
      'a'.repeat(64),
    headers: { origin: 'http://127.0.0.1:4177', 'content-type': 'application/octet-stream', ...headers },
  }) as unknown as IncomingMessage
  let status = 0,
    payload = ''
  const response = {
    writeHead: (value: number) => {
      status = value
      return response
    },
    end: (value: string) => {
      payload = value
    },
  } as unknown as ServerResponse
  await route(input, response)
  return { status, payload: JSON.parse(payload) }
}
it('forwards one bounded raw chunk and refuses oversize or foreign-origin bodies', async () => {
  expect(await request(Buffer.alloc(FILE_UPLOAD_CHUNK_BYTES))).toEqual({
    status: 200,
    payload: { offset: FILE_UPLOAD_CHUNK_BYTES },
  })
  expect(await request(Buffer.alloc(FILE_UPLOAD_CHUNK_BYTES + 1))).toEqual({
    status: 413,
    payload: { error: 'UPLOAD_CHUNK_LIMIT' },
  })
  expect(await request(Buffer.alloc(1), { origin: 'https://foreign.invalid' })).toEqual({
    status: 403,
    payload: { error: 'UPLOAD_ORIGIN_DENIED' },
  })
  expect(await request(Buffer.alloc(1), { 'sec-fetch-site': 'cross-site' })).toEqual({
    status: 403,
    payload: { error: 'UPLOAD_ORIGIN_DENIED' },
  })
})
it('preserves actionable limit errors and hides backend details', async () => {
  for (const [reason, status] of [
    ['UPLOAD_SIZE_LIMIT', 413],
    ['UPLOAD_CHUNK_LIMIT', 413],
    ['UPLOAD_TYPE_LIMIT', 415],
    ['UPLOAD_INVALID', 400],
    ['UPLOAD_BUSY', 409],
    ['ATTACHMENT_INVALID', 409],
    ['UPLOAD_UNAVAILABLE', 409],
  ] as const) {
    expect(
      await request(Buffer.alloc(1), {}, async () => {
        throw rpcError('SEMANTIC_REJECTED', { reason })
      }),
    ).toEqual({ status, payload: { error: reason } })
  }
  expect(
    await request(Buffer.alloc(1), {}, async () => {
      throw new Error('/private/server/path')
    }),
  ).toEqual({ status: 409, payload: { error: 'UPLOAD_UNAVAILABLE' } })
})

it('bounds concurrent chunks per owner and releases slots after backend failure', async () => {
  const releases: (() => void)[] = []
  let reject = false
  const first = fileUploadRoute('http://127.0.0.1:4177', async () => {
    await new Promise<void>((resolve) => releases.push(resolve))
    if (reject) throw new Error('private backend failure')
    return { offset: 1 }
  })
  const chunks = Array.from({ length: 4 }, () => request(Buffer.alloc(1), {}, undefined, first))
  await expect.poll(() => releases.length).toBe(4)
  expect(await request(Buffer.alloc(1), {}, undefined, first)).toEqual({
    status: 409,
    payload: { error: 'UPLOAD_BUSY' },
  })
  // A second owner has its own four slots even while the first owner is full.
  expect(await request(Buffer.alloc(1))).toEqual({ status: 200, payload: { offset: 1 } })
  reject = true
  for (const release of releases) release()
  expect(await Promise.all(chunks)).toEqual(
    Array.from({ length: 4 }, () => ({
      status: 409,
      payload: { error: 'UPLOAD_UNAVAILABLE' },
    })),
  )
  reject = false
  const retry = request(Buffer.alloc(1), {}, undefined, first)
  await expect.poll(() => releases.length).toBe(5)
  releases[4]?.()
  expect(await retry).toEqual({ status: 200, payload: { offset: 1 } })
})
