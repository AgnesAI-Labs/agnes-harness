import type { LoopContext } from '@agnes/extension-api'
import type { Inbox } from '../reduce/shapes.js'
import type { SessionImpl } from '../step/session.js'
import { CoreError } from '../types.js'

const WAKE = 'x/core/loop-wake'
const CONSUMED = 'x/core/loop-wake-consumed'

/** A ledger token closes both the pre-registration race and the process restart gap. */
export async function loopWait(
  s: SessionImpl,
  restore: boolean,
): Promise<{
  park: LoopContext['wait']['park']
  wake: LoopContext['wait']['wake']
  dispose(): void
}> {
  const fromSeq = (s.d.log.parent?.boundarySeq ?? 0) + 1
  let latest = 0,
    consumed = 0
  // A fresh child uses only its in-memory snapshot and never rereads the inherited prefix.
  if (restore) {
    latest = (await s.d.log.scan({ type: WAKE, lane: s.lane, fromSeq, order: 'desc', limit: 1 }))[0]?.seq ?? 0
    const [consumedRow] = await s.d.log.scan({
      type: CONSUMED,
      lane: s.lane,
      fromSeq,
      order: 'desc',
      limit: 1,
    })
    const [checkpoint] = await s.d.log.scan({
      type: 'x/core/loop-checkpoint',
      lane: s.lane,
      fromSeq,
      order: 'desc',
      limit: 1,
    })
    // Delivery after the last checkpoint must be redelivered on cold resume.
    // A crash between park() and saving the next stage otherwise strands that stage forever.
    if (consumedRow && consumedRow.seq <= (checkpoint?.seq ?? 0))
      consumed = (consumedRow.data as { wakeSeq: number }).wakeSeq
  }
  let disposed = false
  const waiters = new Set<() => void>()
  const notify = () => {
    for (const resolve of waiters) resolve()
  }
  const stop = s.onAppended((events) => {
    for (const event of events) if (event.type === WAKE && event.lane === s.lane) latest = event.seq
    if (
      events.some(
        (event) =>
          event.lane === s.lane && [WAKE, 'inbox', 'approval/decided', 'artifact/job'].includes(event.type),
      )
    )
      notify()
  })
  const stopFault = s.d.log.onFault(notify)
  function check() {
    if (disposed || s.closingOrClosed) throw new CoreError('E_CLOSED', 'Loop wait is closed')
    if (s.d.log.faulted) throw new CoreError('E_STORAGE_FAULT', 'Loop ledger is faulted')
  }
  return {
    async wake() {
      const done = s.beginLoopOperation()
      try {
        check()
        await s.d.log.append([s.ev(WAKE, {}, { ignorable: true })])
      } finally {
        done()
      }
    },
    async park(signal) {
      const done = s.beginLoopOperation()
      try {
        signal = AbortSignal.any([signal, s.ac.signal])
        for (;;) {
          if (signal.aborted) return
          check()
          const consumedWake = await s.locked(async () => {
            if (signal.aborted) return false
            if (latest <= consumed) return false
            const wakeSeq = latest
            await s.d.log.append([s.ev(CONSUMED, { wakeSeq }, { ignorable: true })])
            consumed = wakeSeq
            return true
          })
          if (signal.aborted) return
          if (consumedWake || ((s.latest('inbox') as Inbox | undefined)?.items.length ?? 0) > 0) return
          await new Promise<void>((resolve) => {
            const finish = () => {
              waiters.delete(finish)
              signal.removeEventListener('abort', finish)
              resolve()
            }
            waiters.add(finish)
            signal.addEventListener('abort', finish, { once: true })
            // Recheck after asynchronous consumption/read and waiter registration.
            if (
              signal.aborted ||
              disposed ||
              latest > consumed ||
              ((s.latest('inbox') as Inbox | undefined)?.items.length ?? 0) > 0
            )
              finish()
          })
          // Approval/job notifications wake a scheduler too, without inventing durable wake tokens.
          if (signal.aborted || disposed) return
          check()
          if (latest <= consumed) return
        }
      } finally {
        done()
      }
    },
    dispose() {
      disposed = true
      notify()
      stop()
      stopFault()
    },
  }
}
