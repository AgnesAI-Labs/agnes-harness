import {
  extEventType,
  type SessionRef,
  type SlotFill,
  type SlotName,
  unavailableProjections,
} from '@agnes/extension-api'
import {
  inspectJsonData,
  UI_SLOT_MAX_BYTES,
  UI_SLOT_NAMES,
  UI_SLOT_TABLE,
  validateSlotPayload,
} from '@agnes/protocol'
import type { Timers } from '../log/session-log.js'
import type { SlotFillRunner } from '../project/ui.js'
import { CoreError, type Disposer } from '../types.js'
import { OwnedRegistryTable } from './owner-batch.js'
import { invokeSlot } from './slot-invocation.js'
import type { ToolSource } from './tools.js'

/** Internal callback contract; the author SlotFill API remains unary. */
export type RuntimeSlotFill<S extends SlotName> = (
  context: Parameters<SlotFill<S>>[0],
  signal: AbortSignal,
) => ReturnType<SlotFill<S>>

type Registration = { slot: SlotName; fill: unknown; meta: ToolSource }
const table = structuredClone(UI_SLOT_TABLE)

/** Registration ownership and immutable membership snapshots for UI projection. */
export class SlotRegistry {
  private readonly entries = new OwnedRegistryTable<Registration>()

  register<S extends SlotName>(slot: S, fill: NoInfer<RuntimeSlotFill<S>>, meta: ToolSource): Disposer {
    if (
      !UI_SLOT_NAMES.includes(slot) ||
      typeof fill !== 'function' ||
      !['builtin', 'trusted'].includes(meta.trust)
    )
      throw new CoreError('E_ENVELOPE', 'invalid slot registration')
    extEventType(meta.source, 'slot')
    const entry = { slot, fill, meta: { ...meta } }
    return this.entries.add(meta.source, slot, entry)
  }

  prepareOwnerReplacement(owner: string, candidate: SlotRegistry) {
    return this.entries.prepare(owner, candidate.entries)
  }

  registrations(source: string): string[] {
    return this.entries
      .values()
      .filter((e) => e.meta.source === source)
      .map((e) => `slot:${e.slot}`)
  }

  snapshot(
    session: SessionRef,
    options: {
      remainingMs(): number
      signal?: AbortSignal
      timers?: Timers
    },
  ): SlotFillRunner {
    const entries = this.entries.values().sort((a, b) => table[a.slot].order - table[b.slot].order)
    const identity = structuredClone(session)
    return async (surface, trigger) => {
      const selected = entries.filter(
        ({ slot }) => table[slot].surfaces.includes(surface) && table[slot].trigger.includes(trigger.kind),
      )
      const results = await Promise.all(
        selected.map(async ({ slot, fill, meta }) => {
          try {
            const ms = options.remainingMs()
            if (!Number.isFinite(ms) || ms <= 0 || options.signal?.aborted) return null
            const context = Object.freeze({
              session: Object.freeze({ ...identity }),
              projections: unavailableProjections,
              surface,
              trigger: Object.freeze({ ...trigger }),
            })
            const value = await invokeSlot(
              (signal) => {
                const remaining = options.remainingMs()
                if (!Number.isFinite(remaining) || remaining <= 0 || options.signal?.aborted) return null
                return (fill as RuntimeSlotFill<typeof slot>)(context, signal)
              },
              ms,
              options.signal,
              options.timers,
            )
            if (value === null) return null
            const data = inspectJsonData(value, UI_SLOT_MAX_BYTES)
            if (!data.ok || !validateSlotPayload(slot, data.value).ok) return null
            return { slot, extId: meta.source, payload: data.value }
          } catch {
            return null
          }
        }),
      )
      return results.filter((result) => result !== null)
    }
  }
}
