export const jevPayloadDirectory: string
/** Write `index.mjs` into the payload directory; host-provided modules stay external. */
export function buildJevPayload(directory?: string): Promise<void>
