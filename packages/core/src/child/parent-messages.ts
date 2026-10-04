import { scanAll } from '../log/scan-pages.js'
import type { Inbox } from '../reduce/shapes.js'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import { assertConfigurationParentReceipt } from '../step/configuration-admission.js'
import { inboxEvent } from '../step/inbox.js'
import type { SessionImpl } from '../step/session.js'
import { CoreError, type Seq } from '../types.js'
import { childInboxCommandId, retargetInterruptedInbox } from './continuation.js'
import { requireChildControl } from './store.js'

const OUTBOX = 'x/core/child-outbox'
const RECEIVED = 'x/core/child-received'
const ACK = 'x/core/child-delivered'
type ParentMessage = Readonly<{
  version: 1
  deliveryId: string
  senderKey: string
  parentKey: string
  kind: 'agent-message' | 'subagent-settled'
  text: string
  textHash: string
  outcome?: 'completed' | 'failed' | 'cancelled'
}>
export type ParentMessageReceipt = { childKey: string; messageId: string; acceptedSeq: Seq }

async function verifyParentSource(
  parent: SessionImpl,
  message: { seq: Seq; data: ParentMessage },
): Promise<void> {
  const record = await requireChildControl(parent.d.log.storage).lookupByKey(message.data.senderKey)
  const physical = (
    await parent.d.log.storage.scanIntegrity(message.data.senderKey, {
      fromSeq: message.seq,
      toSeq: message.seq,
      limit: 1,
    })
  )[0]
  const source = physical?.event
  if (
    record?.parentKey !== parent.key ||
    physical?.sessionKey !== message.data.senderKey ||
    source?.type !== OUTBOX ||
    source.origin !== 'system' ||
    source.trust !== 'trusted' ||
    source.ignorable !== true ||
    canonicalJson(source.data) !== canonicalJson(message.data) ||
    message.data.version !== 1 ||
    message.data.parentKey !== parent.key ||
    message.data.textHash !== sha256Hex(message.data.text)
  )
    throw new CoreError('E_CHILD_CONFLICT', 'Canonical direct-parent source differs')
}

/** Release may retain only already receipted canonical child input, never caller assertions. */
export async function onlyCanonicalParentInbox(parent: SessionImpl): Promise<boolean> {
  const items = ((parent.latest('inbox') as Inbox | undefined) ?? { items: [] }).items
  if (!items.length) return true
  const rows = await scanAll((query) => parent.scan(query), {
    type: RECEIVED,
    fromSeq: (parent.d.log.parent?.boundarySeq ?? 0) + 1,
    toSeq: parent.lastSeq,
  })
  for (const item of items) {
    const matching = rows.filter((row) => (row.data as { messageId?: string }).messageId === item.itemId)
    const row = matching[0]
    const receipt = row?.data as
      | {
          version: number
          senderKey: string
          parentKey: string
          sourceSeq: Seq
          deliveryId: string
          textHash: string
          kind: ParentMessage['kind']
          outcome?: ParentMessage['outcome']
        }
      | undefined
    if (
      matching.length !== 1 ||
      row?.origin !== 'system' ||
      row.trust !== 'trusted' ||
      row.lane !== parent.lane ||
      receipt?.version !== 1 ||
      receipt.parentKey !== parent.key ||
      item.commandId !== childInboxCommandId(receipt.senderKey, parent.key, receipt.deliveryId) ||
      item.trust !== 'untrusted'
    )
      return false
    const source = (
      await parent.d.log.storage.scan(receipt.senderKey, {
        fromSeq: receipt.sourceSeq,
        toSeq: receipt.sourceSeq,
        limit: 1,
      })
    )[0]
    const data = source?.data as ParentMessage | undefined
    if (
      !data ||
      canonicalJson(item.content) !== canonicalJson([{ type: 'text', text: data.text }]) ||
      data.deliveryId !== receipt.deliveryId ||
      data.textHash !== receipt.textHash ||
      data.kind !== receipt.kind ||
      data.outcome !== receipt.outcome
    )
      return false
    try {
      await verifyParentSource(parent, { seq: receipt.sourceSeq, data })
    } catch {
      return false
    }
  }
  return true
}

