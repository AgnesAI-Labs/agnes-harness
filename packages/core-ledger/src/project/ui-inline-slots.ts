import {
  UI_SLOT_MAX_BYTES,
  UI_SLOT_TABLE,
  type UINode,
  validateAgainst,
  validateSlotPayload,
} from '@agnes/protocol'
import { SlotFillView } from '@agnes/protocol/gen/agnes-v1'
import { boundedTimelinePage, type UIOptions } from './ui.js'

/** Registry inline cards never add nodes or shift journal/history indices. */
export async function fillInlineNodes(
  nodes: UINode[],
  opts: Pick<UIOptions, 'surface' | 'inlineFills'>,
): Promise<void> {
  if (
    !opts.surface ||
    !opts.inlineFills ||
    !UI_SLOT_TABLE['tool.card.inline'].surfaces.includes(opts.surface)
  )
    return
  for (const node of nodes) {
    if (node.kind !== 'tool' || (node.resultSeq === undefined && node.status !== 'running')) continue
    try {
      const fills = await opts.inlineFills(opts.surface, {
        kind: node.resultSeq === undefined ? 'tool_call' : 'tool_result',
        toolUseId: node.toolUseId,
      })
      if (!Array.isArray(fills)) continue
      for (const fill of fills) {
        if (
          fill.slot !== 'tool.card.inline' ||
          !validateAgainst(SlotFillView, fill).ok ||
          !validateSlotPayload(fill.slot, fill.payload).ok ||
          new TextEncoder().encode(JSON.stringify(fill.payload)).byteLength > UI_SLOT_MAX_BYTES
        )
          continue
        node.slots ??= []
        node.slots.push(structuredClone(fill))
      }
    } catch {
      // A failed extension card does not hide the underlying tool result.
    }
  }
}

/** Recheck the page byte budget after filling only its bounded candidate nodes. */
export async function fillInlinePage<
  T extends {
    nodes: UINode[]
    startIndex: number
    totalNodes: number
    hasEarlier: boolean
  },
>(
  page: T,
  opts: Pick<UIOptions, 'surface' | 'inlineFills'>,
  maxNodes: number,
  maxBytes: number,
  extraBytes?: (node: UINode) => number,
): Promise<T> {
  if (!opts.surface || !opts.inlineFills) return page
  await fillInlineNodes(page.nodes, opts)
  const bounded = boundedTimelinePage(page.nodes, page.nodes.length, maxNodes, maxBytes, extraBytes)
  const startIndex = page.startIndex + bounded.startIndex
  return { ...page, nodes: bounded.nodes, startIndex, hasEarlier: startIndex > 0 }
}
