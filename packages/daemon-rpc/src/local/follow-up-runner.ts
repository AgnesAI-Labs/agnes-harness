import { runQueued } from './command-queue.js'
import type { LocalContext } from './methods/acp.js'
import type { SessionEntry } from './sessions.js'

/** Reuse the persisted inbox; admission stays serialized, but model IO never holds its queue. */
export function createFollowUpRunner(
  cx: Pick<LocalContext, 'commandQueue' | 'activationBarrier' | 'onPromptStart' | 'onPromptEnd'>,
  pushed: (entry: SessionEntry, seq: number) => Promise<void>,
): (entry: SessionEntry, inherited?: NonNullable<SessionEntry['inflight']>, restart?: boolean) => void {
  return (entry, inherited, restart = false) => {
    if (!restart && entry.inflight && entry.inflight !== inherited) return
    const previous = entry.inflight
    const flight = inherited ?? { promptId: 'follow-up', abort: new AbortController() }
    entry.inflight = flight
    if (!inherited && !previous) cx.onPromptStart?.(entry.key)
    const finish = () => {
      if (entry.inflight !== flight) return
      entry.inflight = null
      cx.onPromptEnd?.(entry.key)
    }
    const abort = () => flight.abort.abort()
    entry.ac.signal.addEventListener('abort', abort, { once: true })
    // Return the first prompt's response before admitting the next turn's notifications.
    void (async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      let immediate = restart
      for (;;) {
        let running: ReturnType<SessionEntry['session']['run']> | undefined
        await runQueued(cx.commandQueue, entry.key, flight.abort.signal, async () => {
          if (entry.inflight !== flight || entry.ac.signal.aborted || flight.abort.signal.aborted)
            return finish()
          const [end] = await entry.session.scan({ type: 'turn/end', order: 'desc', limit: 1, lane: 'main' })
          const reason = (end?.data as { reason?: string } | undefined)?.reason
          if (!immediate && (reason === 'parked' || reason === 'blocked')) return finish()
          const [row] = await entry.session.scan({ type: 'inbox', order: 'desc', limit: 1, lane: 'main' })
          const items = (row?.data as { items?: Array<{ target: string; kind?: string }> } | null)?.items
          const first = items?.find((item) => item.target === 'next-turn')
          const controls = await entry.session.controls.state()
          if (controls.paused) return finish()
          const open = immediate && (await entry.session.projectUI()).opState !== null
          if ((!first && !open) || (!immediate && first?.kind !== 'follow_up' && first?.kind !== 'steer'))
            return finish()
          immediate = false
          const queued = cx.activationBarrier.enqueue('turn')
          try {
            const invocation = await queued.start()
            running = invocation.run(() =>
              entry.session.run({ until: 'turn-end', signal: flight.abort.signal }),
            )
          } finally {
            queued.cancel()
          }
        })
        if (!running) return
        const outcome = await running
        await pushed(entry, outcome.lastSeq)
        if (entry.inflight !== flight || outcome.reason !== 'completed' || flight.abort.signal.aborted) return
      }
    })()
      .catch(() => {
        // Model failures are persisted by Core; admission/transport failure leaves the inbox intact.
        if (!entry.ac.signal.aborted && !flight.abort.signal.aborted)
          console.error('Queued follow-up could not continue; pending input remains in the session inbox.')
      })
      .finally(() => {
        entry.ac.signal.removeEventListener('abort', abort)
        finish()
      })
  }
}
