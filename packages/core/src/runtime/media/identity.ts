import type { Outcome } from '@agnes/extension-api/runtime'
import type { RequestMediaHeader } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import { boundedCanonicalJson, canonicalJsonDigest } from '@agnes/protocol/runtime'
import type { RequestMediaLimits } from '../../orchestrator/request-media.js'
import { refuse } from './errors.js'
import { parseHeader, VISION_MAX_EDGE } from './legacy-bridge.js'

const local = (typeId: string): W.SchemaRef => ({
  typeId,
  revision: 1,
  digest: canonicalJsonDigest({ typeId, revision: 1 }),
})
export const MEDIA_NATIVE_SCHEMA = local('agh.media/transform-native@1')
export const MEDIA_IMAGE_TO_TEXT_SCHEMA = local('agh.media/transform-image-to-text@1')
export const MEDIA_PARAMETERS_SCHEMA = local('agh.media/parameters@1')
export const MEDIA_MANIFEST_SCHEMA = local('agh.media/manifest@1')
export const MEDIA_DERIVED_TEXT_SCHEMA = local('agh.media/derived-text@1')
export const MEDIA_BYTES_SCHEMA = local('agh.media/bytes@1')
/** Inline DataRef ceiling (65536) minus room for the manifest and the rest of the result. */
export const MEDIA_DERIVED_TEXT_MAX_BYTES = 49_152

export type MediaParameters = Readonly<{
  kind: 'agh.media/parameters@1'
  slot: 'image'
  maxEdge: number
  maxOutputTokens: number
  failurePolicy: 'fail' | 'degrade'
  allowConversion: boolean
  /** Per-source view node ordinal: non-decreasing, from 1, same length as `sourceRefs`. */
  nodes: readonly number[]
  limits: RequestMediaLimits
}>
export type RouteRetention = Readonly<{
  routeId: string
  routeRevision: number
  catalogRevision: number
  priceVersion: string
  model: string
  adapterBindingId: string
  endpointRef: string
  snapshotDigest: W.Digest
}>
export type ManifestSource = Readonly<{
  blobId: string
  digest: string
  bytes: number
  mediaType: string
  version: string
  manifestIndex: number
  blockIndex: number
  sourceTool: string
}>
export type MediaManifest = Readonly<{
  kind: 'native' | 'converted' | 'degraded' | 'omitted'
  planDigest: W.Digest
  header: RequestMediaHeader
  mediaHash: string
  sources: readonly ManifestSource[]
  authorizedBy: Readonly<{ principalRef: string; authorizationRef: string }>
  conversion: null | Readonly<{
    modelBinding: W.BindingRef
    route: RouteRetention
    promptDigest: W.Digest
    parserVersion: string
    inferInputDigest: W.Digest
    childActionId: string
    childReceiptId: string
    anchor: string
  }>
}>

export function pack(schema: W.SchemaRef, value: unknown, maxBytes = 65_536): Outcome<W.DataRef> {
  const bounded = boundedCanonicalJson(value, { maxBytes, maxDepth: 32, maxMembers: 10_000 })
  if (!bounded.ok) return refuse('quota', 'media_image_limit')
  return {
    ok: true,
    value: {
      kind: 'inline',
      schema,
      value: bounded.value.json,
      digest: canonicalJsonDigest(bounded.value.json),
      bytes: bounded.value.bytes,
    },
  }
}

export function unpack(ref: W.DataRef, schema: W.SchemaRef): Outcome<unknown> {
  if (ref.kind !== 'inline') return refuse('incompatible', 'media_input_schema')
  if (
    ref.schema.typeId !== schema.typeId ||
    ref.schema.revision !== schema.revision ||
    ref.schema.digest !== schema.digest
  )
    return refuse('invalid_input', 'media_input_schema')
  if (ref.digest !== canonicalJsonDigest(ref.value)) return refuse('invalid_input', 'media_input_schema')
  return { ok: true, value: ref.value }
}

const LIMIT_KEYS = [
  'maxManifestEntries',
  'maxSelectedImages',
  'maxSelectedBlocks',
  'maxBytesPerImage',
  'maxDimensionPerImage',
  'maxPixelsPerImage',
  'maxSelectedBytes',
  'maxSelectedPixels',
] as const
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const posInt = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= max

/** True only when every product limit is an explicit positive integer; there are no defaults to fall back on. */
export function limitsConfigured(limits: unknown): limits is RequestMediaLimits {
  return isRecord(limits) && LIMIT_KEYS.every((key) => posInt(limits[key]))
}

/** A plan may narrow the deployment's limits but never widen them. */
export function limitsWithin(plan: RequestMediaLimits, ceiling: RequestMediaLimits): boolean {
  return LIMIT_KEYS.every((key) => plan[key] <= ceiling[key])
}

