import type { EventInput } from '@agnes/core-common/types'
import { deliverer, inputDeliveredByEvent } from '@agnes/core-ledger/log/delivery-marker'
import type { InboxItem } from '@agnes/core-ledger/reduce/shapes'
import type { InputDeliverer } from '@agnes/protocol'
import { inputMessageEvents } from './inbox.js'
import type { SessionImpl } from './session.js'

/**
 * The marker of a queued item: the newest inbox-delivered-by row Core wrote for it (an edit's clears it), else one an
 * earlier release left inline on the item. Undefined when it is unmarked. Read from the session log's index, never by
 * a scan, so a claim costs the same however many marked deliveries the session has had.
 */
export async function inboxDeliveredBy(s: SessionImpl, item: InboxItem): Promise<InputDeliverer | undefined> {
  const marker = await s.d.log.deliveryMarkers.get(item.itemId)
  return marker === undefined ? deliverer(item.deliveredBy) : (marker ?? undefined)
}

/**
 * The rows a claimed item becomes: its messages, and, when an app delivered it, the row that names them as its delivery
 * for the reader. Nothing else about the messages changes.
 */
export async function claimedInputEvents(
  s: SessionImpl,
  item: InboxItem,
  lane: string,
): Promise<EventInput[]> {
  const deliveredBy = await inboxDeliveredBy(s, item)
  const messages = inputMessageEvents(item, lane)
  if (!deliveredBy) return messages
  const named = messages.map((message) => ({ ...message, id: s.d.ids.ulid() }))
  return [
    ...named,
    inputDeliveredByEvent(
      s.d.actor,
      lane,
      named.map((message) => message.id),
      deliveredBy,
    ),
  ]
}
