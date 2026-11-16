import type { Event, EventInput, Seq } from '@agnes/core-common/types'
import type { Actor, InputDeliverer, UINode } from '@agnes/protocol'
import { scanPages } from './scan-pages.js'
import type { ScanQuery } from './storage.js'

/**
 * The display-only fact that an app delivered an input (`InputDeliverer`) is kept in ignorable `x/core/*` rows, never
 * inside the closed rows an earlier release validates (an inbox item, a user message): a ledger written now stays one
 * such a release can write to again.
 *
 * `{ itemId, deliveredBy? }`, written with the inbox row that queues the item. The newest row for an item decides; one
 * without `deliveredBy` (as an edit writes) leaves it unmarked.
 */
export const INBOX_DELIVERED_BY_EVENT = 'x/core/inbox-delivered-by'
/** `{ messageIds, deliveredBy }`, written with the user messages a marked item became: what the reader is shown. */
export const INPUT_DELIVERED_BY_EVENT = 'x/core/input-delivered-by'

/** A well-formed marker, or undefined. */
export function deliverer(value: unknown): InputDeliverer | undefined {
  const marker = value as { kind?: unknown; appId?: unknown } | null | undefined
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) || Object.keys(marker).length !== 2)
    return undefined
  return marker.kind === 'bundled-app' &&
    typeof marker.appId === 'string' &&
    marker.appId.length > 0 &&
    marker.appId.length <= 256
    ? { kind: 'bundled-app', appId: marker.appId }
    : undefined
}

/** Whether Core itself wrote the row: an imported one is relabeled and never is. */
const coreRow = (event: Pick<Event, 'origin' | 'trust'>) =>
  event.origin === 'system' && event.trust === 'trusted'

export function inboxDeliveredByEvent(
  actor: Actor,
  itemId: string,
  deliveredBy: InputDeliverer | undefined,
  lane?: string,
): EventInput {
  return {
    type: INBOX_DELIVERED_BY_EVENT,
    origin: 'system',
    trust: 'trusted',
    actor,
    ...(lane === undefined ? {} : { lane }),
    ignorable: true,
    data: { itemId, ...(deliveredBy ? { deliveredBy } : {}) },
  }
}

export function inputDeliveredByEvent(
  actor: Actor,
  lane: string,
  messageIds: string[],
  deliveredBy: InputDeliverer,
): EventInput {
  return {
    type: INPUT_DELIVERED_BY_EVENT,
    origin: 'system',
    trust: 'trusted',
    actor,
    lane,
    ignorable: true,
    data: { messageIds, deliveredBy },
  }
}

type MarkerRow = Pick<Event, 'type' | 'origin' | 'trust' | 'data'> & { seq: Seq }

/** The item an inbox-delivered-by row Core wrote is about, and the marker it gives it: `null` for one that clears it. */
export function inboxDeliveredByOf(
  event: MarkerRow,
): [itemId: string, marker: InputDeliverer | null] | undefined {
  if (event.type !== INBOX_DELIVERED_BY_EVENT || !coreRow(event)) return undefined
  const data = event.data as { itemId?: unknown; deliveredBy?: unknown } | null
  if (typeof data?.itemId !== 'string') return undefined
  return [data.itemId, deliverer(data.deliveredBy) ?? null]
}

/**
 * Each queued item's marker in one session, so a claim reads it without a scan: built once, by one pass over the
 * session's inbox-delivered-by rows the first time a marker is asked for, then kept up by every append. Rows appended
 * while it is built are applied after the pass, the newest row for an item winning either way.
 */
export class DeliveryMarkerIndex {
  private markers?: Map<string, InputDeliverer | null>
  private building?: Promise<Map<string, InputDeliverer | null>>
  private pending: MarkerRow[] = []

  constructor(private readonly scan: (q: ScanQuery) => Promise<Event[]>) {}

  /** The marker the newest row Core wrote for the item gives it; `null` when one cleared it, undefined when none. */
  async get(itemId: string): Promise<InputDeliverer | null | undefined> {
    if (this.markers) return this.markers.get(itemId)
    this.building ??= this.build()
    return (await this.building).get(itemId)
  }

  /** Takes the rows of a committed batch. */
  observe(rows: readonly MarkerRow[]): void {
    const marked = rows.filter((row) => row.type === INBOX_DELIVERED_BY_EVENT)
    if (!marked.length) return
    if (this.markers) for (const row of marked) apply(this.markers, row)
    else if (this.building) this.pending.push(...marked)
  }

