import { UI_SLOT_MAX_BYTES, validateAgainst, validateSlotPayload } from '@agnes/protocol'
import { SlotFillView } from '@agnes/protocol/gen/agnes-v1'
import type { SlotFill, UIOptions } from './ui.js'

/** Live status is separate from transcript nodes and therefore never changes paging indices. */
export async function fillLiveSlots(
  opts: Pick<UIOptions, 'surface' | 'liveFills'>,
  maxBytes = UI_SLOT_MAX_BYTES,
): Promise<SlotFill[] | undefined> {
  if (!opts.surface || !opts.liveFills) return undefined
  try {
    const fills = await opts.liveFills(opts.surface, { kind: 'tick' })
    const result: SlotFill[] = []
    let bytes = 2
    for (const fill of fills) {
      if (
        !['status.line', 'sidebar.action'].includes(fill.slot) ||
        !validateAgainst(SlotFillView, fill).ok ||
        !validateSlotPayload(fill.slot, fill.payload).ok
      )
        continue
      const size = new TextEncoder().encode(JSON.stringify(fill)).byteLength + 1
      if (bytes + size > maxBytes || result.length >= 32) continue
      result.push(structuredClone(fill))
      bytes += size
    }
    return result.length || opts.surface === 'web' ? result : undefined
  } catch {
    return opts.surface === 'web' ? [] : undefined
  }
}
