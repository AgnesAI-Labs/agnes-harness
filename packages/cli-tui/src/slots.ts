import type { SlotFillView, UINode, UITimeline } from '@agnes/protocol'

export type StatusItem = { text: string; level: 'info' | 'warn' | 'error' }
export type ActionItem = { id: string; label: string; disabled?: boolean }

// Only a `tool` node carries a `slots` array; every other slot fill that is not attached to a
// tool result arrives as its own standalone `slot`-kind node with a single `fill`. Reading both
// shapes into one flat list of fills is what lets the rest of this module stay agnostic to where
// a fill physically lives.
function fillsOf(node: UINode): SlotFillView[] {
  if (node.kind === 'tool') return node.slots ?? []
  if (node.kind === 'slot') return [node.fill]
  return []
}

/**
 * Collects the two globally-placed slots across a projected timeline: `status.line` for the
 * status bar and `sidebar.action` for the hint row. `tool.card.inline` renders inside its own
 * tool card (see tool-card.ts) and `notification` has no TUI surface, so neither is collected
 * here.
 */
export function collectSlots(t: UITimeline): { status: StatusItem[]; actions: ActionItem[] } {
  const status: StatusItem[] = []
  const actions: ActionItem[] = []
  for (const node of t.nodes) {
    for (const fill of fillsOf(node)) {
      if (fill.slot === 'status.line') {
        const p = fill.payload as StatusItem
        status.push({ text: p.text, level: p.level })
      } else if (fill.slot === 'sidebar.action') {
        const p = fill.payload as { id: string; label: string; disabled?: boolean }
        actions.push({ id: p.id, label: p.label, ...(p.disabled ? { disabled: true } : {}) })
      }
    }
  }
  return { status, actions }
}
