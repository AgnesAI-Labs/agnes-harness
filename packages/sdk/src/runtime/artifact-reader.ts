// Binary artifact reads over the runtime client wire. A range is returned only after its body
// matches the metadata header's length and SHA-256; a stream is complete only once the server's
// stream status confirms the byte count and digest of exactly what this client received. Hashing
// uses Web Crypto, so the module runs unchanged in browsers.
import {
  type ArtifactClientOpenStreamRequest,
  type ArtifactClientReadRangeRequest,
  type ArtifactReadStreamEndResult,
  type ClientArtifactStreamMetadata,
  decodeClientBinaryMetadata,
  RuntimeClientTransportPolicy,
  RuntimeClientTransportWire,
  validateClientBinaryRequest,
} from '@agnes/protocol/runtime'
import {
  type CallResult,
  localRuntimeError,
  type RuntimeClientTransport,
  readOutcome,
} from './client-transport.js'

const { routes, metadataHeader, binaryMime } = RuntimeClientTransportWire
const maxChunk = RuntimeClientTransportPolicy.maxRangeBytes

export type ArtifactRange = { bytes: Uint8Array; offset: number; totalBytes: number; digest: string }
export type ArtifactByteStream = {
  readonly metadata: ClientArtifactStreamMetadata
  /** Single-use; each chunk is at most the protocol's range size. */
  readonly chunks: AsyncIterable<Uint8Array>
  /** Settles once the chunks are consumed or the stream is cancelled; `ok` only when verified. */
  readonly ended: Promise<CallResult<ArtifactReadStreamEndResult>>
  cancel(reason: string): Promise<void>
  close(): Promise<void>
}

const integrity = (message: string) =>
  ({ state: 'failed', error: localRuntimeError('internal', 'integrity', message) }) as const

function concat(parts: readonly Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const all = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  return all
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Reader-based rather than `for await` over the body: not every browser makes it iterable. */
async function* pieces(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
  if (!body) return
  const reader = body.getReader()
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) yield next.value
  } finally {
    // Releases the connection when the caller stops early; harmless after the end.
    await reader.cancel().catch(() => undefined)
  }
}

/** A success is octet-stream bytes with metadata; anything else must be the route's typed failure. */
async function open(
  transport: RuntimeClientTransport,
  path: string,
  request: unknown,
  signal?: AbortSignal,
): Promise<Response | CallResult<never>> {
  let response: Response
  try {
    response = await transport.post(path, request, signal)
  } catch {
    return { state: 'unknown', reason: 'no reply' }
  }
  if (response.status === 200 && response.headers.get('content-type')?.split(';')[0] === binaryMime)
    return response
  const outcome = await readOutcome(response)
  return outcome && !outcome.ok
    ? { state: 'failed', error: outcome.error }
    : { state: 'unknown', reason: 'invalid reply' }
}

