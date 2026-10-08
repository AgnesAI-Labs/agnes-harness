export type Conflict = { key: string; ops: string[] }
/** One section's token cost, as recorded for observability -- text itself is not kept, only its
 * estimated size, so this stays cheap enough to write unconditionally every turn. */
export type ContextSectionSummary = { id: string; order: number; source: string; tokens: number }
export type ContextBreakdownDiag = { sections: ContextSectionSummary[] }
