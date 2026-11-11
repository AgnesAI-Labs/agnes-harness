import type { Event, Seq } from '@agnes/core-common/types'
import type { SurfaceNode } from '@agnes/core-ledger/project/surface'
import type { SessionImpl } from '../../step/session.js'

/** The route and model a request went to, as its `request/sent` receipt recorded them. */
export type MessageProducer = { route: string; model: string }

// What produced a written message never changes, so each one is looked up once per open session.
const looked = new WeakMap<SessionImpl, Map<Seq, MessageProducer | null>>()

/**
 * The model that produced each assistant message on `surface` whose reasoning carries a signature,
 * by the message's seq. `deriveRequest` sends a signature back only to that same route and model:
 * the history is labelled with the request's own model on the way out, so after a model switch the
 * wire library would otherwise write one model's signed reasoning into another model's request.
 *
 * Read from rows the ledger already has rather than stored with the message. A message's
 * `requestSeq` names its request's header, or a row after it (the default turn records the last
 * row before the message); that request's `request/sent` receipt is the newest one in the message's
 * lane before the message, and it names the header it answered. A message with no `requestSeq`, or
 * whose newest receipt answered a later header, has no producer here and keeps no signature.
 */
export async function surfaceProducers(
  s: SessionImpl,
  surface: readonly SurfaceNode[],
): Promise<ReadonlyMap<Seq, MessageProducer>> {
  let memo = looked.get(s)
  if (!memo) {
    memo = new Map()
    looked.set(s, memo)
  }
  const out = new Map<Seq, MessageProducer>()
  for (const node of surface) {
    if (node.kind !== 'assistant' || node.seq < 1 || !signed(node.event)) continue
    let producer = memo.get(node.seq)
    if (producer === undefined) {
      producer = await producerOf(s, node.event)
      memo.set(node.seq, producer)
    }
    if (producer) out.set(node.seq, producer)
  }
  return out
}

/** Whether a trusted message holds a thinking block with a signature; only those need a producer. */
function signed(event: Event): boolean {
  if (event.trust === 'untrusted') return false
  const content = (event.data as { content?: unknown } | null)?.content
  return (
    Array.isArray(content) &&
    content.some(
      (b: { type?: unknown; signature?: unknown }) =>
        b?.type === 'thinking' && typeof b.signature === 'string' && b.signature !== '',
    )
  )
}

async function producerOf(s: SessionImpl, message: Event): Promise<MessageProducer | null> {
  const requestSeq = (message.data as { requestSeq?: unknown }).requestSeq
  if (typeof requestSeq !== 'number') return null
  const [sent] = await s.d.log.scan({
    type: 'request/sent',
    lane: message.lane ?? 'main',
    toSeq: message.seq - 1,
    order: 'desc',
    limit: 1,
  })
  const header = sent?.sourceEventSeqs?.[0]
  const model = (sent?.data as { model?: { route?: unknown; id?: unknown } } | undefined)?.model
  if (header === undefined || header > requestSeq) return null
  if (typeof model?.route !== 'string' || typeof model.id !== 'string') return null
  return { route: model.route, model: model.id }
}
