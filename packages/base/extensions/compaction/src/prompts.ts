import type { CompactionPlan } from '@agnes/extension-api'

export const SUMMARY_SYSTEM = [
  'You are compacting the working memory of an Agnes Harness agent. Produce only a structured summary that lets another agent continue the work.',
  'Use exactly these sections, in order: Goal; Constraints; Progress (Done / In progress / Blocked); Key decisions; Next steps; Critical context.',
  'Preserve identifiers, file paths, commands, error messages, and quoted strings exactly. Never invent facts, results, or file contents. Be concise and omit chit-chat.',
].join('\n')

// Core has already sent the selected ledger range as preceding conversation messages. These
// trailing instructions must not contain interpolation tokens: none are substituted on this path.
export const INITIAL_TEMPLATE = 'Summarize the preceding conversation segment.'

export const UPDATE_TEMPLATE = [
  'Update the existing summary with the new conversation segment.',
  'PRESERVE entries that remain true, ADD new facts and progress, and UPDATE entries whose state changed. Do not remove an old entry while evidence for it still applies.',
  'The previous summary and new segment are in the preceding conversation messages.',
].join('\n')

export const PREFIX_TEMPLATE = [
  'Summarize only the completed prefix of this in-progress turn. Do not predict its outcome. (turn continues below)',
  'Record the request that opened the turn, verbatim when it is short.',
  'The completed prefix is in the preceding conversation messages.',
].join('\n')

/** Appended to the history instruction when that one range ends inside the turn still running. */
export const IN_PROGRESS_NOTE = [
  'This segment ends inside a turn that is still in progress. Under Goal, record the request that opened it, verbatim when it is short.',
  'Write down only what has already happened and do not predict the outcome. (turn continues below)',
].join('\n')

export function buildPrompts(options: {
  hasPrevious: boolean
  hasPrefix: boolean
  inProgressTail?: boolean
  customInstructions?: string
}): CompactionPlan['prompts'] {
  const system = options.customInstructions
    ? `${SUMMARY_SYSTEM}\n\nAdditional instructions (highest priority):\n${options.customInstructions}`
    : SUMMARY_SYSTEM
  const template = options.hasPrevious ? UPDATE_TEMPLATE : INITIAL_TEMPLATE
  const history = options.inProgressTail ? `${template}\n${IN_PROGRESS_NOTE}` : template
  return options.hasPrefix ? { system, history, prefix: PREFIX_TEMPLATE } : { system, history }
}
