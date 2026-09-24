import { CoreError, type Event, type Seq } from '../types.js'

export type RlafRange = { fromSeq?: Seq; toSeq?: Seq }
export type RlafDump = { formatVersion: 1; events: Event[]; headers: Event[]; signals: Event[] }

/** Raw training export; redaction belongs to the authorised base export boundary. */
export function exportRlaf(events: Iterable<Event>, range: RlafRange = {}): RlafDump {
  for (const seq of [range.fromSeq, range.toSeq]) {
    if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0))
      throw new CoreError('E_ENVELOPE', 'export range must contain nonnegative safe sequence numbers')
  }
  if (range.fromSeq !== undefined && range.toSeq !== undefined && range.fromSeq > range.toSeq)
    throw new CoreError('E_ENVELOPE', 'export range is reversed')
  const selected = [...events].filter(
    (event) =>
      (range.fromSeq === undefined || event.seq >= range.fromSeq) &&
      (range.toSeq === undefined || event.seq <= range.toSeq),
  )
  return {
    formatVersion: 1,
    events: selected,
    headers: selected.filter((event) => event.type === 'request/header'),
    signals: selected.filter(
      (event) =>
        event.type === 'cost/ledger' ||
        event.type === 'verifier/signal' ||
        event.type === 'format/deviation' ||
        event.type.startsWith('feedback/'),
    ),
  }
}
