export type DependencyEdge = Readonly<{ from: string; to: string }>

export function missingDependencies(
  nodes: readonly string[],
  edges: readonly DependencyEdge[],
): readonly string[] {
  const known = new Set(nodes)
  const missing = new Set<string>()
  for (const edge of edges) {
    if (!known.has(edge.to)) missing.add(edge.to)
  }
  return Object.freeze([...missing].sort())
}

/** Returns one cycle as node ids, or undefined if the graph is acyclic. */
export function detectDependencyCycle(
  nodes: readonly string[],
  edges: readonly DependencyEdge[],
): readonly string[] | undefined {
  const outgoing = new Map<string, string[]>()
  for (const node of nodes) outgoing.set(node, [])
  for (const edge of edges) {
    const list = outgoing.get(edge.from)
    if (list) list.push(edge.to)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []
  const visit = (node: string): readonly string[] | undefined => {
    if (visited.has(node)) return undefined
    if (visiting.has(node)) {
      const start = stack.indexOf(node)
      return Object.freeze(stack.slice(start >= 0 ? start : 0).concat(node))
    }
    visiting.add(node)
    stack.push(node)
    for (const next of outgoing.get(node) ?? []) {
      const cycle = visit(next)
      if (cycle) return cycle
    }
    stack.pop()
    visiting.delete(node)
    visited.add(node)
    return undefined
  }
  for (const node of nodes) {
    const cycle = visit(node)
    if (cycle) return cycle
  }
  return undefined
}

export function persistSecretRef(value: string): string {
  if (!value.startsWith('secret://') || value.length <= 'secret://'.length) {
    throw new Error('E_SECRET_REF: only secret:// references may be persisted')
  }
  return value
}
