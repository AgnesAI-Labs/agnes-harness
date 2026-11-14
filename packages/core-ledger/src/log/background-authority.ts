import type { PreparedEvent } from '@agnes/core-common/types'
import type { SessionLogImpl } from './session-log.js'

type Boundary = Readonly<{ turn: number; startSeq: number; endSeq: number; lastAssistantSeq: number }>
type Claim = { log: SessionLogImpl; caller: string; source: Boundary; active: boolean; effects: Set<string> }
const claims = new WeakMap<object, Claim>()

/** Internal writer authority. Plugins never receive this token or the log that minted it. */
export function createBackgroundAppendAuthority(log: SessionLogImpl, source: Boundary, caller: string) {
  const token = Object.freeze({})
  const claim: Claim = { log, source: Object.freeze({ ...source }), caller, active: true, effects: new Set() }
  claims.set(token, claim)
  return {
    token,
    revoke() {
      claim.active = false
    },
  }
}

/** Live append needs the exact writer claim; replay instead verifies the durable completed-source proof. */
export function backgroundAppendAllowed(
  token: object | undefined,
  log: SessionLogImpl,
  events: readonly PreparedEvent[],
): boolean {
  const claim = token && claims.get(token)
  if (!claim || claim.log !== log) return false
  for (const event of events) {
    const data = event.data as { effectId?: string; kind?: string }
    if (event.type === 'effect/intent') {
      if (!claim.active || data.kind !== 'side-call' || typeof data.effectId !== 'string') return false
      const audit = events.find(
        (row) =>
          row.type === 'x/core/side-call-intent' &&
          (row.data as { binding?: { effectId?: string } }).binding?.effectId === data.effectId,
      )?.data as { audit?: { caller?: string; source?: Boundary } } | undefined
      const source = audit?.audit?.source
      if (
        audit?.audit?.caller !== claim.caller ||
        !source ||
        source.turn !== claim.source.turn ||
        source.startSeq !== claim.source.startSeq ||
        source.endSeq !== claim.source.endSeq ||
        source.lastAssistantSeq !== claim.source.lastAssistantSeq
      )
        return false
      claim.effects.add(data.effectId)
    }
    if (event.type === 'effect/settled' && (!data.effectId || !claim.effects.has(data.effectId))) return false
  }
  return true
}
