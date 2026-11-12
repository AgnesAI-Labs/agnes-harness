import { type ScanRead, scanPages } from '@agnes/host'
import { type EventEnvelope, jcs, type UiSurfaceRecord, validateAgainst } from '@agnes/protocol'
import { UiSurface } from '@agnes/protocol/gen/intelligent-ui'

const prefix = 'x/agnes/intelligent-ui/surface.'
const types = ['opened', 'updated', 'closed'].map((name) => prefix + name)

/** Read the same provenance-checked surface chain as intelligent-ui without loading a worker. */
export async function hasOpenNativeQuestion(read: ScanRead<EventEnvelope>): Promise<boolean> {
  const latest = await read({ order: 'desc', limit: 1 })
  if (latest.length === 0) return false
  const head = latest[0]?.seq
  if (typeof head !== 'number' || !Number.isSafeInteger(head) || head < 1)
    throw new Error('UI surface ledger head is corrupt')
  const surfaces = new Map<string, UiSurfaceRecord>()
  for await (const page of scanPages(read, { type: types, lane: 'main', toSeq: head, order: 'asc' }, 8)) {
    for (const event of page) {
      if (event.origin !== 'ext:agnes/intelligent-ui' || event.trust !== 'untrusted' || event.lane !== 'main' || !types.includes(event.type))
        continue
      const name = event.type.slice(prefix.length)
      const record = (event.data as unknown as { record?: UiSurfaceRecord } | null)?.record
      if (
        !record ||
        typeof record.owner !== 'string' ||
        !record.owner ||
        record.lane !== 'main' ||
        typeof record.taskId !== 'string' ||
        !record.taskId ||
        !validateAgainst(UiSurface, record.surface).ok
      )
        throw new Error('UI surface ledger chain is corrupt')
      const old = surfaces.get(record.surface.id)
      if (
        name === 'opened'
          ? !!old || record.surface.revision !== 1 || record.status !== 'open'
          : !old ||
            old.status !== 'open' ||
            record.owner !== old.owner ||
            record.lane !== old.lane ||
            record.taskId !== old.taskId ||
            (name === 'updated'
              ? record.surface.revision !== old.surface.revision + 1 || record.status !== 'open'
              : name !== 'closed' || record.status !== 'closed' || jcs(record.surface) !== jcs(old.surface))
      )
        throw new Error('UI surface ledger chain is corrupt')
      surfaces.set(record.surface.id, record)
    }
  }
  for (const record of surfaces.values()) {
    const question = record.surface.data.question
    if (
      record.status === 'open' &&
      question !== null &&
      typeof question === 'object' &&
      !Array.isArray(question) &&
      question.kind === 'ask_user_question'
    )
      return true
  }
  return false
}
