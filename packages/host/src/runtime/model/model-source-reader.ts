import type { ModelAdapterDeployment, ModelWireSource } from '@agnes/ai/runtime'
import {
  buildWireRequest,
  decodeHandle,
  handleIdOf,
  type ModelCapture,
  modelInputDigest,
  type PreparedRegistry,
  toModelWireMedia,
} from '@agnes/core'
import type { ActionContext, CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { SlotName } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { type ActionFrame, canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { type MediaResultSource, MODEL_SOURCE_MEDIA } from './model-media-source.js'

export type ModelSourcePorts = Readonly<{
  /** The adapter package this process runs; the prepared call must have been built against it. */
  packageDigest: string
  /** The registry the model provider writes in this process; a miss is a normal outcome, never a re-prepare. */
  registry: Pick<PreparedRegistry, 'get'>
  prices: Readonly<{ version(target: Wire.ModelRouteSnapshot, capture: ModelCapture): string | null }>
  session: Readonly<{
    parameters(
      ref: Wire.DomainReference,
      context: ActionContext,
    ): Promise<Outcome<Wire.SessionParameterRevision>>
  }>
  authorize: Readonly<{ epoch(call: CallContext): number }>
  /** Supplies the verified media a prepared call with media plans needs; without it such a call is refused. */
  media?: MediaResultSource
}>
export type ModelSourceReader = Pick<ModelAdapterDeployment, 'load' | 'current'>

const refusal = (
  detailCode: string,
  code: 'denied' | 'internal' | 'incompatible' = 'denied',
): Outcome<never> => ({
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

function frameBinds(frame: ActionFrame, digest: string): boolean {
  if (frame.requestIdentity === null || frame.input.kind !== 'inline') return false
  const request = validateRuntime('ModelAdapterInvokeRequest', frame.input.value)
  return (
    request.ok &&
    request.value.preparedCallRef.kind === 'inline' &&
    request.value.preparedCallRef.digest === digest &&
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

/** The detail code of a registry miss; the adapter turns it into a stored result, unknown effect or a named failure. */
export const PREPARED_LOST = 'model_prepared_lost'

export function createModelSourceReader(ports: ModelSourcePorts): ModelSourceReader {
  const loaded = new WeakMap<
    ActionFrame,
    { source: ModelWireSource; call: CallContext; epoch: number; mediaEpoch: string | null }
  >()
  return {
    async load(ref, frame, context) {
      // The call and epoch are fixed before the first await; every await and the publish re-check them.
      const call = context.call
      const epoch = ports.authorize.epoch(call)
      const stale = () => aborted(call) || ports.authorize.epoch(call) !== epoch
      const decoded = decodeHandle(ref)
      if (!decoded) return refusal('model_source_ref')
      const { handle } = decoded
      if (!frameBinds(frame, decoded.ref.digest)) return refusal('model_source_frame')
      const scope = call.scope
      if ((scope.kind !== 'run' && scope.kind !== 'action') || frame.runId !== scope.runId)
        return refusal('model_source_frame')
      const { sessionId } = scope
      if (handle.handleId !== handleIdOf({ runId: frame.runId, sessionId, inputDigest: handle.inputDigest }))
        return refusal('model_source_frame')
      const entry = ports.registry.get(handle.handleId)
      if (!entry) return refusal(PREPARED_LOST, 'incompatible')
      if (
        entry.runId !== frame.runId ||
        entry.sessionId !== sessionId ||
        entry.inputDigest !== handle.inputDigest ||
        !same(entry.ownerBinding, handle.ownerBinding) ||
        !same(entry.header, handle.header)
      )
        return refusal('model_source_drift')
      const { prepared, capture, wire } = entry
      if (capture.adapterPackageDigest !== ports.packageDigest) return refusal('model_source_drift')
      const price = ports.prices.version(prepared.target, capture)
      if (price === null) return refusal('model_source_not_ready', 'internal')
      if (price !== prepared.target.priceVersion) return refusal('model_source_price')
      if (
        modelInputDigest(prepared, capture, wire) !== prepared.inputDigest ||
        entry.inputDigest !== prepared.inputDigest
      )
        return refusal('model_source_drift')
      const parameters = await ports.session.parameters(prepared.sessionParameterRef, context)
      if (stale()) return refusal('model_source_stale')
      if (!parameters.ok) return parameters
      if (
        !slotAllows(parameters.value.parameters.value, wire.slot, capture.route.route, prepared.target.model)
      )
        return refusal('model_source_slot')
      const route = { ...capture.route, models: [capture.model] } as unknown as ModelWireSource['route']
      let source: ModelWireSource = { prepared, route, model: capture.model, request: entry.request }
      let mediaEpoch: string | null = null
      if (prepared.mediaPlans.length > 0) {
        // The request body carries media only the Host verified now, from receipts, under current access.
        if (!ports.media) return refusal(MODEL_SOURCE_MEDIA)
        mediaEpoch = ports.media.epoch(call)
        const media = await ports.media.read(entry, frame, call)
        if (stale()) return refusal('model_source_stale')
        if (!media.ok) return media
        const request = buildWireRequest(prepared, capture, wire, media.value)
        if (!request.ok) return request
        source = { ...source, request: request.value, media: media.value.map(toModelWireMedia) }
      }
      if (stale()) return refusal('model_source_stale')
      loaded.set(frame, { source, call, epoch, mediaEpoch })
      return { ok: true, value: source }
    },
    current(source, frame, call) {
      const entry = loaded.get(frame)
      return (
        entry?.source === source &&
        entry.call === call &&
        !aborted(call) &&
        ports.authorize.epoch(call) === entry.epoch &&
        (entry.mediaEpoch === null || ports.media?.epoch(call) === entry.mediaEpoch)
      )
    },
  }
}
