export const superagentPayloadDirectory: string
export const superagentSourceDirectory: string
export const SUPERAGENT_RESOURCE_FOLDERS: readonly string[]
/** Write the entry and the prompts, skills and locale folders into the requested directory. */
export function buildSuperagentPayload(directory?: string): Promise<void>
/** The browser panel build; a marked no-op until its source package exists. */
export function buildSuperagentPresentation(directory?: string): Promise<void>
