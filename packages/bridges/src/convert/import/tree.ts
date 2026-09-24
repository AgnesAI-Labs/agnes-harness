import type { Tolerance } from '../tolerance.js'

type TreeNode<T> = { id: string; parentId: string | null; ts: number; node: T }

export function pathToLatestLeaf<T>(
  input: Array<TreeNode<T>>,
  report: Tolerance,
): { path: T[]; repairedIds: string[] } {
  const nodes: Array<TreeNode<T>> = []
  const byId = new Map<string, TreeNode<T>>()
  const parentOf = new Map<string, string | null>()
  const repairedIds: string[] = []

  for (const [index, node] of input.entries()) {
    if (byId.has(node.id)) {
      repairedIds.push(node.id)
      report.repair(index + 1, `duplicate id ${node.id} dropped`)
      continue
    }
    const previous = nodes.at(-1)?.id ?? null
    const parent = node.parentId === null || byId.has(node.parentId) ? node.parentId : previous
    if (parent !== node.parentId) {
      repairedIds.push(node.id)
      report.repair(index + 1, `orphan parent ${String(node.parentId)} -> attached to ${parent ?? 'root'}`)
    }
    nodes.push(node)
    byId.set(node.id, node)
    parentOf.set(node.id, parent)
  }

  const parents = new Set([...parentOf.values()].filter((id): id is string => id !== null))
  const leaves = nodes.filter((node) => !parents.has(node.id))
  let leaf: TreeNode<T> | undefined
  for (const candidate of leaves) if (!leaf || candidate.ts >= leaf.ts) leaf = candidate

  const keep = new Set<string>()
  const ordered: T[] = []
  let current = leaf?.id ?? null
  while (current !== null && !keep.has(current)) {
    keep.add(current)
    const found = byId.get(current)
    if (found) ordered.push(found.node)
    current = parentOf.get(current) ?? null
  }
  ordered.reverse()

  const branchRoots = new Set<string>()
  for (const node of nodes) {
    if (keep.has(node.id)) continue
    const parent = parentOf.get(node.id)
    if (parent === null || parent === undefined || keep.has(parent)) branchRoots.add(node.id)
  }
  for (const _root of branchRoots) report.dropBranch()
  return { path: ordered, repairedIds }
}
