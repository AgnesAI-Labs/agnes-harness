import type { Event } from '@agnes/core-common/types'
import type { ScanQuery } from '@agnes/core-ledger/log/storage'
import type { SurfaceNode } from '@agnes/core-ledger/project/surface'
import { describe, expect, it } from 'vitest'
import { surfaceProducers } from '../src/execution/turn/message-producers.js'
import type { SessionImpl } from '../src/step/session.js'

const row = (seq: number, type: string, data: unknown, extra: Partial<Event> = {}): Event =>
  ({ seq, type, data, origin: 'core', trust: 'trusted', ts: '', id: `e${seq}`, ...extra }) as Event

const sent = (seq: number, header: number, route: string, id: string, lane?: string) =>
  row(
    seq,
    'request/sent',
    { model: { route, id } },
    { sourceEventSeqs: [header, header + 1], ...(lane ? { lane } : {}) },
  )

const signed = [{ type: 'thinking', text: 'why', signature: 'reasoning_content' }]

const message = (seq: number, data: Record<string, unknown>, extra: Partial<Event> = {}): SurfaceNode => ({
  seq,
  kind: 'assistant',
  pinned: false,
  event: row(seq, 'assistant/message', { content: signed, stopReason: 'end_turn', ...data }, extra),
})

/** A session whose ledger is `rows`, counting the scans it is asked for. */
function session(rows: Event[]) {
  const scans: ScanQuery[] = []
  const scan = async (q: ScanQuery) => {
    scans.push(q)
    const hits = rows.filter(
      (e) =>
        (q.type === undefined || e.type === q.type) &&
        (q.lane === undefined || (e.lane ?? 'main') === q.lane) &&
        (q.toSeq === undefined || e.seq <= q.toSeq),
    )
    const ordered = q.order === 'desc' ? hits.toReversed() : hits
    return q.limit === undefined ? ordered : ordered.slice(0, q.limit)
  }
  return { s: { d: { log: { scan } } } as unknown as SessionImpl, scans }
}

describe('surfaceProducers', () => {
  it('reads the producer off the receipt of the request a message answers', async () => {
    // The default turn records the last row before the message (here the output row at 11); a loop
    // records the header itself (20), and its receipt (22) comes after it.
    const { s } = session([sent(10, 8, 'default', 'model-a'), sent(22, 20, 'alt', 'model-b')])
    const producers = await surfaceProducers(s, [
      message(12, { requestSeq: 11 }),
      message(23, { requestSeq: 20 }),
    ])
    expect([...producers]).toEqual([
      [12, { route: 'default', model: 'model-a' }],
      [23, { route: 'alt', model: 'model-b' }],
    ])
  })

  it('has no producer for a message that names no request, or whose newest receipt answered a later one', async () => {
    const { s } = session([sent(10, 8, 'default', 'model-a'), sent(30, 28, 'default', 'model-a')])
    const producers = await surfaceProducers(s, [message(12, {}), message(31, { requestSeq: 20 })])
    expect(producers.size).toBe(0)
  })

  it('reads the receipt from the message’s own lane', async () => {
    const { s } = session([sent(10, 8, 'default', 'model-a', 'child'), sent(11, 9, 'alt', 'model-b')])
    const producers = await surfaceProducers(s, [message(12, { requestSeq: 11 }, { lane: 'child' })])
    expect(producers.get(12)).toEqual({ route: 'default', model: 'model-a' })
  })

  it('asks the ledger only for trusted signed messages, and once per message', async () => {
    const { s, scans } = session([sent(10, 8, 'default', 'model-a')])
    const unsigned: SurfaceNode = {
      ...message(14, { requestSeq: 11 }),
      event: row(14, 'assistant/message', { content: [{ type: 'thinking', text: 'why' }], requestSeq: 11 }),
    }
    const surface = [
      message(12, { requestSeq: 11 }),
      message(13, { requestSeq: 11 }, { trust: 'untrusted' }),
      unsigned,
    ]
    await surfaceProducers(s, surface)
    await surfaceProducers(s, surface)
    expect(scans).toHaveLength(1)
  })
})
