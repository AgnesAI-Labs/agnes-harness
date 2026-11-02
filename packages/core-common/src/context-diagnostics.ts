export type Conflict = { key: string; ops: string[] }
/** One section's token cost, as recorded for observability -- text itself is not kept, only its
 * estimated size, so this stays cheap enough to write unconditionally every turn. */
export type ContextSectionSummary = { id: string; order: number; source: string; tokens: number }
export type RequestComposition = {
  tokens: Record<
    | 'fixedPrefix'
    | 'conversation'
    | 'toolResultsCurrentStep'
    | 'toolResultsEarlier'
    | 'thinking'
    | 'runtimeNotes'
    | 'framing',
    number
  >
  total: number
  toolResultCount: number
  largestToolResult: { bytes: number; tool: string } | null
}
export type ContextBreakdownDiag = {
  sections: ContextSectionSummary[]
  turn?: number
  step?: number
  composition?: RequestComposition
}
