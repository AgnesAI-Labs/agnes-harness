import type { EventEnvelope } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { tailSession } from '../src/local/tail.js'
import { openTestHost } from './host.js'

const actor = { id: 'tester', org: 'local', role: 'owner', deptPath: [], attrs: {} }

describe('tailSession', () => {
  it('delivers every appended event from fromSeq on, in seq order, with no gap', async () => {
    const h = await openTestHost()
    const session = await h.host.createSession({ cwd: h.dataDir })
    const seen: number[] = []
    const ac = new AbortController()
    tailSession(session, {
      fromSeq: 1,
      onEvents: (evs) => seen.push(...evs.map((e) => e.seq)),
      pollMs: 5,
      signal: ac.signal,
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await new Promise((r) => setTimeout(r, 60))
    // Sortedness alone passes on a truncated stream. Pin the start and the density too.
    expect(seen[0]).toBe(1)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(seen).toEqual([...new Set(seen)])
    expect(seen).toEqual(Array.from({ length: seen.length }, (_, i) => i + 1))
    ac.abort()
    await h.close()
  })

  it('a throwing consumer is reported through onError and never reaches the process', async () => {
    // deliver() used to call onEvents outside the try that guards the scan, and the poll loop is
    // started as `void loop()`. A throwing consumer therefore left the loop as an unhandled
    // rejection - onError never called, `stopped` never set - and under Node's default
    // --unhandled-rejections=throw that ends the process and every other session with it.
    const rows = [1].map((seq) => ({
      seq,
      ts: 't',
      id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
      type: 'user/message',
      data: {},
      actor,
      origin: 'principal',
      trust: 'trusted',
      lane: 'main',
    }))
    let scans = 0
    const stub = { lastSeq: 1, scan: async () => (scans++ === 0 ? rows : []) }
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e)
    }
    process.on('unhandledRejection', onUnhandled)
    const errors: unknown[] = []
    const ac = new AbortController()
    let calls = 0
    try {
      tailSession(stub as never, {
        fromSeq: 1,
        onEvents: () => {
          calls++
          throw new Error('consumer blew up')
        },
        pollMs: 5,
        signal: ac.signal,
        onError: (e) => errors.push(e),
      })
      // Long enough for several more polls, so "it stopped" is a claim about the loop and not about
      // the test being over before the next one.
      await new Promise((r) => setTimeout(r, 80))
    } finally {
      ac.abort()
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('consumer blew up')
    // Stopped, not spinning: the consumer is called once and the tail does not go back for more.
    expect(calls).toBe(1)
  })

  it('with onAppended present, the history page is never lost to a live event arriving first', async () => {
    const rows = [1, 2, 3].map((seq) => ({
      seq,
      ts: 't',
      id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
      type: 'user/message',
      data: {},
      actor,
      origin: 'principal',
      trust: 'trusted',
      lane: 'main',
    }))
    let fire: ((evs: unknown[]) => void) | undefined
    let releaseScan: (() => void) | undefined
    const pending = new Promise<void>((r) => {
      releaseScan = r
    })
    const stub = {
      lastSeq: 3,
      scan: async () => {
        await pending
        return rows.slice(0, 3)
      },
      onAppended: (fn: (evs: unknown[]) => void) => {
        fire = fn
        return () => undefined
      },
    }
    const seen: number[] = []
    const ac = new AbortController()
    tailSession(stub as never, {
      fromSeq: 1,
      onEvents: (evs) => seen.push(...evs.map((e) => e.seq)),
      pollMs: 5,
      signal: ac.signal,
    })
    // A live row lands while the history scan is still in flight.
    fire?.([{ ...rows[2], seq: 4 }])
    releaseScan?.()
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toEqual([1, 2, 3, 4])
    ac.abort()
  })

  it('with onAppended present, a history longer than one page arrives whole and in order', async () => {
    const row = (seq: number) => ({
      seq,
      ts: 't',
      id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
      type: 'user/message',
      data: {},
      actor,
      origin: 'principal',
      trust: 'trusted',
      lane: 'main',
    })
    const rows = Array.from({ length: 1200 }, (_, i) => row(i + 1))
    let fire: ((evs: unknown[]) => void) | undefined
    let reads = 0
    const stub = {
      lastSeq: 1200,
      // Capped at 500 whatever it is asked for, as the SQLite adapter is; a stub that returned the
      // whole range would pass a tail that reads its history in one call.
      scan: async (q: { fromSeq?: number; toSeq?: number; limit?: number }) => {
        const page = rows
          .filter(
            (r) =>
              (q.fromSeq === undefined || r.seq >= q.fromSeq) && (q.toSeq === undefined || r.seq <= q.toSeq),
          )
          .slice(0, Math.min(q.limit ?? 500, 500))
        if (++reads === 1) {
          // Five rows are appended between the first history page and the second.
          const live = Array.from({ length: 5 }, (_, i) => row(1201 + i))
          rows.push(...live)
          stub.lastSeq = 1205
          fire?.(live)
        }
        return page
      },
      onAppended: (fn: (evs: unknown[]) => void) => {
        fire = fn
        return () => undefined
      },
    }
    const seen: number[] = []
    const ac = new AbortController()
    tailSession(stub as never, {
      fromSeq: 1,
      onEvents: (evs) => seen.push(...evs.map((e) => e.seq)),
      pollMs: 5,
      signal: ac.signal,
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(seen).toEqual(Array.from({ length: 1205 }, (_, i) => i + 1))
    ac.abort()
  })

  it('stops on a read failure and reports it, rather than spinning on a broken ledger', async () => {
    let calls = 0
    const stub = {
      scan: async () => {
        calls++
        throw new Error('ledger gone')
      },
    }
    const errors: unknown[] = []
    const ac = new AbortController()
    tailSession(stub as never, {
      fromSeq: 1,
      onEvents: () => undefined,
      pollMs: 1,
      signal: ac.signal,
      onError: (e) => errors.push(e),
    })
    await new Promise((r) => setTimeout(r, 30))
    // One failed read, one report, and no further polling: a loop that retried forever would have
    // called scan many times over 30ms at a 1ms interval.
    expect(calls).toBe(1)
    expect((errors[0] as Error).message).toBe('ledger gone')
    ac.abort()
  })

  it('a read that loses a race with close is not reported as a failure', async () => {
    const ac = new AbortController()
    const errors: unknown[] = []
    const stub = {
      scan: async () => {
        ac.abort()
        throw new Error('storage closed')
      },
    }
    tailSession(stub as never, {
      fromSeq: 1,
      onEvents: () => undefined,
      pollMs: 1,
      signal: ac.signal,
      onError: (e) => errors.push(e),
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(errors).toEqual([])
  })
})

const prompt = (text: string) => ({ content: [{ type: 'text' as const, text }], actor })
const settle = () => new Promise((r) => setTimeout(r, 30))
const contiguous = (seqs: number[], from: number) =>
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => from + i))

describe('tailSession on a live session pushes rather than polls', () => {
  it('reads the ledger only to catch up, then delivers every commit without scanning', async () => {
    const h = await openTestHost()
    const session = await h.host.createSession({ cwd: h.dataDir })
    await session.enqueue('next-turn', prompt('before'))
    const scan = vi.spyOn(session, 'scan')
    const seen: number[] = []
    const ac = new AbortController()
    const tail = tailSession(session, {
      fromSeq: 1,
      onEvents: (evs) => seen.push(...evs.map((e) => e.seq)),
      pollMs: 5,
      signal: ac.signal,
    })
    await vi.waitFor(() => expect(seen.at(-1)).toBe(session.lastSeq))
    const caughtUp = scan.mock.calls.length
    for (let i = 0; i < 5; i++) await session.enqueue('next-turn', prompt(`live ${i}`))
    await settle()
    expect(scan.mock.calls.length).toBe(caughtUp)
    contiguous(seen, 1)
    expect(seen.at(-1)).toBe(session.lastSeq)
    expect(tail.deliveredThrough()).toBe(session.lastSeq)
    ac.abort()
    await h.close()
  })

  it('neither loses nor repeats rows committed while the history is being read', async () => {
    const h = await openTestHost()
    const session = await h.host.createSession({ cwd: h.dataDir })
    for (let i = 0; i < 40; i++) await session.enqueue('next-turn', prompt(`old ${i}`))
    const seen: number[] = []
    const ac = new AbortController()
    tailSession(session, {
      fromSeq: 1,
      onEvents: (evs) => seen.push(...evs.map((e) => e.seq)),
      pollMs: 5,
      signal: ac.signal,
    })
    await Promise.all(Array.from({ length: 20 }, (_, i) => session.enqueue('next-turn', prompt(`new ${i}`))))
    await vi.waitFor(() => expect(seen.at(-1)).toBe(session.lastSeq))
    contiguous(seen, 1)
    ac.abort()
    await h.close()
  })

  it('fills a gap left by a batch whose commit notice never went out', async () => {
    const h = await openTestHost()
    const session = await h.host.createSession({ cwd: h.dataDir })
    const seen: number[] = []
    const ac = new AbortController()
    tailSession(session, {
      fromSeq: 1,
      onEvents: (evs) => seen.push(...evs.map((e) => e.seq)),
      pollMs: 5,
      signal: ac.signal,
    })
    await vi.waitFor(() => expect(seen.at(-1)).toBe(session.lastSeq))
    // The host callback runs before commit observers; one that throws once skips them for that batch.
    const o = (session.d.log as unknown as { o: { onAppended: ((...args: unknown[]) => void) | undefined } })
      .o
    const original = o.onAppended
    o.onAppended = (...args) => {
      o.onAppended = original
      original?.(...args)
      throw new Error('host callback failed')
    }
    await expect(session.enqueue('next-turn', prompt('unannounced'))).rejects.toThrow('host callback failed')
    const missed = session.lastSeq
    expect(seen.at(-1)).toBeLessThan(missed)
    await session.enqueue('next-turn', prompt('announced'))
    await vi.waitFor(() => expect(seen.at(-1)).toBe(session.lastSeq))
    contiguous(seen, 1)
    ac.abort()
    await h.close()
  })

  it('pushes the same envelopes a scan of the ledger returns', async () => {
    const h = await openTestHost()
    const session = await h.host.createSession({ cwd: h.dataDir })
    const from = session.lastSeq + 1
    const pushed: EventEnvelope[] = []
    const ac = new AbortController()
    tailSession(session, {
      fromSeq: from,
      onEvents: (evs) => pushed.push(...evs),
      pollMs: 5,
      signal: ac.signal,
    })
    await session.enqueue('next-turn', prompt('hello'))
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    await vi.waitFor(() => expect(pushed.at(-1)?.seq).toBe(session.lastSeq))
    const scanned = await session.scan({ fromSeq: from, toSeq: session.lastSeq })
    expect(pushed.length).toBeGreaterThan(3)
    expect(JSON.parse(JSON.stringify(pushed))).toEqual(JSON.parse(JSON.stringify(scanned)))
    ac.abort()
    await h.close()
  })

  it('reports a fault once through onError and delivers nothing after it', async () => {
    let fire: ((evs: unknown[]) => void) | undefined
    let fault: ((e: unknown) => void) | undefined
    let unsubscribed = 0
    const stub = {
      lastSeq: 0,
      scan: async () => [],
      onAppended: (fn: (evs: unknown[]) => void) => {
        fire = fn
        return () => void unsubscribed++
      },
      onFault: (fn: (e: unknown) => void) => {
        fault = fn
        return () => void unsubscribed++
      },
    }
    const seen: number[] = []
    const errors: unknown[] = []
    const ac = new AbortController()
    tailSession(stub as never, {
      fromSeq: 1,
      onEvents: (evs) => seen.push(...evs.map((e) => e.seq)),
      pollMs: 5,
      signal: ac.signal,
      onError: (e) => errors.push(e),
    })
    await settle()
    const row = {
      seq: 1,
      ts: 't',
      id: 'i',
      type: 'user/message',
      data: {},
      actor,
      origin: 'principal',
      trust: 'trusted',
      lane: 'main',
    }
    fire?.([row])
    fault?.(new Error('lease lost'))
    fault?.(new Error('again'))
    fire?.([{ ...row, seq: 2 }])
    await settle()
    expect(seen).toEqual([1])
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('lease lost')
    expect(unsubscribed).toBe(2)
    ac.abort()
  })

  it('reports a subscription that cannot be made', async () => {
    const stub = {
      lastSeq: 0,
      scan: async () => [],
      onAppended: () => {
        throw new Error('E_CLOSED: session closed')
      },
    }
    const errors: unknown[] = []
    const ac = new AbortController()
    tailSession(stub as never, {
      fromSeq: 1,
      onEvents: () => undefined,
      pollMs: 5,
      signal: ac.signal,
      onError: (e) => errors.push(e),
    })
    await settle()
    expect(errors).toHaveLength(1)
    ac.abort()
  })
})
