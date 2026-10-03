import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { boundedCanonicalJson, canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'

/** These checks belong to the selected backend, never to the request payload. */
export interface MemoryAccess {
  scope: Wire.ScopeRef
  tenantRef: string
  identity(context: CallContext): Wire.AuthenticatedIdentity
  authorize(method: string, item: Wire.MemoryItem | null, context: CallContext): boolean
  sourceAvailable(source: Wire.PublicRef, trust: Wire.MemoryItem['trust'], context: CallContext): boolean
}
export class MemoryFault extends Error {
  constructor(
    readonly code: Wire.RuntimeError['code'],
    readonly detail: string,
  ) {
    super(detail)
  }
}
export function refused(
  code: Wire.RuntimeError['code'],
  detailCode: string,
): { ok: false; error: Wire.RuntimeError } {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Memory operation refused',
      diagnosticId: 'memory-retrieval',
      retryAdvice: { kind: 'never' },
    },
  }
}
export function checkAccess(access: MemoryAccess, context: CallContext, closed: boolean): void {
  if (closed) throw new MemoryFault('denied', 'provider_closed')
  if (
    context.signal.aborted ||
    !Number.isFinite(Date.parse(context.deadline)) ||
    Date.parse(context.deadline) <= Date.now()
  )
    throw new MemoryFault('cancelled', 'request_cancelled')
  const expected = access.scope,
    actual = context.scope
  if (
    !('workspaceId' in expected) ||
    !('workspaceId' in actual) ||
    expected.installationId !== actual.installationId ||
    expected.runtimeId !== actual.runtimeId ||
    expected.workspaceId !== actual.workspaceId
  )
    throw new MemoryFault('denied', 'workspace_denied')
  const identity = access.identity(context)
  if (
    !validateRuntime('AuthenticatedIdentity', identity).ok ||
    identity.principalRef !== context.principalRef ||
    identity.tenantRef !== access.tenantRef ||
    Date.parse(identity.expiresAt) <= Date.now()
  )
    throw new MemoryFault('denied', 'tenant_denied')
}
export function allowed(
  access: MemoryAccess,
  method: string,
  item: Wire.MemoryItem | null,
  context: CallContext,
): boolean {
  return (
    access.authorize(method, item === null ? null : structuredClone(item), context) === true &&
    (item === null ||
      item.sourceRefs.every(
        (source) => access.sourceAvailable(structuredClone(source), item.trust, context) === true,
      ))
  )
}
export function inline(schema: Wire.SchemaRef, value: unknown): Outcome<Wire.DataRef> {
  const result = boundedCanonicalJson(value, { maxBytes: 16_384, maxDepth: 32, maxMembers: 4096 })
  if (!result.ok) return refused('quota', 'output_budget')
  return {
    ok: true,
    value: {
      kind: 'inline',
      schema,
      value: result.value.json,
      digest: canonicalJsonDigest(result.value.json),
      bytes: result.value.bytes,
    },
  }
}
export function decode(ref: Wire.DataRef, schema: Wire.SchemaRef): Outcome<unknown> {
  if (ref.kind !== 'inline') return refused('incompatible', 'blob_reader_required')
  const value = inline(schema, ref.value)
  if (
    !value.ok ||
    ref.schema.typeId !== schema.typeId ||
    ref.schema.revision !== schema.revision ||
    ref.schema.digest !== schema.digest ||
    value.value.kind !== 'inline' ||
    ref.digest !== value.value.digest ||
    ref.bytes !== value.value.bytes
  )
    return refused('invalid_input', 'input_reference_invalid')
  return { ok: true, value: ref.value }
}
/** Interrupt dependency reads even when a selected provider ignores cancellation. */
export async function interrupted<T>(read: Promise<T>, context: CallContext): Promise<T> {
  const timeout = new AbortController(),
    timer = setTimeout(
      () => timeout.abort(),
      Math.min(2_147_483_647, Math.max(1, Date.parse(context.deadline) - Date.now())),
    )
  const signal = AbortSignal.any([context.signal, timeout.signal])
  let abort = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new MemoryFault('cancelled', 'request_cancelled'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([read, cancelled])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
