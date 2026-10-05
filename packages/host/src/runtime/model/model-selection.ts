import type { ManualRoute } from '@agnes/ai'
import type { Outcome } from '@agnes/extension-api/runtime'
import type { ModelRecord, SlotName, ThinkingLevel } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'
import type { SelectedModelCatalog } from './model-catalog-capture.js'

/** The slot the default loop's model stages use; the model service resolves its wire identity with the same one. */
export const LOOP_MODEL_SLOT: SlotName = 'primary'

export type SelectionRoutes = Readonly<{
  declared(route: string): boolean
  snapshot(
    pick: Readonly<{ route: ManualRoute; model: ModelRecord; catalogDigest: string }>,
  ): Wire.ModelRouteSnapshot | undefined
}>

export type ResolvedSelection = Readonly<{
  slot: SlotName
  route: string
  model: string
  record: ModelRecord
  snapshot: Wire.ModelRouteSnapshot
  thinking: ThinkingLevel | null
  catalogDigest: string
}>

export function selectionRefusal(
  code: 'invalid_input' | 'denied' | 'incompatible' | 'conflict' | 'internal',
  detailCode: string,
): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Model selection refused',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'model-selection',
    },
  }
}
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value })

/** A level is supported on a reasoning model that lists it, or on one that lists none. */
export function supportsThinking(record: ModelRecord, level: ThinkingLevel): boolean {
  return record.reasoning && (!record.thinkingLevelMap || level in record.thinkingLevelMap)
}

export function thinkingForRequest(
  level: ThinkingLevel | undefined,
  record: ModelRecord,
): Outcome<ThinkingLevel | null> {
  if (level === undefined) return ok(null)
  return supportsThinking(record, level)
    ? ok(level)
    : selectionRefusal('incompatible', 'model_selection_thinking')
}

export function resolveThinkingOnSwitch(input: {
  prior: ThinkingLevel | undefined
  sameModel: boolean
  requested: ThinkingLevel | null
  record: ModelRecord
}): Outcome<ThinkingLevel | undefined> {
  const { prior, sameModel, requested, record } = input
  if (requested !== null)
    return supportsThinking(record, requested)
      ? ok(requested)
      : selectionRefusal('incompatible', 'model_selection_thinking')
  if (prior !== undefined && supportsThinking(record, prior)) return ok(prior)
  return ok(sameModel ? undefined : record.defaultSettings?.thinking)
}

function offers(have: Wire.ModelFeatures, need: Wire.ModelFeatures): boolean {
  return (
    need.input.every((kind) => have.input.includes(kind)) &&
    need.output.every((kind) => have.output.includes(kind)) &&
    (!need.tools || have.tools) &&
    (!need.structuredOutput || have.structuredOutput) &&
    (!need.streaming || have.streaming)
  )
}

type PickedModel = Readonly<{ route: ManualRoute; model: ModelRecord }>
function pickedSnapshot(
  routes: SelectionRoutes,
  catalog: SelectedModelCatalog,
  route: string,
  model: string,
): Outcome<Readonly<{ picked: PickedModel; snapshot: Wire.ModelRouteSnapshot }>> {
  if (!routes.declared(route)) return selectionRefusal('denied', 'model_selection_route')
  const picked = catalog.select(route, model)
  if (!picked) return selectionRefusal('denied', 'model_selection_route')
  const snapshot = routes.snapshot({ ...picked, catalogDigest: catalog.digest })
  if (!snapshot || snapshot.routeId !== route || snapshot.model !== model)
    return selectionRefusal('internal', 'model_selection_not_ready')
  return ok({ picked, snapshot })
}

/**
 * The pair a revision selects for a slot, checked against the current catalog. Only the slot's main
 * entry is used: a failure is a refusal, never a different route, fallback or the previous choice.
 */
export function resolveSessionModelSelection(input: {
  revision: Wire.SessionParameterRevision
  slot: SlotName
  catalog: SelectedModelCatalog
  routes: SelectionRoutes
  needs: Wire.ModelFeatures
}): Outcome<ResolvedSelection> {
  const parsed = validateRuntime('DefaultSessionParameters', input.revision.parameters.value)
  if (!parsed.ok) return selectionRefusal('incompatible', 'model_selection_parameters')
  const entry = parsed.value.model?.route?.[input.slot]
  if (!entry) return selectionRefusal('incompatible', 'model_selection_slot')
  const found = pickedSnapshot(input.routes, input.catalog, entry.route, entry.model)
  if (!found.ok) return found
  const { picked, snapshot } = found.value
  const thinking = thinkingForRequest(parsed.value.model?.thinking?.[input.slot], picked.model)
  if (!thinking.ok) return thinking
  if (!offers(snapshot.features, input.needs))
    return selectionRefusal('incompatible', 'model_selection_features')
  return ok({
    slot: input.slot,
    route: entry.route,
    model: entry.model,
    record: picked.model,
    snapshot,
    thinking: thinking.value,
    catalogDigest: input.catalog.digest,
  })
}

/** Run by the session control writer before it accepts a switch; a refusal leaves the old state as it was. */
export function checkModelSwitch(input: {
  request: Readonly<{ slot: SlotName; route: string; model: string; thinking: ThinkingLevel | null }>
  prior: Readonly<{ route: string; model: string; thinking: ThinkingLevel | undefined }> | undefined
  catalog: SelectedModelCatalog
  routes: SelectionRoutes
  needs: Wire.ModelFeatures
  credentials: Readonly<{ bound(binding: Wire.SecretConsumerBinding): boolean }>
}): Outcome<Readonly<{ thinking: ThinkingLevel | undefined; snapshot: Wire.ModelRouteSnapshot }>> {
  const { request, prior } = input
  const found = pickedSnapshot(input.routes, input.catalog, request.route, request.model)
  if (!found.ok) return found
  const { picked, snapshot } = found.value
  if (snapshot.credentialBinding !== null && !input.credentials.bound(snapshot.credentialBinding))
    return selectionRefusal('denied', 'model_selection_credential')
  if (!offers(snapshot.features, input.needs))
    return selectionRefusal('incompatible', 'model_selection_features')
  const thinking = resolveThinkingOnSwitch({
    prior: prior?.thinking,
    sameModel: prior?.route === request.route && prior?.model === request.model,
    requested: request.thinking,
    record: picked.model,
  })
  if (!thinking.ok) return thinking
  return ok({ thinking: thinking.value, snapshot })
}

/**
 * What the commit of an invocation that prepared a model request must add to its read set: the
 * parameter record revision the frame was built from. A switch committed first makes it stale.
 */
export function sessionParameterGuard(frame: Pick<Wire.RunFrame, 'sessionParameters'>): Readonly<{
  readGuard: Wire.ReadGuard
  domainRead: Wire.DomainReference
}> {
  const reference = frame.sessionParameters.reference
  return {
    readGuard: { recordId: reference.recordId, expectedRecordRevision: reference.recordRevision },
    domainRead: reference,
  }
}
