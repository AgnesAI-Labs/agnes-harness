export const superagentPayloadDirectory: string
export const superagentSourceDirectory: string
/** The panel's source folder, which holds the stylesheets the client descriptor lists. */
export const superagentPanelDirectory: string
export const SUPERAGENT_RESOURCE_FOLDERS: readonly string[]
/** Write the entry and the prompts, skills and locale folders into the requested directory. */
export function buildSuperagentPayload(directory?: string): Promise<void>
/** The browser panel build: its client bundle, NOTICE, build record and stylesheets, next to the committed client descriptor. */
export function buildSuperagentPresentation(directory?: string): Promise<void>
