import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type Digest,
  MAX_AUTHOR_INLINE_BYTES,
  type ModelRouteSnapshot,
  type PreparedModelRequest,
  type ProviderDescriptor,
  RuntimeMethodSchemaRefs,
  type SchemaRef,
  validateRuntime,
} from '@agnes/protocol/runtime'

export type PreparedRouteSource = {
  readonly route: ModelRouteSnapshot
  readonly definition: DataRef
  readonly descriptor: ProviderDescriptor
  readonly transformDigest: Digest
  readonly preparedSchema: SchemaRef
}
export type PreparedRouteProof = Readonly<{
  preparedId: string
  inputDigest: Digest
  routeDigest: Digest
  definitionDigest: Digest
  descriptorDigest: Digest
  transformDigest: Digest
  priceVersion: string
  preparedSchema: SchemaRef
  selectInputSchema: SchemaRef
  selectOutputSchema: SchemaRef
}>

/** The installed owner verifies its source relation, rather than accepting a caller's proof JSON. */
export interface PreparedRouteOwner {
  current(source: PreparedRouteSource, context: CallContext): boolean
}
const same = (a: unknown, b: unknown) => canonicalJsonDigest(a as never) === canonicalJsonDigest(b as never)
const denied = (): Outcome<never> => ({
  ok: false,
  error: {
    code: 'denied',
    detailCode: 'prepared_route_source',
    message: 'Prepared route source refused',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'prepared-route',
  },
})

export function capturePreparedRoute(
  request: PreparedModelRequest,
  source: PreparedRouteSource,
  owner: PreparedRouteOwner,
  context: CallContext,
): Outcome<PreparedRouteProof> {
  if (
    !validateRuntime('PreparedModelRequest', request).ok ||
    !validateRuntime('ProviderDescriptor', source.descriptor).ok ||
    !validateRuntime('DataRef', source.definition).ok ||
    !validateRuntime('SchemaRef', source.preparedSchema).ok
  )
    return denied()
  if (
    source.descriptor.contract !== 'agh.model-adapter' ||
    source.descriptor.providerId !== request.target.adapter.providerId ||
    request.target.adapter.contract !== 'agh.model-adapter' ||
    !same(request.target, source.route) ||
    source.definition.kind !== 'inline' ||
    source.definition.digest !== canonicalJsonDigest(source.definition.value) ||
    source.transformDigest !== canonicalJsonDigest(request.mediaPlans)
  )
    return denied()
  const definition = boundedCanonicalJson(source.definition.value, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES,
    maxDepth: 128,
    maxMembers: 10000,
  })
  if (!definition.ok || definition.value.bytes !== source.definition.bytes) return denied()
  const originalSignal = context.signal
  const contextView = () =>
    canonicalJsonDigest({
      principalRef: context.principalRef,
      scope: context.scope,
      bindingId: context.bindingId,
      invocationId: context.invocationId,
      deadline: context.deadline,
      traceRef: context.traceRef,
      authorizationRef: context.authorizationRef,
    })
  const contextSnapshot = contextView()
  const captured = canonicalJsonDigest({ request, source })
  let current = false
  try {
    current = owner.current(source, context) === true
  } catch {
    return denied()
  }
  if (
    !current ||
    context.signal !== originalSignal ||
    contextView() !== contextSnapshot ||
    context.signal.aborted ||
    Date.parse(context.deadline) <= Date.now() ||
    !Number.isFinite(Date.parse(context.deadline)) ||
    captured !== canonicalJsonDigest({ request, source })
  )
    return denied()
  return {
    ok: true,
    value: Object.freeze({
      preparedId: request.preparedId,
      inputDigest: request.inputDigest,
      routeDigest: canonicalJsonDigest(request.target),
      definitionDigest: source.definition.digest,
      descriptorDigest: canonicalJsonDigest(source.descriptor),
      transformDigest: source.transformDigest,
      priceVersion: request.target.priceVersion,
      preparedSchema: Object.freeze({ ...source.preparedSchema }),
      selectInputSchema: RuntimeMethodSchemaRefs['agh.routing'].select.input,
      selectOutputSchema: RuntimeMethodSchemaRefs['agh.routing'].select.output,
    }),
  }
}
