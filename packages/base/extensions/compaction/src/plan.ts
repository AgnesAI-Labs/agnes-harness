import type { CompactionPlan, HookPayloadMap } from '@agnes/extension-api'
import { chooseCut } from './cut.js'
import { fileDetails, type ToolCallView } from './details.js'
import { buildPrompts } from './prompts.js'

export type BeforeCompactPayload = HookPayloadMap['before_compact'] & {
  readonly toolCalls?: readonly ToolCallView[]
  readonly kernelNote?: string
}

export function buildCompactionPlan(
  payload: BeforeCompactPayload,
  config: Readonly<{ keepRecentTokens: number }>,
): CompactionPlan | null {
  const keepRecentTokens =
    payload.reason === 'overflow' ? Math.floor(config.keepRecentTokens / 2) : config.keepRecentTokens
  const cut = chooseCut(payload.getSurface(), keepRecentTokens)
  if (!cut) return null

  const hasPrevious = typeof payload.previousSummarySeq === 'number' && payload.previousSummarySeq > 0
  const basePrompts = buildPrompts({
    hasPrevious,
    hasPrefix: cut.turnPrefixRange !== undefined,
    inProgressTail: cut.inProgressTail === true,
    ...(payload.customInstructions ? { customInstructions: payload.customInstructions } : {}),
  })
  const prompts = payload.kernelNote
    ? {
        ...basePrompts,
        system: `${basePrompts.system}\n\nRuntime state to preserve in Critical context:\n${payload.kernelNote}`,
      }
    : basePrompts

  return {
    keepFromSeq: cut.keepFromSeq,
    summarizeRange: cut.summarizeRange,
    ...(cut.turnPrefixRange ? { turnPrefixRange: cut.turnPrefixRange } : {}),
    ...(hasPrevious ? { previousSummarySeq: payload.previousSummarySeq } : {}),
    prompts,
    // Matches prime-agent's own ratio (0.8 * reserveTokens) rather than a flat constant: the summary
    // request's output cap scales with how much headroom compaction is trying to free up, so a reasoning
    // model doesn't burn the whole budget on thinking before it can write the summary text itself.
    maxTokens: Math.max(1, Math.floor(0.8 * payload.reserveTokens)),
    details: fileDetails(payload.toolCalls ?? []),
    ...(payload.customInstructions ? { customInstructions: payload.customInstructions } : {}),
  }
}
