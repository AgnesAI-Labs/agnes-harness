import type { Outcome } from '@agnes/extension-api/runtime'
import type { ModelRecord } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  MAX_AUTHOR_INLINE_BYTES,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { buildWireRequest, type ModelCapture, modelInputDigest, type WireIdentity } from './wire-request.js'

export type CatalogPick = Readonly<{
  route: Readonly<{ route: string; api: string; baseUrl: string; compat?: unknown; keyless?: boolean }>
  model: ModelRecord
}>
export type InlineRef = Extract<W.DataRef, { kind: 'inline' }>
export const INFER_CHILD_KEY = 'adapter-invoke' as const
const ZERO = '0'.repeat(64)
const LIMITS = { maxBytes: MAX_AUTHOR_INLINE_BYTES, maxDepth: 128, maxMembers: 10000 }

export function refusal(code: W.RuntimeError['code'], detailCode: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Model request refused',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'model-provider',
    },
  }
}

/** The one mapping from a picked catalog entry to the digest input; the source reader uses this too. */
export function modelCaptureOf(adapterPackageDigest: string, picked: CatalogPick): ModelCapture {
  const { route } = picked
  return {
    adapterPackageDigest,
    route: {
      route: route.route,
      api: route.api,
      baseUrl: route.baseUrl,
      ...(route.compat === undefined ? {} : { compat: route.compat as W.JsonValue }),
      ...(route.keyless === undefined ? {} : { keyless: route.keyless }),
    },
    model: picked.model,
  }
}

/** What a route revision pins: the selected route and model only, never the other models of the catalog. */
export function selectionDigest(picked: CatalogPick): W.Digest {
  const { route, model } = modelCaptureOf('', picked)
  return canonicalJsonDigest({ route, model } as never)
}

/** Relation only: the handle is never trusted from here, and no secret is read. */
export function checkCredential(
  route: W.ModelRouteSnapshot,
  handle: W.SecretHandle | null,
  nowMs: number,
): Outcome<void> {
  const binding = route.credentialBinding
  if (binding === null)
    return handle === null ? { ok: true, value: undefined } : refusal('denied', 'model_credential_binding')
  if (
    handle === null ||
    binding.consumer !== 'model' ||
    binding.secretId !== handle.secretId ||
    binding.audience !== handle.audience ||
    route.credentialAudience !== handle.audience
  )
    return refusal('denied', 'model_credential_binding')
  return Date.parse(handle.expiresAt) > nowMs
    ? { ok: true, value: undefined }
    : refusal('denied', 'model_credential_expired')
}

export const preparedIdOf = (inputDigest: string) => `prep-${inputDigest.slice(0, 32)}`

export type PrepareParts = Readonly<{
  owner: W.BindingRef
  request: Pick<
    W.ModelPrepareRequest,
    'view' | 'route' | 'outputSchema' | 'toolCatalog' | 'generation' | 'sessionParameterRef' | 'credentialRef'
  >
  capture: ModelCapture
  wire: WireIdentity
  estimatedUnits: readonly W.ExactQuantity[]
}>

export function assemblePrepared(
  parts: PrepareParts,
): Outcome<Readonly<{ prepared: W.PreparedModelRequest; ref: InlineRef }>> {
  const { request } = parts
  const base: W.PreparedModelRequest = {
    preparedId: 'pending',
    ownerBinding: parts.owner,
    target: request.route,
    view: request.view,
    inputDigest: ZERO,
    outputSchema: request.outputSchema,
    toolCatalog: request.toolCatalog,
    generation: request.generation,
    mediaPlans: [],
    estimatedUnits: [...parts.estimatedUnits],
    hookResults: null,
    sessionParameterRef: request.sessionParameterRef,
    legacyRequestOverrides: null,
    credentialRef: request.credentialRef,
  }
  const inputDigest = modelInputDigest(base, parts.capture, parts.wire)
  const prepared: W.PreparedModelRequest = { ...base, preparedId: preparedIdOf(inputDigest), inputDigest }
  const wired = buildWireRequest(prepared, parts.capture, parts.wire)
  if (!wired.ok) return wired
  if (!validateRuntime('PreparedModelRequest', prepared).ok)
    return refusal('invalid_input', 'model_input_schema')
  const body = boundedCanonicalJson(prepared, LIMITS)
  if (!body.ok) return refusal('incompatible', 'model_prepared_too_large')
  return {
    ok: true,
    value: {
      prepared,
      ref: {
        kind: 'inline',
        schema: RuntimeSchemaRefs.PreparedModelRequest,
        value: body.value.json,
        digest: canonicalJsonDigest(body.value.json),
        bytes: body.value.bytes,
      },
    },
  }
}

export function externalKeyOf(runId: string, parentActionId: string): string {
  return `ext-${canonicalJsonDigest({ kind: 'agh.model/external-key@1', runId, parentActionId, key: INFER_CHILD_KEY })}`
}

export function adapterInvokeInput(preparedRef: W.DataRef, externalKey: string): Outcome<InlineRef> {
  const value = { preparedCallRef: preparedRef, externalIdempotencyKey: externalKey }
  if (!validateRuntime('ModelAdapterInvokeRequest', value).ok)
    return refusal('invalid_input', 'model_infer_input')
  const body = boundedCanonicalJson(value, LIMITS)
  if (!body.ok) return refusal('incompatible', 'model_prepared_too_large')
  return {
    ok: true,
    value: {
      kind: 'inline',
      schema: RuntimeMethodSchemaRefs['agh.model-adapter'].invoke.input,
      value: body.value.json,
      digest: canonicalJsonDigest(body.value.json),
      bytes: body.value.bytes,
    },
  }
}