  private async build(): Promise<Map<string, InputDeliverer | null>> {
    const markers = new Map<string, InputDeliverer | null>()
    let through = 0
    for await (const page of scanPages((q) => this.scan(q), { type: INBOX_DELIVERED_BY_EVENT, order: 'asc' }))
      for (const row of page) {
        apply(markers, row)
        through = row.seq
      }
    for (const row of this.pending) if (row.seq > through) apply(markers, row)
    this.pending = []
    this.markers = markers
    return markers
  }
}

function apply(markers: Map<string, InputDeliverer | null>, row: MarkerRow): void {
  const marked = inboxDeliveredByOf(row)
  if (marked) markers.set(marked[0], marked[1])
}

/** The user nodes an input-delivered-by row Core wrote marks, with the marker; undefined for any other row. */
export function inputDeliveredByOf(
  event: Event,
): { messageIds: string[]; deliveredBy: InputDeliverer } | undefined {
  if (event.type !== INPUT_DELIVERED_BY_EVENT || !coreRow(event)) return undefined
  const data = event.data as { messageIds?: unknown; deliveredBy?: unknown } | null
  const deliveredBy = deliverer(data?.deliveredBy)
  const messageIds = data?.messageIds
  if (!deliveredBy || !Array.isArray(messageIds) || !messageIds.every((id) => typeof id === 'string'))
    return undefined
  return { messageIds, deliveredBy }
}

/**
 * A marker an earlier release wrote inline on a user message, honoured only on a row the live daemon writes (a
 * person's or Core's own), never on an imported one, which carries its file's claims verbatim.
 */
export function inlineDeliveredBy(
  event: Pick<Event, 'origin'>,
  data: { deliveredBy?: unknown },
): { deliveredBy?: InputDeliverer } {
  const marker =
    event.origin === 'principal' || event.origin === 'system' ? deliverer(data.deliveredBy) : undefined
  return marker ? { deliveredBy: marker } : {}
}

/** Puts the marker of an input-delivered-by row on the user nodes it names; the ids of the nodes it changed. */
export function markDelivered(nodes: UINode[], indexes: Map<string, number>, event: Event): string[] {
  const marked = inputDeliveredByOf(event)
  if (!marked) return []
  return marked.messageIds.flatMap((id) => {
    const index = indexes.get(id)
    const node = index === undefined ? undefined : nodes[index]
    if (node?.kind !== 'user') return []
    nodes[index as number] = { ...node, deliveredBy: { ...marked.deliveredBy } }
    return [id]
  })
}

/**
 * A batch as the ledger writes it: no inbox item or user message carries a marker inline. An inbox item's (an earlier
 * release queued it so) moves to an inbox-delivered-by row at the end of the batch, so no other row's sequence moves;
 * a user message's is dropped. The batch is returned as it came when nothing carries one.
 */
export function withoutInlineMarkers(tx: EventInput[]): EventInput[] {
  if (!tx.some(carriesInlineMarker)) return tx
  const moved: EventInput[] = []
  const rows = tx.map((event) => {
    if (!carriesInlineMarker(event)) return event
    if (event.type === 'user/message') {
      const { deliveredBy: _inline, ...data } = event.data as Record<string, unknown>
      return { ...event, data } as EventInput
    }
    const items = (event.data as { items: Array<Record<string, unknown>> }).items.map((item) => {
      if (!('deliveredBy' in item)) return item
      const { deliveredBy, ...rest } = item
      const marker = deliverer(deliveredBy)
      if (marker && typeof rest.itemId === 'string')
        moved.push(inboxDeliveredByEvent(event.actor, rest.itemId, marker, event.lane))
      return rest
    })
    return { ...event, data: { ...(event.data as object), items } } as EventInput
  })
  return [...rows, ...moved]
}

function carriesInlineMarker(event: EventInput): boolean {
  const data = event.data as { deliveredBy?: unknown; items?: unknown } | null
  if (!data || typeof data !== 'object') return false
  if (event.type === 'user/message') return 'deliveredBy' in data
  return (
    event.type === 'inbox' &&
    Array.isArray(data.items) &&
    data.items.some((item) => !!item && typeof item === 'object' && 'deliveredBy' in item)
  )
}
