export const judgmentPayloadDirectory: string
/** Write the complete payload into the requested directory, preserving arbitrary basenames. */
export function buildJudgmentPayload(directory?: string): Promise<void>

/** Independently validates the same-package browser presentation, even for a fresh backend. */
export function buildJudgmentPresentation(directory?: string): Promise<void>
