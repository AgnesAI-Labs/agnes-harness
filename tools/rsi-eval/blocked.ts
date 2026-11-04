// A turn the host's own verifier ended `blocked`, read from the session's ledger. The host checks each
// turn (`verifier/signal`); when a check fails it first asks the model to repair the turn, and when that
// does not take it ends the turn with `turn/end` reason `blocked`, after an `x/core/verifier-recovery` row
// with `handling: "blocked"` that names the reasons. Such a run was stopped by the harness, not by its
// task, so the runner records it apart (`RunOutcome.blocked`) and redoes it once.
import type { Arm, Blocked, RunRecord } from './types.js'

type Row = { type: string; data: unknown }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The most times a blocked run is started again before it is left as blocked. */
export const MAX_BLOCKED_REDOS = 1

/**
 * Whether the session's last turn ended blocked, with the reasons of the recovery that blocked it. A turn
 * the verifier only asked to repair, and that went on, is not blocked.
 */
export const blockedReasons = (rows: Row[]): string[] | undefined => {
  const last = [...rows].reverse().find((row) => row.type === 'turn/end')
  if (!last || !isObject(last.data) || last.data.reason !== 'blocked') return undefined
  const recovery = [...rows]
    .reverse()
    .find(
      (row) =>
        row.type === 'x/core/verifier-recovery' && isObject(row.data) && row.data.handling === 'blocked',
    )
  const verdict =
    recovery && isObject(recovery.data) && isObject(recovery.data.verdict) ? recovery.data.verdict : {}
  const reasons = Array.isArray(verdict.reasons)
    ? verdict.reasons.filter((r): r is string => typeof r === 'string')
    : []
  return reasons.length > 0 ? reasons : ['unknown']
}

/** The blocked turn of a run, from the prompt the runner saw end `blocked` and that session's ledger. */
export const blockedRun = (
  prompts: { session: number; prompt: number; reason: string }[],
  ledger: (session: number) => Row[],
): Blocked | undefined => {
  const at = prompts.find((p) => p.reason === 'blocked')
  if (!at) return undefined
  return {
    session: at.session,
    prompt: at.prompt,
    reasons: blockedReasons(ledger(at.session)) ?? ['unknown'],
  }
}

/** The runs of a system whose turn the host's verifier blocked, per arm, with the reasons; none when there are none. */
export type BlockedExcluded = { byArm: Record<Arm, number>; reasons: Record<string, number> } | undefined
export const blockedExcluded = (records: RunRecord[]): BlockedExcluded => {
  const blocked = records.filter((r) => r.blocked && !r.infraFailed)
  if (blocked.length === 0) return undefined
  const reasons: Record<string, number> = {}
  for (const r of blocked)
    for (const reason of r.blocked?.reasons ?? []) reasons[reason] = (reasons[reason] ?? 0) + 1
  const arms: Arm[] = ['on', 'off', 'oracle', 'frozen']
  return {
    byArm: Object.fromEntries(
      arms.map((arm) => [arm, blocked.filter((r) => r.setting === arm).length]),
    ) as Record<Arm, number>,
    reasons,
  }
}

export const blockedMarkdown = (x: NonNullable<BlockedExcluded>): string[] => [
  `Runs the host's own turn verifier blocked (the harness stopped a turn, not the task), left out of every metric below: ${Object.entries(
    x.byArm,
  )
    .map(([arm, n]) => `${arm} ${n}`)
    .join(', ')}. Reasons: ${Object.entries(x.reasons)
    .map(([reason, n]) => `${reason} x${n}`)
    .join(', ')}. Each is redone once when the run is started again; one blocked again stays out.`,
  '',
]
