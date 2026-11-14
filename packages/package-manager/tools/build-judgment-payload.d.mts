export const judgmentPayloadDirectory: string
/** Write `index.mjs` into the payload directory; host-provided modules stay external. */
export function buildJudgmentPayload(directory?: string): Promise<void>

/** Independently validates the same-package browser presentation, even for a fresh backend. */
export function buildJudgmentPresentation(directory?: string): Promise<void>
