import type { EventEnvelope } from '@agnes/protocol'

/** The event types `observeSessionRequests` reacts to; a ledger catch-up reads exactly these. */
export const SESSION_REQUEST_EVENT_TYPES: readonly string[] = [
  'turn/start',
  'x/core/preset-switch',
  'x/core/control',
]

type SessionRequests = {
  resetSessionRequests(sessionKey: string): void
  revokeSessionRequests(sessionKey: string): void
}

/** Ties a session's worker-initiated requests to the turn and stop events that bound them. */
export function observeSessionRequests(pool: SessionRequests, sessionKey: string, e: EventEnvelope): void {
  if (e.type === 'turn/start') pool.resetSessionRequests(sessionKey)
  if (
    e.type === 'x/core/preset-switch' &&
    e.origin === 'system' &&
    (e.data as { fromPermission?: string }).fromPermission === 'full-access'
  ) {
    pool.revokeSessionRequests(sessionKey)
    pool.resetSessionRequests(sessionKey)
  }
  const control = e.data as { action?: unknown; outcome?: unknown }
  if (
    e.type === 'x/core/control' &&
    e.origin === 'principal' &&
    control.outcome === 'requested' &&
    (control.action === 'cancel' || control.action === 'interrupt')
  )
    pool.revokeSessionRequests(sessionKey)
}
