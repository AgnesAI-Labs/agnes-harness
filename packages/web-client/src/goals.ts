import type { UITimeline } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import { StatusLinePayload } from '@agnes/protocol/gen/slots'

/** Public read contract over the existing durable goal status projection. No execution authority. */
export type GoalView = Readonly<StatusLinePayload>
export type GoalCommand =
  | { action: 'pause' | 'resume' | 'complete' | 'clear' }
  | { action: 'create' | 'edit'; objective: string; maxRounds: number; budgetCredits?: number }

/** Live slots are authoritative, including clear; nodes recover historical sessions. */
export function readGoal(timeline?: UITimeline): GoalView | undefined {
  const live = timeline?.slots?.find((fill) => fill.extId === 'agnes/goal' && fill.slot === 'status.line')
  const fill =
    live ??
    [...(timeline?.nodes ?? [])]
      .reverse()
      .flatMap((node) =>
        node.kind === 'slot' && node.fill.extId === 'agnes/goal' && node.fill.slot === 'status.line'
          ? [node.fill]
          : [],
      )[0]
  if (!fill) return undefined
  const parsed = validateAgainst<StatusLinePayload>(StatusLinePayload, fill.payload)
  return parsed.ok ? parsed.value : undefined
}

/** Human command request only. The ordinary inbox path validates budget and authorization. */
export function goalCommand(input: GoalCommand): string {
  if (!('objective' in input)) return `/goal ${input.action}`
  const objective = input.objective.trim()
  if (
    !objective ||
    objective.length > 8192 ||
    !Number.isInteger(input.maxRounds) ||
    input.maxRounds < 1 ||
    input.maxRounds > 100
  )
    throw new TypeError('Invalid goal')
  if (
    input.budgetCredits !== undefined &&
    (!Number.isFinite(input.budgetCredits) || input.budgetCredits <= 0)
  )
    throw new TypeError('Invalid goal budget')
  return `/goal ${input.action} --max-rounds ${input.maxRounds} --budget ${input.budgetCredits ?? 'none'} ${objective}`
}
