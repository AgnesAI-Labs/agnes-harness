export const superagentPayloadDirectory: string
export const superagentSourceDirectory: string
export const SUPERAGENT_RESOURCE_FOLDERS: readonly string[]
/** Write the entry and the prompts, skills and locale folders into the requested directory. */
export function buildSuperagentPayload(directory?: string): Promise<void>
/** The browser panel build: its client bundle, NOTICE and build record, next to the committed client descriptor. */
export function buildSuperagentPresentation(directory?: string): Promise<void>
