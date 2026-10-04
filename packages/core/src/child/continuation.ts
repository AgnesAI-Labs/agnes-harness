import type { Actor, RuntimeIdentity } from '@agnes/protocol'
import { scanAll } from '../log/scan-pages.js'
import type { Inbox } from '../reduce/shapes.js'
import { sha256Hex } from '../request/hash.js'
import { inboxEvent } from '../step/inbox.js'
import type { SessionImpl } from '../step/session.js'
import { CoreError, type Seq } from '../types.js'
import type { ChildTaskRecord } from './types.js'

export const CHILD_DESCRIPTOR = 'x/core/child-descriptor'
const CHILD_DELIVERY = 'x/core/child-delivery'

/** Inbox command IDs are bounded by the wire contract; full identity stays in the receipt. */
export function childInboxCommandId(senderKey: string, receiverKey: string, deliveryId: string): string {
  return `child-message:${sha256Hex(JSON.stringify([senderKey, receiverKey, deliveryId]))}`
}

export async function readChildDelivery(
  parent: SessionImpl,
  record: ChildTaskRecord,
  input: string,
  options: { deliveryId: string; parentEffectId: string },
): Promise<{ childKey: string; messageId: string; acceptedSeq: Seq } | undefined> {
  const storage = parent.d.log.storage
  const tail = await storage.scan(record.childKey, { order: 'desc', limit: 1 })
  const rows = await scanAll((query) => storage.scan(record.childKey, query), {
    type: CHILD_DELIVERY,
    fromSeq: record.boundarySeq + 1,
    toSeq: tail[0]?.seq ?? 0,
  })
  const matching = rows.filter(
    (row) => (row.data as { deliveryId?: string }).deliveryId === options.deliveryId,
  )
  if (!matching.length) return undefined
  const row = matching[0]
  const data = row?.data as {
    version: number
    messageId: string
    inputHash: string
    parentKey: string
    parentEffectId: string
  }
  if (
    !row ||
    matching.length !== 1 ||
    row.origin !== 'system' ||
    row.trust !== 'trusted' ||
    row.lane !== parent.lane ||
    data.version !== 1 ||
    !data.messageId ||
    data.parentKey !== parent.key ||
    data.parentEffectId !== options.parentEffectId ||
    data.inputHash !== sha256Hex(input)
  )
    throw new CoreError('E_CHILD_CONFLICT', 'child delivery identity conflicts')
  return { childKey: record.childKey, messageId: data.messageId, acceptedSeq: row.seq }
}

export type ChildDescriptor = Readonly<{
  version: 1
  mode: 'one-shot' | 'continuable'
  childKey: string
  parentKey: string
  runtime: RuntimeIdentity
  model: { route: string; model: string }
  preset: string
  actor: { id: string; org: string; role: string }
}>

export async function readChildDescriptor(
  parent: SessionImpl,
  record: ChildTaskRecord,
): Promise<ChildDescriptor> {
  const rows = await parent.d.log.storage.scan(record.childKey, {
    fromSeq: record.boundarySeq + 1,
    type: CHILD_DESCRIPTOR,
    order: 'asc',
    limit: 2,
  })
  const row = rows[0]
  const data = row?.data as ChildDescriptor | undefined
  if (
    rows.length !== 1 ||
    row?.origin !== 'system' ||
    row.trust !== 'trusted' ||
    row.lane !== parent.lane ||
    data?.version !== 1 ||
    data.mode !== 'continuable' ||
    data.childKey !== record.childKey ||
    data.parentKey !== parent.key ||
    data.runtime?.id !== record.runtime?.id ||
    data.runtime?.version !== record.runtime?.version ||
    data.runtime.id !== parent.runtimeIdentity.id ||
    data.runtime.version !== parent.runtimeIdentity.version ||
    data.model?.route !== record.model?.route ||
    data.model?.model !== record.model?.model ||
    data.preset !== parent.preset.name ||
    data.actor?.id !== parent.d.actor.id ||
    data.actor.org !== parent.d.actor.org ||
    data.actor.role !== parent.d.actor.role
  )
    throw new CoreError('E_UNSUPPORTED', 'child has no supported continuation descriptor')
  return data
}

/** Inbox and its acceptance receipt commit together; retries cannot rerun the original input. */
export async function deliverChildMessage(
  child: SessionImpl,
  parent: SessionImpl,
  input: string,
  options: { deliveryId: string; parentEffectId: string; signal: AbortSignal },
  admitting: () => boolean = () => true,
): Promise<{ childKey: string; messageId: string; acceptedSeq: Seq }> {
  return child.locked(async () => {
    await child.d.log.storage.assertSessionAdmitted?.(parent.key)
    await child.d.log.storage.assertSessionAdmitted?.(child.key)
    options.signal.throwIfAborted()
    if (!admitting() || child.closingOrClosed || parent.closingOrClosed)
      throw new CoreError('E_CLOSED', 'child delivery owner is closing')
    const inputHash = sha256Hex(input)
    const receipts = await scanAll((query) => child.scan(query), {
      type: CHILD_DELIVERY,
      fromSeq: (child.d.log.parent?.boundarySeq ?? 0) + 1,
      toSeq: child.lastSeq,
    })
    const prior = receipts.find(
      (row) => (row.data as { deliveryId?: string }).deliveryId === options.deliveryId,
    )
    if (prior) {
      const data = prior.data as { inputHash: string; parentKey: string; messageId: string }
      if (data.inputHash !== inputHash || data.parentKey !== parent.key)
        throw new CoreError('E_CHILD_CONFLICT', 'child delivery identity conflicts')
      return { childKey: child.key, messageId: data.messageId, acceptedSeq: prior.seq }
    }
    const open = child.state.openTurn.has(child.lane) && !child.ac.signal.aborted
    const current = (child.latest('inbox') as Inbox | undefined) ?? { items: [] }
    const messageId = child.d.ids.requestId()
    const actor: Actor = parent.d.actor
    const receipt = await child.d.log.append([
      inboxEvent(child.lane, child.d.actor, {
        items: [
          ...current.items,
          {
            itemId: messageId,
            target: open ? 'next-step' : 'next-turn',
            content: [{ type: 'text', text: input }],
            actor,
            enqueuedAt: new Date(child.d.clock()).toISOString(),
            commandId: childInboxCommandId(parent.key, child.key, options.deliveryId),
            kind: open ? 'steer' : 'prompt',
            trust: 'untrusted',
          },
        ],
      }),
      child.ev(
        CHILD_DELIVERY,
        {
          version: 1,
          deliveryId: options.deliveryId,
          messageId,
          inputHash,
          parentKey: parent.key,
          parentEffectId: options.parentEffectId,
        },
        { ignorable: true },
      ),
    ])
    return { childKey: child.key, messageId, acceptedSeq: receipt.seqs[1] as Seq }
  })
}

/** An interrupted turn can leave unconsumed steering. Keep the delivery identity while
 * admitting that same item on the next turn; already consumed items are absent from this register. */
export async function retargetInterruptedInbox(child: SessionImpl): Promise<void> {
  await child.locked(async () => {
    if (child.closingOrClosed || child.state.openTurn.has(child.lane)) return
    const inbox = child.latest('inbox') as Inbox | undefined
    if (!inbox?.items.some((item) => item.target === 'next-step')) return
    await child.d.log.append([
      inboxEvent(child.lane, child.d.actor, {
        ...inbox,
        items: inbox.items.map((item) =>
          item.target === 'next-step' ? { ...item, target: 'next-turn' as const } : item,
        ),
      }),
    ])
  })
}
