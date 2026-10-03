import { createHash } from 'node:crypto'
import type { BlobReadPort, CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'

export function embeddingRef(schema: W.SchemaRef, value: unknown): W.DataRef {
  const parsed = boundedCanonicalJson(value, { maxBytes: 65536, maxDepth: 32, maxMembers: 10000 })
  if (!parsed.ok) throw new TypeError('Invalid bounded embedding data')
  return {
    kind: 'inline',
    schema,
    value: parsed.value.json,
    digest: canonicalJsonDigest(parsed.value.json),
    bytes: Buffer.byteLength(jcs(parsed.value.json)),
  }
}
export function embeddingFailure(
  code: W.RuntimeError['code'],
  detailCode: string,
): W.EffectResult & { error: W.RuntimeError } {
  return {
    outcome: code === 'unknown_effect' ? 'unknown_effect' : code === 'cancelled' ? 'cancelled' : 'failed',
    error: {
      code,
      detailCode,
      message: 'Embedding request refused',
      diagnosticId: 'embedding',
      retryAdvice: { kind: 'never' },
    },
    externalRequests: [],
    usage: [],
    references: [],
  }
}
export async function embeddingData(
  ref: W.DataRef,
  schema: W.SchemaRef,
  call: CallContext,
  blobRead?: BlobReadPort,
): Promise<W.JsonValue> {
  if (!validateRuntime('DataRef', ref).ok || jcs(ref.schema) !== jcs(schema))
    throw new TypeError('Invalid reference')
  let value: unknown
  if (ref.kind === 'inline') {
    value = ref.value
    const safe = boundedCanonicalJson(value, { maxBytes: 65536, maxDepth: 32, maxMembers: 10000 })
    if (
      !safe.ok ||
      ref.digest !== canonicalJsonDigest(safe.value.json) ||
      ref.bytes !== Buffer.byteLength(jcs(safe.value.json))
    )
      throw new TypeError('Invalid inline content')
    value = safe.value.json
  } else {
    if (!blobRead || ref.blob.bytes < 1 || ref.blob.bytes > 1048576)
      throw new TypeError('Blob unavailable or oversized')
    const read = await interruptible(
      blobRead.readRange({ ref: ref.blob, offset: 0, length: ref.blob.bytes }, call),
      call.signal,
    )
    if (
      !read.ok ||
      read.value.offset !== 0 ||
      read.value.totalBytes !== ref.blob.bytes ||
      read.value.bytes.length !== ref.blob.bytes ||
      read.value.digest !== ref.blob.digest ||
      createHash('sha256').update(read.value.bytes).digest('hex') !== ref.blob.digest
    )
      throw new TypeError('Invalid blob content')
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.value.bytes))
    if (!boundedCanonicalJson(value, { maxBytes: 1048576, maxDepth: 32, maxMembers: 1000000 }).ok)
      throw new TypeError('Invalid bounded blob')
  }
  return value as W.JsonValue
}
export async function readEmbeddingVectors(
  ref: W.DataRef,
  request: W.EmbeddingEncodeRequest,
  call: CallContext,
  blobRead?: BlobReadPort,
): Promise<Outcome<W.EmbeddingVectors>> {
  try {
    const value = await embeddingData(ref, RuntimeSchemaRefs.EmbeddingVectors, call, blobRead)
    const parsed = validateRuntime('EmbeddingVectors', value)
    if (
      !parsed.ok ||
      !Number.isInteger(request.dimensions) ||
      request.dimensions < 1 ||
      request.dimensions > 10000 ||
      parsed.value.length !== request.inputRefs.length ||
      parsed.value.some(
        (row) =>
          row.length !== request.dimensions ||
          Array.from(row).some((n) => !Number.isFinite(n)) ||
          (request.normalize && Math.abs(Math.hypot(...row) - 1) > 1e-6),
      )
    )
      return { ok: false, error: embeddingFailure('invalid_input', 'embedding_vectors').error }
    return { ok: true, value: parsed.value }
  } catch {
    return { ok: false, error: embeddingFailure('invalid_input', 'embedding_vectors').error }
  }
}
export function interruptible<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error('Interrupted'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    task
      .then((value) => (signal.aborted ? cancel() : resolve(value)), reject)
      .finally(() => signal.removeEventListener('abort', cancel))
  })
}
