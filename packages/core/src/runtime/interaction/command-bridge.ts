import type { Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import {
  fail,
  type InteractionStorage,
  type InteractionWake,
  type StoredInteractionWake,
} from './authority.js'

/**
 * Hands one wake to the Runtime inbox and returns its acknowledgement. Delivery is at least once, so
 * the inbox must accept a repeated delivery key without waking the waiter again.
 */
export type InteractionWakeSink = (wake: InteractionWake) => Promise<Outcome<{ deliveryId: string }>>

export type InteractionBridgeOptions = Readonly<{
  /** Consecutive failures before a wake becomes a visible dead letter. */
  maxFailures?: number
  /** Wakes delivered per flush. */
  batch?: number
}>

const SECOND = 1000
const backoff = (failures: number) => Math.min(60 * SECOND, SECOND * 2 ** (failures - 1))

/**
 * Delivers stored wakes from the interaction store to the Runtime inbox. An acknowledged answer moves its
 * response status from accepted to applied; that still says nothing about whether the Loop has run.
 */
export function createInteractionBridge(
  storage: InteractionStorage,
  sink: InteractionWakeSink,
  clock: Readonly<{ now(): Wire.Timestamp }>,
  options: InteractionBridgeOptions = {},
) {
  const maxFailures = options.maxFailures ?? 20
  const batch = options.batch ?? 100

  async function settle(key: string, result: Outcome<{ deliveryId: string }>) {
    const now = clock.now()
    return storage.transaction((tx): StoredInteractionWake['delivery'] | undefined => {
      const current = tx.wake(key)
      // Another flush settled it first; the inbox already dedupes the second delivery.
      if (current?.delivery !== 'pending') return undefined
      if (result.ok) {
        tx.putWake({ ...current, delivery: 'acked', ackRef: result.value.deliveryId, lastError: null })
        const responseId = current.wake.responseId
        const response = responseId === null ? undefined : tx.response(responseId)
        if (response && response.status.status === 'accepted')
          tx.putResponse({ ...response, status: { ...response.status, status: 'applied' } })
        return 'acked'
      }
      const failures = current.consecutiveFailures + 1
      const delivery = failures >= maxFailures ? 'dead' : 'pending'
      tx.putWake({
        ...current,
        delivery,
        consecutiveFailures: failures,
        lastError: result.error,
        nextAttemptAt: new Date(Date.parse(now) + backoff(failures)).toISOString(),
      })
      return delivery
    })
  }

  return {
    async flush(): Promise<{ acked: number; retrying: number; dead: number }> {
      const due = await storage.transaction((tx) => tx.dueWakes(clock.now(), batch))
      const counts = { acked: 0, retrying: 0, dead: 0 }
      for (const stored of due) {
        let result: Outcome<{ deliveryId: string }>
        try {
          result = await sink(stored.wake)
        } catch (error) {
          result = fail('backend_unavailable', error instanceof Error ? error.message : 'inbox unavailable')
        }
        const settled = await settle(stored.wake.deliveryKey, result)
        if (settled === 'acked') counts.acked++
        else if (settled === 'pending') counts.retrying++
        else if (settled === 'dead') counts.dead++
      }
      return counts
    },

    /** Returns a dead wake to delivery under its original key and payload. */
    async redrive(deliveryKey: string): Promise<Outcome<StoredInteractionWake>> {
      const now = clock.now()
      return storage.transaction((tx) => {
        const current = tx.wake(deliveryKey)
        if (!current) return fail('not_found', 'no such wake')
        if (current.delivery !== 'dead') return fail('revision_conflict', 'only a dead wake can be redriven')
        const next: StoredInteractionWake = {
          ...current,
          delivery: 'pending',
          consecutiveFailures: 0,
          nextAttemptAt: now,
        }
        tx.putWake(next)
        return { ok: true as const, value: next }
      })
    },
  }
}

export type InteractionBridge = ReturnType<typeof createInteractionBridge>
