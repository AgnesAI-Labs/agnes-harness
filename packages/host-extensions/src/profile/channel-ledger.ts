import type { PersistenceMetadataNamespace } from '@agnes/extension-api'
import type { CardBlock, TextBlock } from '@agnes/extension-api/channel-contract'
import type { OwnerPairing } from './channel-targets.js'

export const LEDGER_TTL_MS = 7 * 86_400_000

export type DeliveryRow = {
  accountId?: string
  chatType?: 'dm' | 'group'
  state: 'sending' | 'delivered' | 'unknown'
  incarnation: string
  messageId?: string
  /** The id a click on this message reports, when the channel's differs from `messageId`. */
  cardBizId?: string
  /** Who sent it: a click counts only on a message the clicked chat's current service sent. */
  pairingId?: string
  service?: string
  /** The buttons the message offers now: a click's receipt takes its text from the label. Absent on rows written before buttons were recorded. */
  actions?: { id: string; label: string }[]
  at: string
}

/**
 * The buttons `block` offers, as the ledger records them: none is an empty list. A row without `actions`
 * was written before buttons were recorded.
 */
export const buttonsOf = (block: TextBlock | CardBlock): Required<Pick<DeliveryRow, 'actions'>> => ({
  actions: block.kind === 'card' ? (block.actions ?? []).map(({ id, label }) => ({ id, label })) : [],
})

/** The live ledger row `clicked` names, with its key, when this pairing's service sent it. */
export function sentReference(
  store: PersistenceMetadataNamespace,
  now: number,
  pairing: OwnerPairing,
  clicked: string,
): (DeliveryRow & { key: string }) | undefined {
  const prefix = `d:${pairing.target.owner}:`
  const before = now - LEDGER_TTL_MS
  for (const { key, value } of store.entries()) {
    const row = value as DeliveryRow
    if (
      key.startsWith(prefix) &&
      row.state === 'delivered' &&
      row.pairingId === pairing.id &&
      row.service === pairing.target.service &&
      Date.parse(row.at) > before &&
      (row.messageId === clicked || row.cardBizId === clicked)
    )
      return { ...row, key }
  }
  return undefined
}

/** An update replaced the message: from now on a click counts only on the buttons it offers. */
export function recordButtons(
  store: PersistenceMetadataNamespace,
  sent: DeliveryRow & { key: string },
  block: TextBlock | CardBlock,
): void {
  const { key, actions: _, ...row } = sent
  store.set(key, { ...row, ...buttonsOf(block) })
}

export function pruneLedger(store: PersistenceMetadataNamespace, now: number): void {
  const before = now - LEDGER_TTL_MS
  store.transaction(() => {
    for (const { key, value } of store.entries())
      if (key.startsWith('d:') && !(Date.parse((value as DeliveryRow).at) > before)) store.delete(key)
  })
}