export function packParameters(parameters: MediaParameters): Outcome<W.DataRef> {
  return pack(MEDIA_PARAMETERS_SCHEMA, parameters, 16_384)
}

export function parseParameters(ref: W.DataRef, sources: number): Outcome<MediaParameters> {
  const body = unpack(ref, MEDIA_PARAMETERS_SCHEMA)
  if (!body.ok) return body
  const v = body.value
  if (
    !isRecord(v) ||
    v.kind !== 'agh.media/parameters@1' ||
    v.slot !== 'image' ||
    !posInt(v.maxEdge, VISION_MAX_EDGE) ||
    !posInt(v.maxOutputTokens, 8192) ||
    (v.failurePolicy !== 'fail' && v.failurePolicy !== 'degrade') ||
    typeof v.allowConversion !== 'boolean' ||
    !Array.isArray(v.nodes) ||
    v.nodes.length !== sources ||
    !v.nodes.every((n, i) => posInt(n) && (i === 0 || (n as number) >= (v.nodes as number[])[i - 1]!)) ||
    !isRecord(v.limits) ||
    !LIMIT_KEYS.every((key) => posInt((v.limits as Record<string, unknown>)[key]))
  )
    return refuse('invalid_input', 'media_input_schema')
  return { ok: true, value: v as unknown as MediaParameters }
}

export function mediaSourceDigest(refs: readonly W.PublicRef[]): Outcome<W.Digest> {
  const sources: W.BlobRef[] = []
  for (const ref of refs) {
    if (ref.kind !== 'blob') return refuse('incompatible', 'media_source_kind')
    sources.push(ref.value)
  }
  return {
    ok: true,
    value: canonicalJsonDigest({ kind: 'agh.media/sources@1', sources } as unknown as W.JsonValue),
  }
}

export function retentionOf(route: W.ModelRouteSnapshot): RouteRetention {
  return {
    routeId: route.routeId,
    routeRevision: route.routeRevision,
    catalogRevision: route.catalogRevision,
    priceVersion: route.priceVersion,
    model: route.model,
    adapterBindingId: route.adapter.bindingId,
    endpointRef: route.endpointRef,
    snapshotDigest: canonicalJsonDigest(route as unknown as W.JsonValue),
  }
}

/** Identity of a conversion result: never the plan key, run or caller, and never an authorization. */
export function mediaCacheKey(
  plan: W.MediaPlan,
  conversion: null | { route: RouteRetention; promptDigest: W.Digest; parserVersion: string },
): W.Digest {
  return canonicalJsonDigest({
    kind: 'agh.media/cache@1',
    provider: plan.provider.providerId,
    transformSchema: plan.transformSchema,
    sourceDigest: plan.sourceDigest,
    parameters: plan.parameters.kind === 'inline' ? plan.parameters.digest : plan.parameters.blob.digest,
    targetFeatures: plan.targetFeatures,
    conversion,
  } as unknown as W.JsonValue)
}

const RANK = { external: 0, derived: 1, user: 2, system: 3 } as const
export function leastTrusted(values: readonly W.ContextItem['trust'][]): W.ContextItem['trust'] {
  return values.reduce(
    (low, value) => (RANK[value] < RANK[low] ? value : low),
    'system' as W.ContextItem['trust'],
  )
}

export const manifestRef = (manifest: MediaManifest): Outcome<W.DataRef> =>
  pack(MEDIA_MANIFEST_SCHEMA, manifest)

export function parseManifest(ref: W.DataRef): Outcome<MediaManifest> {
  const body = unpack(ref, MEDIA_MANIFEST_SCHEMA)
  if (!body.ok) return refuse('incompatible', 'media_verify_manifest')
  const v = body.value
  if (
    !isRecord(v) ||
    !['native', 'converted', 'degraded', 'omitted'].includes(v.kind as string) ||
    typeof v.planDigest !== 'string' ||
    typeof v.mediaHash !== 'string' ||
    !Array.isArray(v.sources) ||
    !isRecord(v.authorizedBy) ||
    (v.conversion !== null && !isRecord(v.conversion))
  )
    return refuse('incompatible', 'media_verify_manifest')
  const header = parseHeader(v.header)
  if (!header.ok) return refuse('incompatible', 'media_verify_manifest')
  return { ok: true, value: { ...(v as unknown as MediaManifest), header: header.value } }
}

export function derivedTextRef(framed: string): Outcome<W.DataRef> {
  if (Buffer.byteLength(framed, 'utf8') > MEDIA_DERIVED_TEXT_MAX_BYTES)
    return refuse('quota', 'media_derived_too_large')
  return pack(MEDIA_DERIVED_TEXT_SCHEMA, { kind: 'agh.media/derived-text@1', text: framed })
}