/** The sender owns an outbox even when the exact parent's writer cannot accept a notice. */
export async function persistParentMessage(
  sender: SessionImpl,
  parentKey: string,
  input: Omit<ParentMessage, 'version' | 'senderKey' | 'parentKey' | 'textHash'>,
): Promise<{ seq: Seq; data: ParentMessage }> {
  return sender.locked(async () => {
    const rows = await scanAll((query) => sender.scan(query), {
      type: OUTBOX,
      fromSeq: (sender.d.log.parent?.boundarySeq ?? 0) + 1,
      toSeq: sender.lastSeq,
    })
    const matching = rows.filter((row) => (row.data as ParentMessage).deliveryId === input.deliveryId)
    const prior = matching[0]
    const data: ParentMessage = {
      version: 1,
      senderKey: sender.key,
      parentKey,
      textHash: sha256Hex(input.text),
      ...input,
    }
    if (prior) {
      const found = prior.data as ParentMessage
      if (
        matching.length !== 1 ||
        prior.origin !== 'system' ||
        prior.trust !== 'trusted' ||
        prior.lane !== sender.lane ||
        found.version !== 1 ||
        found.senderKey !== sender.key ||
        found.parentKey !== parentKey ||
        found.textHash !== data.textHash ||
        found.kind !== data.kind ||
        found.outcome !== data.outcome
      )
        throw new CoreError('E_CHILD_CONFLICT', 'parent message identity conflicts')
      return { seq: prior.seq, data: found }
    }
    const receipt = await sender.d.log.append([sender.ev(OUTBOX, data, { ignorable: true })])
    return { seq: receipt.seqs[0] as Seq, data }
  })
}

/** Receipt and inbox commit together. Sender content remains untrusted model input. */
export async function receiveParentMessage(
  parent: SessionImpl,
  message: { seq: Seq; data: ParentMessage },
): Promise<ParentMessageReceipt> {
  return parent.locked(async () => {
    assertConfigurationParentReceipt(parent)
    await parent.d.log.storage.assertSessionAdmitted?.(parent.key)
    if (parent.closingOrClosed) throw new CoreError('E_CLOSED', 'parent is closing')
    if (
      message.data.parentKey !== parent.key ||
      !Number.isSafeInteger(message.seq) ||
      message.seq < 1 ||
      message.data.textHash !== sha256Hex(message.data.text)
    )
      throw new CoreError('E_CHILD_CONFLICT', 'parent message source identity conflicts')
    await verifyParentSource(parent, message)
    const rows = await scanAll((query) => parent.scan(query), {
      type: RECEIVED,
      fromSeq: (parent.d.log.parent?.boundarySeq ?? 0) + 1,
      toSeq: parent.lastSeq,
    })
    const matching = rows.filter(
      (row) =>
        (row.data as { deliveryId: string; senderKey: string }).deliveryId === message.data.deliveryId &&
        (row.data as { senderKey: string }).senderKey === message.data.senderKey,
    )
    const prior = matching[0]
    if (prior) {
      const data = prior.data as {
        version: number
        sourceSeq: number
        textHash: string
        messageId: string
        parentKey: string
      }
      if (
        matching.length !== 1 ||
        prior.origin !== 'system' ||
        prior.trust !== 'trusted' ||
        prior.lane !== parent.lane ||
        data.version !== 1 ||
        data.sourceSeq !== message.seq ||
        data.textHash !== message.data.textHash ||
        data.parentKey !== parent.key
      )
        throw new CoreError('E_CHILD_CONFLICT', 'parent receipt identity conflicts')
      return { childKey: parent.key, messageId: data.messageId, acceptedSeq: prior.seq }
    }
    const current = (parent.latest('inbox') as Inbox | undefined) ?? { items: [] }
    const open = parent.state.openTurn.has(parent.lane) && !parent.ac.signal.aborted
    const messageId = parent.d.ids.requestId()
    const content = [{ type: 'text' as const, text: message.data.text }]
    const receipt = await parent.d.log.append([
      inboxEvent(parent.lane, parent.d.actor, {
        items: [
          ...current.items,
          {
            itemId: messageId,
            target: open ? 'next-step' : 'next-turn',
            content,
            actor: parent.d.actor,
            enqueuedAt: new Date(parent.d.clock()).toISOString(),
            commandId: childInboxCommandId(message.data.senderKey, parent.key, message.data.deliveryId),
            kind: open ? 'steer' : 'follow_up',
            trust: 'untrusted',
          },
        ],
      }),
      parent.ev(
        RECEIVED,
        {
          version: 1,
          deliveryId: message.data.deliveryId,
          senderKey: message.data.senderKey,
          sourceSeq: message.seq,
          parentKey: parent.key,
          messageId,
          textHash: message.data.textHash,
          kind: message.data.kind,
          ...(message.data.outcome ? { outcome: message.data.outcome } : {}),
        },
        { ignorable: true },
      ),
    ])
    return { childKey: parent.key, messageId, acceptedSeq: receipt.seqs[1] as Seq }
  })
}

