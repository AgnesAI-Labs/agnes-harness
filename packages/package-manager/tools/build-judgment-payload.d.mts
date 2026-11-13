export const judgmentPayloadDirectory: string
/** Write `index.mjs` into the payload directory; host-provided modules stay external. */
export function buildJudgmentPayload(directory?: string): Promise<void>
