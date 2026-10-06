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
import type { PreparedEntry } from './prepared-registry.js'
import { buildWireRequest, type ModelCapture, modelInputDigest, type WireIdentity } from './wire-request.js'
import type { ResolvedTools } from './wire-tools.js'

export type CatalogPick = Readonly<{
  route: Readonly<{ route: string; api: string; baseUrl: string; compat?: unknown; keyless?: boolean }>
  model: ModelRecord
}>
export type InlineRef = Extract<W.DataRef, { kind: 'inline' }>
export const INFER_CHILD_KEY = 'adapter-invoke' as const
const HANDLE_KIND = 'agh.model/prepared-handle@1' as const
const ZERO = '0'.repeat(64)
const LIMITS = { maxBytes: MAX_AUTHOR_INLINE_BYTES, maxDepth: 128, maxMembers: 10000 }

/** An unresolved effect is reconciled by its owner; every other refusal is final. */
export function refusal(
  code: W.RuntimeError['code'],
  detailCode: string,
  owner?: W.OwnerRef,
): Outcome<never> {
  if (code === 'unknown_effect' && !owner) throw new TypeError('unknown_effect needs an owner')
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Model request refused',
      retryAdvice:
        owner && code === 'unknown_effect' ? { kind: 'reconcile', ownerRef: owner } : { kind: 'never' },
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

/** Deterministic over run, session and input, so a replay of the same preparation names the same handle. */
export const handleIdOf = (binding: { runId: string; sessionId: string; inputDigest: string }) =>
  `hdl-${canonicalJsonDigest({ kind: HANDLE_KIND, ...binding }).slice(0, 32)}`

/** The facts a later check compares without the prepared body; no secret and no request text. */
export function headerOf(
  prepared: W.PreparedModelRequest,
  capture: ModelCapture,
  wire: WireIdentity,
): W.PreparedModelHeader {
  return {
    route: prepared.target,
    adapterPackageDigest: capture.adapterPackageDigest,
    maxOutputTokens: prepared.generation.maxOutputTokens,
    thinking: prepared.generation.thinking,
    wire: {
      slot: wire.slot,
      contractId: wire.contractId,
      sessionKeyDigest: canonicalJsonDigest({ kind: 'agh.model/session-key@1', sessionKey: wire.sessionKey }),
    },
    sessionParameterRef: prepared.sessionParameterRef,
    credentialRef: prepared.credentialRef,
    mediaPlanDigests: prepared.mediaPlans.map((plan) => canonicalJsonDigest(plan as never)),
  }
}

/** The handle reference exactly as the caller sent it: schema, digest and byte count must all be its own body's. */
export function decodeHandle(
  ref: W.DataRef,
): Readonly<{ ref: InlineRef; handle: W.PreparedModelHandle }> | null {
  const body = ref.kind === 'inline' ? boundedCanonicalJson(ref.value, LIMITS) : null
  if (
    ref.kind !== 'inline' ||
    !body?.ok ||
    canonicalJsonDigest(ref.schema as never) !== canonicalJsonDigest(RuntimeSchemaRefs.PreparedModelHandle) ||
    ref.digest !== canonicalJsonDigest(ref.value) ||
    ref.bytes !== body.value.bytes
  )
    return null
  const parsed = validateRuntime('PreparedModelHandle', ref.value)
  return parsed.ok && parsed.value.kind === HANDLE_KIND ? { ref, handle: parsed.value } : null
}

export type PrepareParts = Readonly<{
  runId: string
  sessionId: string
  owner: W.BindingRef
  request: Pick<
    W.ModelPrepareRequest,
    'view' | 'route' | 'outputSchema' | 'toolCatalog' | 'generation' | 'sessionParameterRef' | 'credentialRef'
  >
  capture: ModelCapture
  wire: WireIdentity
  estimatedUnits: readonly W.ExactQuantity[]
  /** The resolver's answer for the request's tool catalog; null when it carries none or none could be resolved. */
  tools?: ResolvedTools | null
}>

export function assemblePrepared(parts: PrepareParts): Outcome<
  Readonly<{
    prepared: W.PreparedModelRequest
    ref: InlineRef
    handleId: string
    entry: PreparedEntry
  }>
> {
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
  const tools = parts.tools ?? null
  const inputDigest = modelInputDigest(base, parts.capture, parts.wire, tools)
  const prepared: W.PreparedModelRequest = { ...base, preparedId: preparedIdOf(inputDigest), inputDigest }
  const wired = buildWireRequest(prepared, parts.capture, parts.wire, [], tools)
  if (!wired.ok) return wired
  if (!validateRuntime('PreparedModelRequest', prepared).ok)
    return refusal('invalid_input', 'model_input_schema')
  if (!boundedCanonicalJson(prepared, LIMITS).ok) return refusal('incompatible', 'model_prepared_too_large')
  const header = headerOf(prepared, parts.capture, parts.wire)
  const handleId = handleIdOf({ runId: parts.runId, sessionId: parts.sessionId, inputDigest })
  const handle: W.PreparedModelHandle = {
    kind: HANDLE_KIND,
    handleId,
    inputDigest,
    ownerBinding: parts.owner,
    header,
  }
  if (!validateRuntime('PreparedModelHandle', handle).ok)
    return refusal('invalid_input', 'model_input_schema')
  const body = boundedCanonicalJson(handle, LIMITS)
  if (!body.ok) return refusal('incompatible', 'model_prepared_too_large')
  return {
    ok: true,
    value: {
      prepared,
      handleId,
      ref: {
        kind: 'inline',
        schema: RuntimeSchemaRefs.PreparedModelHandle,
        value: body.value.json,
        digest: canonicalJsonDigest(body.value.json),
        bytes: body.value.bytes,
      },
      entry: {
        runId: parts.runId,
        sessionId: parts.sessionId,
        ownerBinding: parts.owner,
        inputDigest,
        header,
        prepared,
        capture: parts.capture,
        wire: parts.wire,
        request: wired.value,
        resolvedTools: tools,
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
