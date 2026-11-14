/**
 * Deliveries that keep waiting: a launch waits (as `Later`, which counts no failure) while whether a worker's session
 * received a put-back message cannot be confirmed. Such a wait can last for good without any other sign, so once the
 * same message waited `STALLED_AFTER` times in a row its ticket is named on the `deliveries` health entry.
 */
import type { HealthEntry } from '../infra/health.js'

/** Consecutive waits of one message that raise the health error. */
export const STALLED_AFTER = 3

type Stall = { ticketId: string; messageId: string; count: number; since: string; reason: string }

/** The waits of each ticket's messages, and the `deliveries` health entry they raise. */
export class DeliveryStalls {
  private readonly stalls = new Map<string, Stall>()
  constructor(private readonly health?: HealthEntry) {}
  /** The message of the ticket waited again, for `reason`. */
  waited(ticketId: string, messageId: string, reason: string): void {
    const key = `${ticketId}\0${messageId}`
    const before = this.stalls.get(key)
    const at = new Date().toISOString()
    this.stalls.set(key, {
      ticketId,
      messageId,
      count: (before?.count ?? 0) + 1,
      since: before?.since ?? at,
      reason,
    })
    this.report()
  }
  /** The ticket's messages no longer wait. */
  settled(ticketId: string): void {
    let changed = false
    for (const [key, stall] of this.stalls)
      if (stall.ticketId === ticketId) changed = this.stalls.delete(key) || changed
    if (changed) this.report()
  }
  private report(): void {
    const at = new Date().toISOString()
    const stalled = [...this.stalls.values()].filter((stall) => stall.count >= STALLED_AFTER)
    this.health?.set(
      stalled.length
        ? {
            state: 'error',
            detail: stalled
              .slice(0, 5)
              .map(
                (stall) =>
                  `Ticket ${stall.ticketId} waits to deliver ${stall.messageId}, ${stall.count} times since ${stall.since}: ${stall.reason.slice(0, 300)}`,
              )
              .join('; '),
            at,
          }
        : { state: 'ready', detail: 'No delivery waits to be confirmed', at },
    )
  }
}
