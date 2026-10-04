import { normalizeWorkspacePath } from '../paths.js'

export const HOST_TOOL_FACT_CODEC = 'agnes-host-tool-fact-v1' as const

export type HostPathFact = {
  path: string
  workspaceRelativePath?: string
}

/** Lexical path identity for an already-authorized successful tool result. */
export function hostPathFact(path: string, cwd: string): HostPathFact {
  const normalized = normalizeWorkspacePath(path, cwd)
  return {
    path: normalized.abs,
    ...(normalized.inside ? { workspaceRelativePath: normalized.rel } : {}),
  }
}
