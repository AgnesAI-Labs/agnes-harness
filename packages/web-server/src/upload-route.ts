import type { IncomingMessage, ServerResponse } from 'node:http'
import { FILE_UPLOAD_CHUNK_BYTES, type FileUploadRequest, type FileUploadResult } from '@agnes/protocol'

export type FileUploadHandler = (input: FileUploadRequest) => Promise<FileUploadResult>
let activeChunks = 0
async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const parts: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > limit) throw new Error('UPLOAD_CHUNK_LIMIT')
    parts.push(chunk)
  }
  return Buffer.concat(parts, length)
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

/** Same-origin byte intake; at most one fixed chunk is encoded for the daemon channel. */
export async function handleFileUpload(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
  invoke?: FileUploadHandler,
): Promise<void> {
  const site = request.headers['sec-fetch-site']
  if (
    (site !== undefined && site !== 'same-origin' && site !== 'none') ||
    (request.headers.origin !== undefined && request.headers.origin !== origin) ||
    (request.method === 'POST' && request.headers.origin !== origin)
  ) {
    json(response, 403, { error: 'UPLOAD_ORIGIN_DENIED' })
    return
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.writeHead(405, { Allow: 'GET, POST' }).end()
    return
  }
  if (!invoke) {
    json(response, 503, { error: 'UPLOAD_UNAVAILABLE' })
    return
  }
  let chunkSlot = false
  try {
    const url = new URL(request.url ?? '', origin)
    let input: FileUploadRequest
    if (request.method === 'GET')
      input = { operation: 'limits', sessionId: url.searchParams.get('sessionId') ?? '' }
    else if (url.searchParams.get('operation') === 'chunk') {
      if (activeChunks >= 4) throw new Error('UPLOAD_BUSY')
      activeChunks++
      chunkSlot = true
      if (request.headers['content-type'] !== 'application/octet-stream') throw new Error('UPLOAD_INVALID')
      const bytes = await readBody(request, FILE_UPLOAD_CHUNK_BYTES)
      input = {
        operation: 'chunk',
        sessionId: url.searchParams.get('sessionId') ?? '',
        uploadId: url.searchParams.get('uploadId') ?? '',
        offset: Number(url.searchParams.get('offset')),
        sha256: url.searchParams.get('sha256') ?? '',
        data: bytes.toString('base64'),
      }
    } else {
      if (request.headers['content-type'] !== 'application/json') throw new Error('UPLOAD_INVALID')
      input = JSON.parse((await readBody(request, 64 * 1024)).toString('utf8')) as FileUploadRequest
    }
    const result = await invoke(input)
    json(response, 200, result)
  } catch (error) {
    const reason = (error as { data?: { reason?: unknown } }).data?.reason ?? (error as Error).message
    const code =
      typeof reason === 'string' && /^UPLOAD_[A-Z_]+$/u.test(reason) ? reason : 'UPLOAD_UNAVAILABLE'
    json(
      response,
      code === 'UPLOAD_SIZE_LIMIT' || code === 'UPLOAD_CHUNK_LIMIT'
        ? 413
        : code === 'UPLOAD_TYPE_LIMIT'
          ? 415
          : code === 'UPLOAD_INVALID'
            ? 400
            : 409,
      { error: code },
    )
  } finally {
    if (chunkSlot) activeChunks--
  }
}
