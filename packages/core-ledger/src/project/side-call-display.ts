import type { CostLedger, EventEnvelope } from '@agnes/protocol'
import { callTiming } from './call-timing.js'

type Display = { caller?: string; label?: string }
type Entry = {
  audit?: { caller?: string; label: string }
  views: Array<{ value: Display; caller?: string; owner: string }>
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
/** Keep bounded audit evidence and live references only; billing is never changed. */
export class SideCallDisplay {
  private readonly entries = new Map<string, Entry>()
  private entry(effectId: string): Entry {
    let entry = this.entries.get(effectId)
    if (!entry) {
      entry = { views: [] }
      this.entries.set(effectId, entry)
      if (this.entries.size > 2048) this.entries.delete(this.entries.keys().next().value!)
    }
    return entry
  }
  observe(event: EventEnvelope): string[] {
    const data = event.data
    if (
      event.type !== 'x/core/side-call-intent' ||
      event.origin !== 'system' ||
      event.trust !== 'trusted' ||
      !object(data) ||
      data.version !== 1 ||
      !object(data.binding) ||
      typeof data.binding.effectId !== 'string' ||
      !data.binding.effectId.length ||
      data.binding.effectId.length > 128 ||
      !object(data.audit) ||
      typeof data.audit.label !== 'string' ||
      !/^[a-z][a-z0-9._-]{0,63}$/.test(data.audit.label) ||
      (data.audit.caller !== undefined &&
        (typeof data.audit.caller !== 'string' ||
          !data.audit.caller.length ||
          data.audit.caller.length > 256))
    )
      return []
    const entry = this.entry(`${event.lane ?? 'main'}\0${data.binding.effectId}`)
    if (entry.audit) return []
    entry.audit = {
      label: data.audit.label,
      ...(typeof data.audit.caller === 'string' ? { caller: data.audit.caller } : {}),
    }
    const changed: string[] = []
    for (const view of entry.views) {
      if (view.caller !== entry.audit.caller) continue
      view.value.label = entry.audit.label
      changed.push(view.owner)
    }
    return changed
  }
  attach(row: CostLedger, value: Display, owner: string, lane = 'main'): void {
    if (row.caller !== undefined) value.caller = row.caller
    if (row.purpose !== 'side-call') return
    const entry = this.entry(`${lane}\0${row.effectId}`)
    if (entry.audit && entry.audit.caller === row.caller) value.label = entry.audit.label
    // One row belongs to one view per projection. Duplicates cannot grow retained references.
    if (entry.views.length < 2)
      entry.views.push({ value, owner, ...(row.caller ? { caller: row.caller } : {}) })
  }
}

export function createCostNode(
  event: EventEnvelope,
  cost: CostLedger,
): Extract<import('@agnes/protocol').UINode, { kind: 'cost' }> {
  return {
    kind: 'cost',
    id: event.id,
    seq: event.seq,
    source: cost.creditSource,
    purpose: cost.purpose,
    ...(!cost.adjustment ? { tokens: structuredClone(cost.tokens) } : {}),
    ...(cost.billing ? { billing: structuredClone(cost.billing) } : {}),
    model: cost.model,
    ...(cost.interrupted !== undefined ? { interrupted: cost.interrupted } : {}),
    ...(cost.timing ? { timing: callTiming(cost.timing) } : {}),
    ...(cost.credits !== undefined ? { credits: cost.credits } : {}),
  }
}
