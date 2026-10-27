import type { NoticeSink } from '@agnes/daemon-foundation/local/notice'
import type { SessionPrincipalOwnership } from '@agnes/daemon-foundation/storage/session-ownership'
import type { EventEnvelope, SessionActivity } from '@agnes/protocol'

/** The ledger rows that move a session between running, waiting for its owner, and idle. */
export const SESSION_ACTIVITY_EVENT_TYPES: readonly string[] = ['turn/start', 'turn/end', 'decision/state']

type Tracked = {
  running: boolean
  /** Open decisions by id: a permission request is an approval, anything else asks a question. */
  pending: Map<string, 'approval' | 'question'>
  reason?: SessionActivity['reason']
  published?: string
}

type DecisionState = {
  handle?: { id?: unknown; sessionId?: unknown }
  request?: { category?: unknown }
  result?: unknown
  invalidation?: unknown
  consumption?: unknown
}

/**
 * Every session's running/waiting/idle state, read from its ledger rows as the daemon receives them,
 * whether or not a client is attached. A change is pushed to the owner's connections as a
 * `session_activity` notice, so a page sees sessions it left in the background finish or stop to
 * wait for an approval or an answer; `list` gives a page its starting point.
 */
export function createSessionActivity(o: {
  ownership: Pick<SessionPrincipalOwnership, 'resolve'>
  notices: Pick<NoticeSink, 'emit'>
  profile: string
}) {
  const sessions = new Map<string, Tracked>()
  const view = (key: string, s: Tracked): SessionActivity => {
    const waiting = [...s.pending.values()]
    return {
      sessionId: key,
      ...(waiting.length
        ? { state: 'waiting', waiting: waiting.includes('approval') ? 'approval' : 'question' }
        : { state: s.running ? 'running' : 'idle' }),
      ...(s.reason && !s.running ? { reason: s.reason } : {}),
    } as SessionActivity
  }
  /**
   * `live` is false while a session's history is replayed on open: the state is rebuilt silently,
   * and only rows that arrive afterwards are announced.
   */
  const observe = (key: string, event: EventEnvelope, live = true): void => {
    if (!SESSION_ACTIVITY_EVENT_TYPES.includes(event.type)) return
    const s: Tracked = sessions.get(key) ?? { running: false, pending: new Map() }
    if (event.type === 'turn/start') {
      s.running = true
      delete s.reason
    } else if (event.type === 'turn/end') {
      s.running = false
      const reason = (event.data as { reason?: unknown } | undefined)?.reason
      if (typeof reason === 'string') s.reason = reason as SessionActivity['reason']
    } else {
      const decision = event.data as DecisionState | undefined
      const id = decision?.handle?.id
      if (typeof id !== 'string' || decision?.handle?.sessionId !== key) return
      if (decision.result || decision.invalidation || decision.consumption) s.pending.delete(id)
      else s.pending.set(id, decision.request?.category === 'permission' ? 'approval' : 'question')
    }
    const current = view(key, s)
    const signature = JSON.stringify(current)
    const changed = signature !== s.published
    s.published = signature
    // An idle session with nothing open needs no memory; its last state was already announced.
    if (!s.running && s.pending.size === 0) sessions.delete(key)
    else sessions.set(key, s)
    if (!live || !changed) return
    const owner = o.ownership.resolve(key)
    if (!owner) return
    o.notices.emit('session_activity', {
      sessionId: key,
      detail: { profile: o.profile, owner: owner.principalId, ...current },
    })
  }
  return {
    observe,
    /** Running and waiting sessions this principal owns; every other session is idle. */
    list(principalId: string): { items: SessionActivity[] } {
      const items: SessionActivity[] = []
      for (const [key, s] of sessions)
        if (o.ownership.resolve(key)?.principalId === principalId) items.push(view(key, s))
      return { items }
    },
  }
}

export type SessionActivityTracker = ReturnType<typeof createSessionActivity>
