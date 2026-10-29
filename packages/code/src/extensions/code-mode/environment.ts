import { applyVars, loadPrompt } from '../../prompts/sections.js'

/**
 * Only installation and platform facts belong in the environment section. Session identity, date,
 * model, preset, disclosure, cwd and sandbox level can differ across requests or sessions, so they
 * are rendered into the tail runtime-context message instead of the shared system prefix.
 */
export type EnvironmentFacts = {
  agnesVersion: string
  platform: string
  shell: string
}

export function renderEnvironment(facts: EnvironmentFacts): string {
  return applyVars(loadPrompt('environment'), facts)
}

/**
 * The volatile counterpart to EnvironmentFacts: everything about this specific request that can
 * differ from the previous one in the same session. runtimeSnapshotFacts() (prompts.ts) reads these
 * off OpContext on every contribute() call, and createPromptOperation's contribute() hands them to
 * core as runtimeContext.environment rather than folding them into a prompt section — core's own
 * tail-message mechanism (deriveRequest, packages/core/src/request/derive.ts) renders them as a
 * user-role message appended after the newest surface message, only when the merged runtimeContext
 * hash differs from the one the previous request in this turn carried.
 */
export type RuntimeSnapshotFacts = {
  date: string
  sessionKey: string
  model: string
  route: string
  slot: string
  preset: string
  disclosure: string
  enforcement: string
  cwd: string
  /** Sorted canonical extra directories the session may use; absent when it has none. */
  extraDirectories?: string[]
}

/** Tool-use instructions are ordinary prompt text; the wire tools field supplies the names. */
export function renderTools(names: readonly string[]): string {
  return loadPrompt(names.length === 0 ? 'tools-none' : 'tools-available')
}
