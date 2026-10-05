import type { ModelAdapterDeployment, ModelWireSource } from '@agnes/ai/runtime'
import { buildWireRequest, type ModelCapture, modelInputDigest, type WireIdentity } from '@agnes/core'
import type { ActionContext, CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs, type SlotName } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  type ActionFrame,
  canonicalJsonDigest,
  type DataRef,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { SelectedModelCatalog } from './model-catalog-capture.js'

export type IssuedPrepared = Readonly<{
  preparedDigest: Wire.Digest
  actionId: string
  captureDigest: string
  wire: WireIdentity
}>
export type ModelSourcePorts = Readonly<{
  packageDigest: string
  issuance: Readonly<{
    read(
      prepared: Wire.PreparedModelRequest,
      frame: ActionFrame,
      context: ActionContext,
    ): Promise<Outcome<IssuedPrepared>>
  }>
  captures: Readonly<{ read(captureDigest: string): SelectedModelCatalog | undefined }>
  prices: Readonly<{ version(target: Wire.ModelRouteSnapshot, capture: ModelCapture): string | null }>
  session: Readonly<{
    parameters(
      ref: Wire.DomainReference,
      context: ActionContext,
    ): Promise<Outcome<Wire.SessionParameterRevision>>
  }>
  authorize: Readonly<{ epoch(call: CallContext): number }>
}>
export type ModelSourceReader = Pick<ModelAdapterDeployment, 'load' | 'current'>

const refusal = (detailCode: string, code: 'denied' | 'internal' = 'denied'): Outcome<never> => ({
  ok: false,
  error: {
    code,
    detailCode,
    message: 'Model source refused',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'model-source',
  },
})
const aborted = (call: CallContext) => (call.signal as AbortSignal | undefined)?.aborted === true
const same = (a: unknown, b: unknown) => canonicalJsonDigest(a as never) === canonicalJsonDigest(b as never)

function decodePrepared(ref: DataRef): Outcome<Wire.PreparedModelRequest> {
  if (
    ref.kind !== 'inline' ||
    !same(ref.schema, RuntimeSchemaRefs.PreparedModelRequest) ||
    ref.digest !== canonicalJsonDigest(ref.value) ||
    ref.bytes !== new TextEncoder().encode(jcs(ref.value)).length
  )
    return refusal('model_source_ref')
  const parsed = validateRuntime('PreparedModelRequest', ref.value)
  return parsed.ok ? { ok: true, value: parsed.value } : refusal('model_source_ref')
}

function frameBinds(frame: ActionFrame, ref: DataRef): boolean {
  if (frame.requestIdentity === null || frame.input.kind !== 'inline') return false
  const request = validateRuntime('ModelAdapterInvokeRequest', frame.input.value)
  return (
    request.ok &&
    same(request.value.preparedCallRef, ref) &&
    request.value.externalIdempotencyKey === frame.requestIdentity.idempotencyKey
  )
}

type Pair = { route?: string; model?: string }
/** The recorded slot, and only that slot, must name the target, directly or as one of its fallbacks. */
function slotAllows(parameters: unknown, slot: SlotName, route: string, model: string): boolean {
  const table = (
    parameters as { model?: { route?: Record<string, (Pair & { fallbacks?: Pair[] }) | undefined> } } | null
  )?.model?.route
  const entry = table?.[slot]
  const matches = (candidate?: Pair) => candidate?.route === route && candidate?.model === model
  return entry !== undefined && (matches(entry) || (entry.fallbacks?.some(matches) ?? false))
}

export function createModelSourceReader(ports: ModelSourcePorts): ModelSourceReader {
  const loaded = new WeakMap<ActionFrame, { source: ModelWireSource; call: CallContext; epoch: number }>()
  return {
    async load(ref, frame, context) {
      const decoded = decodePrepared(ref)
      if (!decoded.ok) return decoded
      const prepared = decoded.value
      const digest = (ref as { digest: string }).digest
      if (!frameBinds(frame, ref)) return refusal('model_source_frame')
      // The call and epoch are fixed at entry; every await and the publish re-check them.
      const call = context.call
      const epoch = ports.authorize.epoch(call)
      const stale = () => aborted(call) || ports.authorize.epoch(call) !== epoch
      const issued = await ports.issuance.read(prepared, frame, context)
      if (stale()) return refusal('model_source_stale')
      if (!issued.ok) return issued
      if (issued.value.preparedDigest !== digest || issued.value.actionId !== frame.actionId)
        return refusal('model_source_issuance')
      const catalog = ports.captures.read(issued.value.captureDigest)
      const picked = catalog?.select(prepared.target.routeId, prepared.target.model)
      if (!picked) return refusal('model_source_capture')
      const route = picked.route
      const capture: ModelCapture = {
        adapterPackageDigest: ports.packageDigest,
        route: {
          route: route.route,
          api: route.api,
          baseUrl: route.baseUrl,
          ...(route.compat === undefined ? {} : { compat: route.compat as Wire.JsonValue }),
          ...(route.keyless === undefined ? {} : { keyless: route.keyless }),
        },
        model: picked.model,
      }
      const price = ports.prices.version(prepared.target, capture)
      if (price === null) return refusal('model_source_not_ready', 'internal')
      if (price !== prepared.target.priceVersion) return refusal('model_source_price')
      if (modelInputDigest(prepared, capture, issued.value.wire) !== prepared.inputDigest)
        return refusal('model_source_drift')
      const parameters = await ports.session.parameters(prepared.sessionParameterRef, context)
      if (stale()) return refusal('model_source_stale')
      if (!parameters.ok) return parameters
      if (
        !slotAllows(parameters.value.parameters, issued.value.wire.slot, route.route, prepared.target.model)
      )
        return refusal('model_source_slot')
      const request = buildWireRequest(prepared, capture, issued.value.wire)
      if (!request.ok) return request
      const source: ModelWireSource = { prepared, route, model: picked.model, request: request.value }
      if (stale()) return refusal('model_source_stale')
      loaded.set(frame, { source, call, epoch })
      return { ok: true, value: source }
    },
    current(source, frame, call) {
      const entry = loaded.get(frame)
      return entry?.source === source && entry.call === call && !aborted(call) && ports.authorize.epoch(call) === entry.epoch
    },
  }
}
