import type { OpStateObj } from '@agnes/core-common/step/op-state'
import { CoreError, type EventInput, type Seq } from '@agnes/core-common/types'
import { SCAN_PAGE_MAX } from '@agnes/core-ledger/log/storage'
import type { Actor } from '@agnes/protocol'
import type { SessionImpl, TurnMemory } from './session.js'

/**
 * A prompt's wall-clock limit (`agh -p --timeout`). Core does not stop the turn at it: the client
 * that set it cancels the turn at the deadline. Core records it so the model can be told how much
 * time it has (see `turn-limits.ts`). Like the step cap it travels as two `ignorable` rows of its
 * own, so an older core skips them and runs the turn without the notes.
 */
export const INBOX_TIME_LIMIT_EVENT = 'x/core/inbox-time-limit'
export const TURN_TIME_LIMIT_EVENT = 'x/core/turn-time-limit'
/** One day, the longest `--timeout` the CLI accepts. */
export const TIME_LIMIT_MAX_MS = 86_400_000

/** `deadlineAt` is epoch milliseconds, fixed when the prompt is queued so it does not move later. */
export type TurnTimeLimit = { timeLimitMs: number; deadlineAt: number }

export const validTimeLimit = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= TIME_LIMIT_MAX_MS

export function timeLimitEvent(
  type: typeof INBOX_TIME_LIMIT_EVENT | typeof TURN_TIME_LIMIT_EVENT,
  actor: Actor,
  data: ({ itemId: string } | { turn: number }) & TurnTimeLimit,
): EventInput {
  return { type, origin: 'system', trust: 'trusted', actor, data, ignorable: true }
}

type Row = { itemId?: unknown; turn?: unknown; timeLimitMs?: unknown; deadlineAt?: unknown }

async function readLimit(
  s: SessionImpl,
  type: string,
  range: { fromSeq: Seq } | undefined,
  matches: (row: Row) => boolean,
): Promise<TurnTimeLimit | undefined> {
  let toSeq: Seq | undefined
  for (;;) {
    const rows = await s.d.log.scan({
      type,
      order: 'desc',
      limit: SCAN_PAGE_MAX,
      ...(range ?? {}),
      ...(toSeq === undefined ? {} : { toSeq }),
    })
    for (const event of rows) {
      const data = (event.data ?? {}) as Row
      if (!matches(data)) continue
      if (
        !validTimeLimit(data.timeLimitMs) ||
        typeof data.deadlineAt !== 'number' ||
        !Number.isSafeInteger(data.deadlineAt)
      )
        throw new CoreError('E_ENVELOPE', 'stored per-turn time limit is invalid')
      return { timeLimitMs: data.timeLimitMs, deadlineAt: data.deadlineAt }
    }
    const oldest = rows.at(-1)
    if (rows.length < SCAN_PAGE_MAX || !oldest || oldest.seq <= 1) return undefined
    toSeq = (oldest.seq - 1) as Seq
  }
}

export const inboxTimeLimit = (s: SessionImpl, itemId: string) =>
  readLimit(s, INBOX_TIME_LIMIT_EVENT, undefined, (r) => r.itemId === itemId)

/** The open turn's limit. Turn memory is per process; recovery rebuilds it from the ledger. */
const turnTimeLimits = new WeakMap<TurnMemory, TurnTimeLimit>()

export function setTurnTimeLimit(turn: TurnMemory, limit: TurnTimeLimit | undefined): void {
  if (limit) turnTimeLimits.set(turn, limit)
}

export const turnTimeLimit = (turn: TurnMemory | null | undefined): TurnTimeLimit | undefined =>
  turn ? turnTimeLimits.get(turn) : undefined

/** Recovery: reads the open turn's limit back off its own row, never from process memory. */
export async function rehydrateTimeLimit(s: SessionImpl, op: OpStateObj, turn: TurnMemory): Promise<void> {
  const range = { fromSeq: op.meta.triggerSeq }
  setTurnTimeLimit(turn, await readLimit(s, TURN_TIME_LIMIT_EVENT, range, (r) => r.turn === op.meta.turn))
}
