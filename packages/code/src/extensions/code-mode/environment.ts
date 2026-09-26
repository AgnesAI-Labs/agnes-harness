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
}

/**
 * The one fact worth stating about the tool list that the wire tools field cannot state for
 * itself: that it is complete. Tool names used to be enumerated here too, which made this text
 * change every time disclosure changed and put that change ahead of persona and doctrine in
 * system; the wire already carries the names on every request, so repeating them bought nothing
 * and cost a cache-busting section. What is left is a choice between two fixed sentences.
 *
 * The parameter still takes the full list, not a boolean, to preserve this function's existing
 * exported signature — but only `names.length` is read below. A future reader should not assume
 * the actual names still matter here; they don't.
 */
export function renderTools(names: readonly string[]): string {
  return loadPrompt(names.length === 0 ? 'tools-none' : 'tools-available')
}
