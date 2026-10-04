import type { ToolSemantics } from '@agnes/jev-runtime'

export interface ToolCompanion {
  readonly operation: string
  readonly revision: string
  readonly semantics: ToolSemantics
}

/** Trusted, revision-bound companions enrich facts; tool execution remains a host responsibility. */
export function createToolSemantics(companions: readonly ToolCompanion[]): ToolSemantics {
  const registered = new Map<string, ToolCompanion>()
  for (const companion of companions) {
    if (registered.has(companion.operation))
      throw new Error(`Duplicate tool companion: ${companion.operation}`)
    registered.set(companion.operation, { ...companion })
  }
  const lookup = (tool: { name: string; revision: string }): ToolSemantics | undefined => {
    const companion = registered.get(tool.name)
    return companion?.revision === tool.revision ? companion.semantics : undefined
  }
  return {
    *candidates(tool, observations, epoch, context) {
      if (context === undefined) return
      const companion = lookup(tool)
      if (companion === undefined) return
      let count = 0
      for (const candidate of companion.candidates(tool, observations, epoch, context)) {
        if (count++ >= context.limit) break
        if (
          candidate.tool !== tool.name ||
          candidate.toolRevision !== tool.revision ||
          candidate.environmentEpoch !== epoch
        )
          throw new Error('Tool companion returned a candidate for a different operation, revision or epoch')
        yield candidate
      }
    },
    observations(tool, result, intent) {
      return lookup(tool)?.observations(tool, result, intent) ?? []
    },
    effectDisposition(tool, result) {
      return lookup(tool)?.effectDisposition(tool, result)
    },
  }
}
