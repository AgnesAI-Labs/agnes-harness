import type { NoticeSink } from '@agnes/daemon-foundation/local/notice'
import type { SessionWorkspacePort, TicketPort } from '@agnes/daemon-foundation/storage/lister'
import type { SessionPrincipalOwnership } from '@agnes/daemon-foundation/storage/session-ownership'
import { indexApprovalTicket } from '@agnes/daemon-rpc/local/methods/agnes'
import type { EventEnvelope } from '@agnes/protocol'
import type { WorkerRegistry } from './registry.js'

/**
 * Index a parked ticket with its worker workspace before publishing the same row to subscribers.
 * `onWire` runs when the row arrives, or, while the session's open is still catching up on its
 * history, in order behind that catch-up.
 */
export function deliverWorkerEvent(
  registry: Pick<WorkerRegistry, 'get' | 'deliver'>,
  tickets: TicketPort | undefined,
  clock: () => number,
  sessionKey: string,
  event: EventEnvelope,
  workspaces?: Pick<SessionWorkspacePort, 'observe'>,
  onWire?: () => void,
): void | Promise<void> {
  const publish = () => {
    workspaces?.observe(sessionKey, event, registry.get(sessionKey)?.generation)
    if (tickets) {
      tickets.gc(clock())
      indexApprovalTicket(tickets, sessionKey, event, registry.get(sessionKey)?.session.cwd)
    }
  }
  const indexBeforePublish = () => {
    publish()
  }
  return registry.deliver(sessionKey, event, indexBeforePublish, onWire)
}

/** Observe durable run state before publishing its owner-scoped invalidation. */
export function createAutomationEvents(
  ownership: Pick<SessionPrincipalOwnership, 'resolve'>,
  notices: Pick<NoticeSink, 'emit'>,
  profile: string,
) {
  const observers: {
    schedules?:
      | {
          observeSession(key: string, event: EventEnvelope): boolean
          notificationSession(key: string): string | undefined
        }
      | undefined
    triggers?: ((key: string, event: EventEnvelope) => boolean) | undefined
    observe(key: string, event: EventEnvelope): void
  } = {
    observe(key, event) {
      const scheduleAttention = observers.schedules?.observeSession(key, event)
      const triggerAttention = observers.triggers?.(key, event)
      if (!scheduleAttention && !triggerAttention) return
      const owner = ownership.resolve(key)
      if (!owner) return
      const detail = { profile, owner: owner.principalId, reason: 'needs_attention', runSessionId: key }
      notices.emit('automation_attention', { sessionId: key, detail })
      const origin = observers.schedules?.notificationSession(key)
      if (origin && origin !== key) notices.emit('automation_attention', { sessionId: origin, detail })
    },
  }
  return observers
}