export async function acknowledgeParentMessage(
  sender: SessionImpl,
  message: { seq: Seq; data: ParentMessage },
  receipt: ParentMessageReceipt,
): Promise<void> {
  await sender.locked(async () => {
    const rows = await scanAll((query) => sender.scan(query), {
      type: ACK,
      fromSeq: (sender.d.log.parent?.boundarySeq ?? 0) + 1,
      toSeq: sender.lastSeq,
    })
    const matching = rows.filter((row) => (row.data as { sourceSeq: number }).sourceSeq === message.seq)
    const prior = matching[0]
    if (prior) {
      const data = prior.data as {
        version: number
        deliveryId: string
        parentKey: string
        parentReceiptSeq: number
        messageId: string
      }
      if (
        matching.length !== 1 ||
        prior.origin !== 'system' ||
        prior.trust !== 'trusted' ||
        prior.lane !== sender.lane ||
        data.version !== 1 ||
        data.deliveryId !== message.data.deliveryId ||
        data.parentKey !== receipt.childKey ||
        data.parentReceiptSeq !== receipt.acceptedSeq ||
        data.messageId !== receipt.messageId
      )
        throw new CoreError('E_CHILD_CONFLICT', 'parent delivery acknowledgement conflicts')
      return
    }
    await sender.d.log.append([
      sender.ev(
        ACK,
        {
          version: 1,
          sourceSeq: message.seq,
          deliveryId: message.data.deliveryId,
          parentKey: receipt.childKey,
          parentReceiptSeq: receipt.acceptedSeq,
          messageId: receipt.messageId,
        },
        { ignorable: true },
      ),
    ])
  })
}

const wakes = new WeakMap<SessionImpl, { again: boolean; running: boolean; off: (() => void) | undefined }>()
/** Coalesce notification wakes without overlapping an ordinary run or forcing UNKNOWN recovery. */
export function requestParentWake(parent: SessionImpl, wake: () => Promise<void>): void {
  let state = wakes.get(parent)
  if (state) {
    state.again = true
    return
  }
  state = { again: true, running: false, off: undefined }
  wakes.set(parent, state)
  const owned = state
  const attempt = async () => {
    if (owned.running) return
    if (
      parent.closingOrClosed ||
      parent.ac.signal.aborted ||
      parent.runtimeState().phase === 'parked' ||
      (!parent.executionActive && parent.pendingEffects().length)
    ) {
      owned.off?.()
      wakes.delete(parent)
      return
    }
    if (parent.executionActive || parent.configurationReserved || parent.idleGateReserved) {
      owned.off ??= parent.onExecutionIdle(() => {
        owned.off?.()
        owned.off = undefined
        void attempt()
      })
      return
    }
    owned.running = true
    owned.again = false
    try {
      // The final response may have committed after a next-step item was accepted.
      // Only still-unconsumed items are retargeted, preserving their delivery identity.
      await retargetInterruptedInbox(parent)
      if ((parent.latest('inbox') as Inbox | undefined)?.items.length) await wake()
    } catch (error) {
      if (error instanceof CoreError && error.code === 'E_LANE_BUSY') owned.again = true
    } finally {
      owned.running = false
      if (owned.again) void attempt()
      else {
        owned.off?.()
        wakes.delete(parent)
      }
    }
  }
  void attempt()
}
