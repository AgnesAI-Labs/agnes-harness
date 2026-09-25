import type { UINode } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  buildTraceToolHierarchy,
  isTraceRowHiddenByTool,
  traceToolAncestors,
} from '../src/trace-hierarchy.js'

function tool(id: string, seq: number, children?: string[], depth?: number): UINode {
  return {
    kind: 'tool',
    id,
    seq,
    toolUseId: `use-${id}`,
    name: 'test_tool',
    status: 'completed',
    summary: id,
    ...(children ? { children } : {}),
    ...(depth === undefined ? {} : { depth }),
  }
}

describe('trace tool hierarchy', () => {
  it('follows explicit child IDs across non-contiguous sequences and retains recorded depth', () => {
    const nodes: UINode[] = [
      tool('root', 2, ['child'], 3),
      { kind: 'assistant', id: 'between', seq: 30, text: 'unrelated' },
      tool('child', 91, ['grandchild'], 4),
      tool('grandchild', 150),
    ]
    const hierarchy = buildTraceToolHierarchy(nodes)

    expect(hierarchy.childrenById.get('root')).toEqual(['child'])
    expect(traceToolAncestors(hierarchy, 'grandchild')).toEqual(['child', 'root'])
    expect(traceToolAncestors(hierarchy, 'between')).toEqual([])
    expect(hierarchy.depthById.get('root')).toBe(3)
    expect(hierarchy.depthById.get('child')).toBe(4)
    expect(hierarchy.depthById.get('grandchild')).toBe(2)
    expect(isTraceRowHiddenByTool(hierarchy, 'grandchild', new Set(['root']))).toBe(true)
    expect(isTraceRowHiddenByTool(hierarchy, 'root', new Set(['root']))).toBe(false)
  })

  it('ignores missing and non-tool children and accepts only the first valid parent claim', () => {
    const hierarchy = buildTraceToolHierarchy([
      tool('first', 1, ['child', 'child', 'missing', 'user']),
      tool('second', 2, ['child']),
      { kind: 'user', id: 'user', seq: 3, content: [{ type: 'text', text: 'hello' }] },
      tool('child', 4),
    ])

    expect(hierarchy.childrenById.get('first')).toEqual(['child'])
    expect(hierarchy.childrenById.has('second')).toBe(false)
    expect(hierarchy.parentById.get('child')).toBe('first')
    expect(hierarchy.parentById.has('missing')).toBe(false)
    expect(hierarchy.parentById.has('user')).toBe(false)
    expect(isTraceRowHiddenByTool(hierarchy, 'child', new Set(['second']))).toBe(false)
  })

  it('rejects self-links and cycles without hiding unrelated rows', () => {
    const hierarchy = buildTraceToolHierarchy([
      tool('a', 1, ['a', 'b']),
      tool('b', 2, ['a', 'c']),
      tool('c', 3, ['a']),
      tool('free', 4),
    ])

    expect([...hierarchy.parentById]).toEqual([
      ['b', 'a'],
      ['c', 'b'],
    ])
    expect(traceToolAncestors(hierarchy, 'a')).toEqual([])
    expect(traceToolAncestors(hierarchy, 'c')).toEqual(['b', 'a'])
    expect(isTraceRowHiddenByTool(hierarchy, 'c', new Set(['a']))).toBe(true)
    expect(isTraceRowHiddenByTool(hierarchy, 'free', new Set(['a']))).toBe(false)
  })

  it('uses the first node for a duplicate ID so ambiguous IDs cannot form a second tool', () => {
    const hierarchy = buildTraceToolHierarchy([
      { kind: 'assistant', id: 'duplicate', seq: 1, text: 'first' },
      tool('duplicate', 2, ['child']),
      tool('parent', 3, ['duplicate']),
      tool('child', 4),
    ])

    expect(hierarchy.parentById.size).toBe(0)
    expect(hierarchy.childrenById.size).toBe(0)
    expect(hierarchy.depthById.has('duplicate')).toBe(false)
  })
})
