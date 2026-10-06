import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { boundedCanonicalJson, canonicalJsonDigest, RuntimeAuthorCodecPolicy } from '@agnes/protocol/runtime'

/** Inline payload ceiling (MAX_AUTHOR_INLINE_BYTES). Larger payloads travel as blobs and are outside the first slice. */
export const INLINE_LIMIT = 65_536
const DIAGNOSTIC = 'default-supervisor'

export function fail(
  code: W.RuntimeError['code'],
  detailCode: string,
  retryAdvice: W.RuntimeError['retryAdvice'] = { kind: 'never' },
): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Supervisor refused the operation',
      retryAdvice,
      diagnosticId: DIAGNOSTIC,
    },
  }
}

export function canonical(value: unknown): { json: W.JsonValue; bytes: number } | null {
  const policy = RuntimeAuthorCodecPolicy.payload
  const bounded = boundedCanonicalJson(value, {
    maxBytes: policy.maxCanonicalJsonBytes,
    maxDepth: policy.maxDepth,
    maxMembers: policy.maxMembers,
  })
  return bounded.ok ? bounded.value : null
}

export function equal(a: unknown, b: unknown): boolean {
  const left = canonical(a)
  const right = canonical(b)
  return left !== null && right !== null && canonicalJsonDigest(left.json) === canonicalJsonDigest(right.json)
}

export function encodeInline(schema: W.SchemaRef, value: unknown): Outcome<W.DataRef> {
  const body = canonical(value)
  if (!body) return fail('quota', 'inline_data_bytes')
  if (body.bytes > INLINE_LIMIT) return fail('quota', 'inline_data_bytes')
  return {
    ok: true,
    value: {
      kind: 'inline',
      schema,
      value: body.json,
      digest: canonicalJsonDigest(body.json),
      bytes: body.bytes,
    },
  }
}

export function decodeInline(ref: W.DataRef, schema: W.SchemaRef): Outcome<W.JsonValue> {
  if (ref.kind !== 'inline' || !equal(ref.schema, schema))
    return fail('invalid_input', 'supervisor_input_invalid')
  const body = canonical(ref.value)
  if (!body || body.bytes !== ref.bytes || canonicalJsonDigest(body.json) !== ref.digest)
    return fail('invalid_input', 'supervisor_input_invalid')
  return { ok: true, value: body.json }
}

/** Abort and deadline are enforced by racing, never by re-wrapping the identity-issued context object. */
export async function race<T>(work: Promise<Outcome<T>>, context: CallContext): Promise<Outcome<T>> {
  let release = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = new Promise<Outcome<never>>((resolve) => {
    const abort = () => resolve(fail('cancelled', 'cancelled'))
    if (context.signal.aborted) abort()
    else context.signal.addEventListener('abort', abort, { once: true })
    release = () => context.signal.removeEventListener('abort', abort)
    timer = setTimeout(
      () => resolve(fail('timeout', 'supervisor_invocation_expired')),
      Math.min(2_147_483_647, Math.max(0, Date.parse(context.deadline) - Date.now())),
    )
  })
  try {
    return await Promise.race([work, stopped])
  } finally {
    release()
    clearTimeout(timer)
  }
}
