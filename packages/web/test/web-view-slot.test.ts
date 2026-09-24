// WC9：webView() 不再丢弃 slot 节点；时间线 slot 分支在底座未绑定时渲染静态占位。

import type { UINode, UITimeline } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { webView } from '../src/view.js'

function timelineWithSlot(): UITimeline {
  const slotNode: UINode = {
    id: 'n1',
    kind: 'slot',
    fill: { slot: 'tool.card.inline', extId: 'ext-1', payload: { hello: true } },
  } as unknown as UINode
  return { nodes: [slotNode] } as unknown as UITimeline
}

describe('webView 保留 slot 节点（WC9）', () => {
  it('slot 节点不再被过滤，fill 数据原样到达视图层', () => {
    const view = webView(timelineWithSlot())
    const slot = view.nodes.find((node) => node.kind === 'slot') as
      | { kind: 'slot'; fill: { slot: string; extId: string; payload: unknown } }
      | undefined
    expect(slot).toBeDefined()
    expect(slot?.fill.extId).toBe('ext-1')
    expect(slot?.fill.payload).toEqual({ hello: true })
  })
})
