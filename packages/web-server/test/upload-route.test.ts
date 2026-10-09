import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { FILE_UPLOAD_CHUNK_BYTES, rpcError } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { handleFileUpload } from '../src/upload-route.js'

async function request(
  body: Uint8Array,
  headers = {},
  invoke = async (_input: unknown) => ({ offset: body.length }),
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
  await handleFileUpload(input, response, 'http://127.0.0.1:4177', invoke)
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
  expect(
    await request(Buffer.alloc(1), {}, async () => {
      throw rpcError('SEMANTIC_REJECTED', { reason: 'UPLOAD_SIZE_LIMIT' })
    }),
  ).toEqual({ status: 413, payload: { error: 'UPLOAD_SIZE_LIMIT' } })
  expect(
    await request(Buffer.alloc(1), {}, async () => {
      throw new Error('/private/server/path')
    }),
  ).toEqual({ status: 409, payload: { error: 'UPLOAD_UNAVAILABLE' } })
})
