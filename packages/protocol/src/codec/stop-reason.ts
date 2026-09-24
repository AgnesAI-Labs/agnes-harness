import type { StopReason } from '../../gen/ts/acp.js'
import type { TurnEnd } from '../../gen/ts/session-v1.js'

// These two value tables used to be union types hand-copied out of the schema, with nothing binding
// the two sides together. Appending a ninth value to the schema's TurnEnd.reason.enum and re-running
// `pnpm gen` left the whole protocol suite green — 383 passed, **not one red**. That value would then
// pass event validation but throw "has no ACP stopReason" at runtime inside toAcpStopReason(): a
// build-time failure turned into a production crash. METHOD_DEF had already been given exactly this
// medicine (an identity assertion against src/methods.ts); the codec tables were missed at the time.
//
// The fix: take the types straight from the generated module, which makes the schema the single
// source of truth. Adding a reason to the schema adds a member to the TurnEndReason union, which
// leaves STOP_REASON_TABLE's Record<Exclude<...>> missing a key, which makes `pnpm -r typecheck` fail
// immediately — earlier and harder than a test would. The runtime half (the table's key set == the
// enum in the schema, the table's value range ⊆ ACP StopReason) is pinned by test/codec.test.ts,
// which reads both schemas directly.
export type TurnEndReason = TurnEnd['reason']
export type AcpStopReason = StopReason

export const STOP_REASON_TABLE: Record<Exclude<TurnEndReason, 'error'>, AcpStopReason> = {
  completed: 'end_turn',
  max_steps: 'max_turn_requests',
  aborted: 'cancelled',
  interrupted: 'cancelled',
  budget: 'refusal',
  blocked: 'end_turn',
  parked: 'end_turn',
}

export function toAcpStopReason(reason: Exclude<TurnEndReason, 'error'>): AcpStopReason {
  const v = STOP_REASON_TABLE[reason]
  if (!v) throw new Error(`turn/end.reason ${String(reason)} has no ACP stopReason (error → JSON-RPC error)`)
  return v
}
