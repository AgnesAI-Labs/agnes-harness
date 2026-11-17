// Adapted from dsh-superagent (MIT)
/** Built-in prompt sections and role policies for orchestrator and worker sessions. */
import { bundledSkills, promptFile } from './skill-files.js'

export { textPage } from './cards.js'

/** Built-in host-delivery and tool-usage rules shared by all Sessions; a team may override them (`builtInParts`). */
export const sharedPrompt = promptFile('shared')
export const masterPrompt = promptFile('orchestrator')
export const workerPrompt = promptFile('worker')
/** Built-in policy sections referenced by role prompts; a team may override them. */
export const guides: Readonly<Record<string, string>> = Object.fromEntries(
  ['subscriptions', 'replies', 'dispatch', 'work'].map((name) => [name, promptFile(name)]),
)
/** Bundled Source skills registered by dsh-superagent; a team may override their text. */
export const sourceSkills: Readonly<Record<'feishu' | 'github', string>> = {
  feishu: bundledSkills.feishu.content,
  github: bundledSkills.github.content,
}
export const cliNotes = promptFile('cli')
/** Default text for the team-editable prompt sections (communication, ticket scope, and PR delivery). */
export const teamDefaults = {
  communication: promptFile('team/communication'),
  scope: promptFile('team/scope'),
  delivery: promptFile('team/delivery'),
}

export const mainAdmissionPolicy = promptFile('admission')

const handoff = {
  shared: promptFile('handoff'),
  orchestrator: promptFile('handoff-orchestrator'),
  worker: promptFile('handoff-worker'),
}
export const handoffPolicy = (role: 'orchestrator' | 'worker'): string =>
  `${handoff.shared}\n${handoff[role]}`

export const autoMergeThreshold = (lines: number): string =>
  `it changes fewer than ${lines} lines (additions plus deletions);`