export function artifactReader(transport: RuntimeClientTransport) {
  const refused = () =>
    ({
      state: 'refused',
      reason: transport.mode === 'incompatible' ? 'incompatible' : 'disconnected',
    }) as const

  async function readRange(
    input: ArtifactClientReadRangeRequest,
    signal?: AbortSignal,
  ): Promise<CallResult<ArtifactRange>> {
    const header = transport.header()
    if (!header) return refused()
    const request = validateClientBinaryRequest('range', { header, input })
    if (!request.ok) return { state: 'refused', reason: 'invalid-request' }
    const response = await open(transport, routes.readRange.path, request.value, signal)
    if ('state' in response) return response
    const metadata = decodeClientBinaryMetadata('range', response.headers.get(metadataHeader))
    // EOF clamps a range: the metadata names exactly the bytes that remain, never the requested length.
    if (
      !metadata.ok ||
      !('digest' in metadata.value) ||
      metadata.value.offset !== input.offset ||
      metadata.value.bytes < 1 ||
      metadata.value.bytes !== Math.min(input.length, metadata.value.totalBytes - input.offset)
    ) {
      await response.body?.cancel().catch(() => undefined)
      return integrity('range metadata does not describe the requested range')
    }
    const { offset, totalBytes, bytes, digest } = metadata.value
    const parts: Uint8Array[] = []
    let size = 0
    try {
      for await (const piece of pieces(response.body)) {
        size += piece.length
        if (size > bytes) break
        parts.push(piece)
      }
    } catch {
      return { state: 'unknown', reason: 'range interrupted' }
    }
    if (size !== bytes) return integrity('range length differs from its metadata')
    const body = concat(parts, size)
    if ((await sha256(body)) !== digest) return integrity('range digest differs from its metadata')
    return { state: 'ok', value: { bytes: body, offset, totalBytes, digest } }
  }

  async function openStream(
    input: ArtifactClientOpenStreamRequest,
    signal?: AbortSignal,
  ): Promise<CallResult<ArtifactByteStream>> {
    const header = transport.header()
    if (!header) return refused()
    const request = validateClientBinaryRequest('stream', { header, input })
    if (!request.ok) return { state: 'refused', reason: 'invalid-request' }
    const abort = new AbortController()
    signal?.addEventListener('abort', () => abort.abort(signal.reason), { once: true })
    const response = await open(transport, routes.openStream.path, request.value, abort.signal)
    if ('state' in response) return response
    const metadata = decodeClientBinaryMetadata('stream', response.headers.get(metadataHeader))
    if (!metadata.ok || !('streamId' in metadata.value) || metadata.value.offset !== (input.offset ?? 0)) {
      abort.abort()
      return integrity('stream metadata does not describe the requested stream')
    }
    const { streamId, offset, totalBytes } = metadata.value
    const body = response.body
    const cancelled = {
      state: 'failed',
      error: localRuntimeError('cancelled', 'cancelled', 'stream cancelled'),
    } as const
    let settle: (result: CallResult<ArtifactReadStreamEndResult>) => void = () => undefined
    const ended = new Promise<CallResult<ArtifactReadStreamEndResult>>((resolve) => {
      settle = resolve
    })

    // Neither EOF nor a matching digest proves the server finished cleanly; only its status does.
    const verify = async (
      received: Uint8Array<ArrayBuffer>,
    ): Promise<CallResult<ArtifactReadStreamEndResult>> => {
      if (received.length !== totalBytes - offset) return integrity('stream length differs from its metadata')
      const digest = await sha256(received)
      const current = transport.header()
      const status =
        current && (await transport.query('transport.streamStatus', { header: current, streamId }))
      if (status?.state === 'failed') return status
      if (status?.state !== 'ok') return { state: 'unknown', reason: 'stream status unavailable' }
      const final = status.value
      if (final.state === 'failed' || final.state === 'cancelled')
        return { state: 'failed', error: final.error }
      if (final.state !== 'succeeded') return { state: 'unknown', reason: `stream status is ${final.state}` }
      if (
        final.bytes !== received.length ||
        final.summary.bytes !== received.length ||
        final.summary.digest !== digest
      )
        return integrity('stream status differs from the received bytes')
      return { state: 'ok', value: final.summary }
    }

    async function* chunks(): AsyncGenerator<Uint8Array> {
      // ponytail: Web Crypto has no incremental SHA-256, so delivered bytes stay referenced until the
      // end; switch to an incremental hash when streams near the 1 GiB artifact cap matter.
      const parts: Uint8Array[] = []
      let size = 0
      let finished = false
      let broken = false
      try {
        for await (const piece of pieces(body)) {
          size += piece.length
          if (size > totalBytes - offset) return settle(integrity('stream exceeds its metadata'))
          parts.push(piece)
          for (let at = 0; at < piece.length; at += maxChunk) yield piece.subarray(at, at + maxChunk)
        }
        finished = true
      } catch {
        broken = true
      } finally {
        if (!finished) {
          // A dropped connection proves nothing about the server's end; an abort or early stop is ours.
          settle(
            broken && !abort.signal.aborted ? { state: 'unknown', reason: 'stream interrupted' } : cancelled,
          )
          abort.abort()
        }
      }
      if (finished) settle(await verify(concat(parts, size)))
    }

    const stop = async () => {
      settle(cancelled)
      abort.abort()
    }
    return {
      state: 'ok',
      value: { metadata: metadata.value, chunks: chunks(), ended, cancel: stop, close: stop },
    }
  }

  return { readRange, openStream }
}
