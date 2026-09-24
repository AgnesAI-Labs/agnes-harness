import { type HostSession, scanPages } from '@agnes/host'
import type { EventEnvelope } from '@agnes/protocol'

export type Disposer = () => void

export type TailOptions = {
  fromSeq: number
  onEvents: (evs: EventEnvelope[]) => void
  pollMs: number
  signal: AbortSignal
  /**
   * Called once if a ledger read fails while the tail is still meant to be running, after which the
   * tail stops. A read that loses a race with close is not reported: the caller asked for the tail to
   * end, and the failed read is how it found out.
   */
  onError?: (e: unknown) => void
}

type MaybeSubscribable = HostSession & {
  onAppended?: (fn: (evs: EventEnvelope[]) => void) => Disposer
  onFault?: (fn: (e: unknown) => void) => Disposer
}

/** Stops the tail when called; `deliveredThrough` is the highest seq handed to the consumer. */
export type TailHandle = Disposer & { deliveredThrough(): number }

/**
 * Follows one session's ledger from `fromSeq` on. A session that offers `onAppended` is followed by
 * push: rows arrive as they are committed, and its `onFault` notice ends the tail through `onError`
 * at the moment the log seals. Anything else is polled.
 */
export function tailSession(session: HostSession, o: TailOptions): TailHandle {
  const s = session as MaybeSubscribable
  let last = o.fromSeq - 1
  let stopped = false
  let unsubscribe: Disposer = () => undefined
  const halt = (): void => {
    stopped = true
    unsubscribe()
  }
  const fail = (e: unknown): void => {
    if (stopped || o.signal.aborted) return
    halt()
    o.onError?.(e)
  }
  /**
   * The consumer is called inside the try, not beside it. Outside, a throwing onEvents did not stop
   * one tail: the poll loop is started as `void loop()`, so the throw left the loop as an unhandled
   * rejection with `stopped` unset and onError never called - and under Node's default
   * --unhandled-rejections=throw that ends the whole process and every other session with it.
   *
   * Ruling: a throwing consumer stops this tail and is reported, the same treatment a failed ledger
   * read gets. The cost is that one bad consumer ends one session's stream rather than dropping a
   * single row: `last` has already advanced past what it was handed, so carrying on would deliver a
   * stream with a silent hole in it, and a stream that stops loudly is worth more than one that
   * lies. The blast radius is this session; the process and every other session are untouched.
   */
  const deliver = (evs: EventEnvelope[]): void => {
    if (stopped || o.signal.aborted) return
    const fresh = evs.filter((e) => e.seq > last)
    if (fresh.length === 0) return
    last = (fresh[fresh.length - 1] as EventEnvelope).seq
    try {
      o.onEvents(fresh)
    } catch (e) {
      fail(e)
    }
  }
  const handle = (fn: Disposer): TailHandle => Object.assign(fn, { deliveredThrough: () => last })
  if (typeof s.onAppended === 'function') {
    // Bounded, because core refuses an unbounded scan, and read in pages, because one scan stops at
    // the adapter's page size.
    const read = async (fromSeq: number, toSeq: number): Promise<void> => {
      const pages = scanPages((q) => session.scan(q) as Promise<EventEnvelope[]>, { fromSeq, toSeq })
      for await (const page of pages) {
        if (stopped || o.signal.aborted) return
        deliver(page)
      }
    }
    // Live rows wait here while the history, or a gap in the pushed stream, is read. Delivering them
    // as they arrive would advance `last` past the unread rows, and because deliver() filters on
    // `e.seq > last` those rows would then vanish - it drops, it does not dedupe.
    let queue: EventEnvelope[] = []
    let reading = true
    const drain = async (): Promise<void> => {
      while (queue.length > 0 && !stopped && !o.signal.aborted) {
        const first = (queue[0] as EventEnvelope).seq
        if (first <= last) {
          queue.shift()
          continue
        }
        if (first > last + 1) {
          // A batch whose commit notice never went out: read what it held from the ledger.
          const before = last
          await read(last + 1, first - 1)
          if (last === before && !stopped && !o.signal.aborted)
            throw new Error(`ledger rows ${before + 1}..${first - 1} could not be read`)
          continue
        }
        let n = 1
        while (
          n < queue.length &&
          (queue[n] as EventEnvelope).seq === (queue[n - 1] as EventEnvelope).seq + 1
        )
          n++
        deliver(queue.splice(0, n))
      }
      reading = false
    }
    const onBatch = (evs: EventEnvelope[]): void => {
      if (stopped || o.signal.aborted || evs.length === 0) return
      queue.push(...evs)
      if (reading) return
      if ((evs[0] as EventEnvelope).seq <= last + 1) {
        const batch = queue
        queue = []
        deliver(batch)
        return
      }
      reading = true
      void drain().catch(fail)
    }
    try {
      const offAppended = s.onAppended(onBatch)
      unsubscribe = offAppended
      const offFault = s.onFault?.(fail)
      if (offFault)
        unsubscribe = () => {
          offAppended()
          offFault()
        }
    } catch (e) {
      stopped = true
      unsubscribe()
      queueMicrotask(() => o.onError?.(e))
      return handle(() => undefined)
    }
    // Rows past the captured head arrive on the subscription and wait until the history is read.
    const head = session.lastSeq
    void read(o.fromSeq, head).then(drain).catch(fail)
    o.signal.addEventListener('abort', halt, { once: true })
    return handle(halt)
  }
  const loop = async (): Promise<void> => {
    while (!stopped && !o.signal.aborted) {
      let evs: EventEnvelope[]
      try {
        evs = (await session.scan({ fromSeq: last + 1, limit: 500 })) as EventEnvelope[]
      } catch (e) {
        // Retrying would spin at pollMs against a ledger that is not coming back, and swallowing it
        // would leave a session whose stream simply stopped with nothing said. It stops and reports.
        fail(e)
        return
      }
      if (evs.length > 0) deliver(evs)
      else await new Promise((r) => setTimeout(r, o.pollMs))
    }
  }
  void loop()
  o.signal.addEventListener('abort', halt, { once: true })
  return handle(halt)
}
