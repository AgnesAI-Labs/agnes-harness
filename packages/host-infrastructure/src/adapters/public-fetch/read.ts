import type { PublicFetchResult } from '@agnes/extension-api'
import { bodyFormat, LIMITS, WebFetchError } from './policy.js'
import type { PublicResponse } from './transport.js'

export function header(response: PublicResponse, name: string): string {
  const value = response.headers[name]
  return Array.isArray(value) ? value.join(', ') : (value ?? '')
}

export async function readResponse(
  response: PublicResponse,
  url: URL,
  signal: AbortSignal,
  responseType?: 'zip',
): Promise<PublicFetchResult> {
  const encoding = header(response, 'content-encoding').trim().toLowerCase()
  if (encoding && encoding !== 'identity')
    throw new WebFetchError(
      'Compressed responses are not supported by public web retrieval',
      'WEB_UNSUPPORTED_CONTENT_TYPE',
    )
  const contentType = header(response, 'content-type')
  const binary = responseType === 'zip' && response.statusCode >= 200 && response.statusCode < 300
  if (binary && contentType.split(';')[0]?.trim().toLowerCase() !== 'application/zip')
    throw new WebFetchError('Expected a ZIP response', 'WEB_UNSUPPORTED_CONTENT_TYPE')
  const format = binary ? undefined : bodyFormat(contentType)
  const declared = header(response, 'content-length')
  if (/^\d+$/u.test(declared) && Number(declared) > LIMITS.bytes)
    throw new WebFetchError('Response exceeds the 2 MiB download limit', 'WEB_FETCH_TOO_LARGE')
  const chunks: Uint8Array[] = []
  let total = 0,
    truncatedBytes = false
  for await (const chunk of response.body) {
    signal.throwIfAborted()
    const remaining = LIMITS.bytes - total
    const kept = chunk.subarray(0, remaining)
    chunks.push(kept)
    total += kept.length
    if (chunk.length > remaining) {
      truncatedBytes = true
      break
    }
  }
  signal.throwIfAborted()
  if (binary)
    return {
      url: url.href,
      statusCode: response.statusCode,
      contentType: contentType.slice(0, 256),
      body: { kind: 'zip', base64: Buffer.concat(chunks).toString('base64') },
      truncation: { bytes: truncatedBytes, decoded: false },
    }
  if (!format) throw new WebFetchError('Missing response format', 'WEB_UNSUPPORTED_CONTENT_TYPE')
  const { kind, decoder } = format
  let content = ''
  for (const chunk of chunks) content += decoder.decode(chunk, { stream: true })
  // On a byte cut discard the decoder's incomplete suffix, rather than inventing U+FFFD.
  if (!truncatedBytes) content += decoder.decode()
  let end = 0,
    count = 0
  for (const point of content) {
    if (count++ === LIMITS.chars) break
    end += point.length
  }
  const decoded = end < content.length
  return {
    url: url.href,
    statusCode: response.statusCode,
    contentType: contentType.slice(0, 256),
    body: { kind, content: content.slice(0, end) },
    truncation: { bytes: truncatedBytes, decoded },
  }
}
