import type { EventEnvelope, HarnessMeta, TurnEndReason } from '@agnes/protocol'

// One of these per session per connection. It is threaded through the event stream rather than held
// inside the stamper, so two connections reading the same session cannot see each other's position.
export type MetaState = {
  promptTurnId: string | null
  generation: number
  lastCredits?: HarnessMeta['credits']
}

export function stampMeta(event: EventEnvelope, st: MetaState): { meta: HarnessMeta; next: MetaState } {
  const next: MetaState = { ...st }
  let phase: HarnessMeta['phase'] = 'event'
  let turnEnd: HarnessMeta['turnEnd']
  const data = (event.data ?? {}) as Record<string, unknown>
  switch (event.type) {
    case 'turn/start':
      next.promptTurnId = String(event.seq)
      break
    case 'assistant/message':
      phase = 'responseBoundary'
      break
    case 'cost/ledger':
      // A ledger line without a number carries no new figure, so the last known one stands rather
      // than being replaced by a zero nobody measured.
      if (typeof data.credits === 'number')
        next.lastCredits = {
          used: data.credits,
          source: data.creditSource === 'gateway' ? 'gateway' : 'estimated',
        }
      break
    case 'turn/end': {
      const reason = data.reason as TurnEndReason
      phase = reason === 'parked' ? 'parked' : 'terminalQuiescence'
      turnEnd = { reason }
      break
    }
  }
  // Before the first turn/start there is no turn to name, and generation is passed through as the
  // caller set it. The stand-in below is this file's own invention rather than a defined value, and
  // whatever settles what a pre-turn event carries decides whether it survives. It is schema-valid
  // and cannot collide with a real turn id, since those are seq numbers and seq starts at 1 - but
  // nothing outside this file says so, so a consumer cannot tell "before the first turn" from a turn
  // named 0 without reading it. That is the debt, not the value.
  const meta: HarnessMeta = {
    promptTurnId: next.promptTurnId ?? '0',
    eventSequence: event.seq,
    generation: st.generation,
    lane: event.lane ?? 'main',
    phase,
    ...(next.lastCredits ? { credits: next.lastCredits } : {}),
    ...(turnEnd ? { turnEnd } : {}),
  }
  return { meta, next }
}
