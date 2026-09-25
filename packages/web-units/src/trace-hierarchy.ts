import type { UINode } from '@agnes/protocol'

type ToolNode = Extract<UINode, { kind: 'tool' }>

/** Explicit tool relationships in the loaded UI projection. */
export type TraceToolHierarchy = {
  /** A child has at most one parent. The first valid claim in node order wins. */
  parentById: ReadonlyMap<string, string>
  childrenById: ReadonlyMap<string, readonly string[]>
  /** Recorded depth is retained when a parent is outside the loaded history. */
  depthById: ReadonlyMap<string, number>
}

/**
 * Build the visible tool tree from recorded child IDs. Neither sequence adjacency nor depth alone
 * identifies a parent: history pages can omit nodes, and other events may sit between tool calls.
 */
export function buildTraceToolHierarchy(nodes: readonly UINode[]): TraceToolHierarchy {
  const firstNodeById = new Map<string, UINode>()
  for (const node of nodes) if (!firstNodeById.has(node.id)) firstNodeById.set(node.id, node)

  const tools = [...firstNodeById.values()].filter((node): node is ToolNode => node.kind === 'tool')
  const toolById = new Map(tools.map((node) => [node.id, node]))
  const parentById = new Map<string, string>()
  const childrenById = new Map<string, string[]>()

  for (const parent of tools) {
    for (const childId of parent.children ?? []) {
      if (childId === parent.id || !toolById.has(childId) || parentById.has(childId)) continue

      // Each accepted edge points to an existing tool. Refuse any edge that closes a cycle.
      let closesCycle = false
      for (
        let ancestor: string | undefined = parent.id;
        ancestor !== undefined;
        ancestor = parentById.get(ancestor)
      ) {
        if (ancestor === childId) {
          closesCycle = true
          break
        }
      }
      if (closesCycle) continue

      parentById.set(childId, parent.id)
      const children = childrenById.get(parent.id) ?? []
      children.push(childId)
      childrenById.set(parent.id, children)
    }
  }

  const depthById = new Map<string, number>()
  for (const tool of tools) {
    if (tool.depth !== undefined && Number.isSafeInteger(tool.depth) && tool.depth >= 0) {
      depthById.set(tool.id, tool.depth)
    } else {
      depthById.set(tool.id, traceToolAncestors({ parentById, childrenById, depthById }, tool.id).length)
    }
  }

  return { parentById, childrenById, depthById }
}

/** Nearest parent first; an unknown or root node has no ancestors. */
export function traceToolAncestors(hierarchy: TraceToolHierarchy, id: string): string[] {
  const ancestors: string[] = []
  const seen = new Set([id])
  for (
    let parent = hierarchy.parentById.get(id);
    parent !== undefined && !seen.has(parent);
    parent = hierarchy.parentById.get(parent)
  ) {
    ancestors.push(parent)
    seen.add(parent)
  }
  return ancestors
}

/** A collapsed tool keeps its own row visible and hides only its descendants. */
export function isTraceRowHiddenByTool(
  hierarchy: TraceToolHierarchy,
  id: string,
  collapsedToolIds: ReadonlySet<string>,
): boolean {
  return traceToolAncestors(hierarchy, id).some((parentId) => collapsedToolIds.has(parentId))
}
