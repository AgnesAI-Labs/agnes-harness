import type { Counters, JsonObject, JsonValue } from './types.js'

/** Per-turn cap on the per-step events; the platform allows 200 extension events a turn. */
export const STEP_EVENT_BUDGET = 150

type EventSink = { emit(name: string, data: JsonValue): Promise<void> }

/**
 * Best-effort emit. `jev.decide` and `jev.step` stop at the per-turn budget; `jev.metrics` is always
 * tried and does not use the budget. A refused or failed emit is counted and never thrown.
 */
export async function emitEvent(
  events: EventSink,
  counters: Counters,
  name: 'jev.decide' | 'jev.step' | 'jev.metrics',
  data: JsonObject,
): Promise<void> {
  const metered = name !== 'jev.metrics'
  if (metered && counters.emitted >= STEP_EVENT_BUDGET) {
    counters.droppedEvents++
    return
  }
  try {
    await events.emit(name, data)
    if (metered) counters.emitted++
  } catch {
    counters.droppedEvents++
  }
}
