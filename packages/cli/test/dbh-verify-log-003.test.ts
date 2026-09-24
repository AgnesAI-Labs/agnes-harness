import type { UINode, UITimeline } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { renderHtml } from '../src/html/template.js'
import { formatCallUsage } from '../src/tui/usage-details.js'

// DBH LOG-003 verification. Differential oracle: packages/cli-tui/src/usage-details.ts:5-8
// (`formatCallUsage`) is an independent renderer of the same `cost` node that prefers
// `node.billing` and only falls back to `credits`. packages/protocol/gen/ts/agnes-v1.ts:64 makes
// both `credits` and `billing` optional on the cost variant, and packages/core/src/project/ui.ts
// fills them from two independent conditionals, so a billing-only cost node is legal.
const costNode: Extract<UINode, { kind: 'cost' }> = {
  kind: 'cost',
  id: 'c1',
  seq: 5,
  source: 'gateway',
  billing: { usdMicros: 1234, source: 'gateway', subscription: false },
}

const timeline: UITimeline = {
  sessionId: 's1',
  upto: 8,
  generation: 1,
  opState: null,
  nodes: [costNode],
  turns: [],
}

describe('DBH LOG-003: HTML export of a billing-only cost node', () => {
  it('[control] the TUI renderer reports the billed amount for this node', () => {
    const tui = formatCallUsage(costNode)
    expect(tui).toContain('$0.001234')
    expect(tui).not.toContain('unknown')
  })

  it('does not report the cost as unknown in the exported document', () => {
    const html = renderHtml(timeline, {
      sessionId: 's1',
      exportedAt: '2026-01-01T00:00:00.000Z',
      redacted: false,
    })
    expect(html).not.toContain('credits unknown')
    expect(html).toContain('$0.001234')
  })
})
