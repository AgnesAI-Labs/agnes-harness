import type {
  DecisionModelRecord,
  DecisionSlot,
  ModelRecord,
  RouteSlotName,
  RouteTable,
  SlotName,
} from '@agnes/protocol'
import type { DecisionRegistry } from './decision-registry.js'
import type { Registry } from './registry.js'

/**
 * A slot that cannot be turned into a model. It is thrown rather than returned because the pure
 * rule below has no event stream to write into; the provider facade catches it and encodes it as an
 * in-stream `error`, which is the only shape a caller ever sees.
 */
export class SlotUnresolved extends Error {
  /** What failed, without the code in front: the facade puts this in the event it emits. */
  readonly detail: string
  constructor(
    readonly code: 'NO_MODEL' | 'NO_ADAPTER',
    readonly slot: RouteSlotName,
    readonly route?: string,
    readonly model?: string,
    /** Why, when the plain "not found" reading would be misleading. */
    readonly note?: string,
  ) {
    const detail = `slot=${slot}${route ? ` route=${route}` : ''}${model ? ` model=${model}` : ''}${
      note ? ` (${note})` : ''
    }`
    super(`${code}: ${detail}`)
    this.name = 'SlotUnresolved'
    this.detail = detail
  }
}

export type Resolved = {
  route: string
  model: ModelRecord
  fallbacks: Array<{ route: string; model: ModelRecord }>
}

/** Resolves an already selected route/model against the registry snapshot, without defaults. */
export function resolveSelection(
  registry: Registry,
  slot: SlotName,
  route: string,
  modelId: string,
): { route: string; model: ModelRecord } {
  if (!registry.lookup(route)) throw new SlotUnresolved('NO_ADAPTER', slot, route)
  // Read through the registry's projection rather than the adapter's live catalogue. After the seal
  // that projection is the snapshot the fingerprint was computed from, so the model that serves a
  // turn is always one the identity a host recorded actually covers.
  const model = registry.models().find((m) => m.route === route && m.id === modelId)
  if (!model) {
    // A record is matched on its own `route` field, not on the route key its adapter registered it
    // under, so a record whose field disagrees is present in the catalogue and unreachable through
    // it. Nothing derives that field, so getting it wrong is easy; reporting the model as simply
    // absent would send the reader looking for a catalogue entry that is sitting right there.
    const misfiled = registry.models().some((m) => m.id === modelId && m.route !== route)
    throw new SlotUnresolved(
      'NO_MODEL',
      slot,
      route,
      modelId,
      misfiled ? 'present in the catalogue under a different record.route' : undefined,
    )
  }
  return { route, model }
}

/**
 * Turns a slot into the model that will serve it. Pure: it reads the table and the registry and
 * touches no network, so the same table and registry always resolve the same way — and choosing a
 * fallback after a failure is a business decision for the caller, not something decided here.
 *
 * Fallbacks are resolved eagerly along with the head, so a table naming a model that does not exist
 * is a configuration mistake found on the first request rather than on the first failure.
 */
export type ResolvedDecision = { route: string; model: DecisionModelRecord }

export function resolveSlot(table: RouteTable, registry: Registry, slot: SlotName): Resolved
export function resolveSlot(
  table: RouteTable,
  registry: Registry,
  slot: DecisionSlot,
  decisions: DecisionRegistry | undefined,
): ResolvedDecision
export function resolveSlot(
  table: RouteTable,
  registry: Registry,
  slot: RouteSlotName,
  decisions?: DecisionRegistry,
): Resolved | ResolvedDecision {
  if (slot === 'decision') return resolveDecisionSlot(table, registry, decisions)
  const target = table[slot]
  if (!target) throw new SlotUnresolved('NO_MODEL', slot)
  const head = resolveSelection(registry, slot, target.route, target.model)
  const fallbacks = (target.fallbacks ?? []).map((f) => resolveSelection(registry, slot, f.route, f.model))
  return { ...head, fallbacks }
}

/**
 * The decision key resolves against the decision registry and nothing else. A route the chat
 * registry serves is named as a kind mismatch rather than a plain miss, because the fix is a
 * different route, not a missing catalogue entry. Fallbacks are not used for decisions: a
 * decision is one bounded query, and the caller already falls back on any failure.
 */
function resolveDecisionSlot(
  table: RouteTable,
  registry: Registry,
  decisions: DecisionRegistry | undefined,
): ResolvedDecision {
  const target = table.decision
  if (!target) throw new SlotUnresolved('NO_MODEL', 'decision')
  return resolveDecisionSelection(registry, decisions, target.route, target.model)
}

/**
 * An already selected decision route/model - what a decision request carries, filled by the
 * caller from the session's current preset - against the decision registry, without defaults.
 * The decision counterpart of resolveSelection, and what provider.decide resolves with.
 */
export function resolveDecisionSelection(
  registry: Registry,
  decisions: DecisionRegistry | undefined,
  route: string,
  modelId: string,
): ResolvedDecision {
  if (!decisions?.lookup(route)) {
    const chat = registry.lookup(route) !== undefined
    throw new SlotUnresolved(
      'NO_ADAPTER',
      'decision',
      route,
      undefined,
      chat ? 'slot-kind: the route is served by a chat adapter' : undefined,
    )
  }
  const model = decisions.models().find((m) => m.route === route && m.id === modelId)
  if (!model) throw new SlotUnresolved('NO_MODEL', 'decision', route, modelId)
  return { route, model }
}
