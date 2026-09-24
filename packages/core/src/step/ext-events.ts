import { extEventType } from '@agnes/extension-api'
import { inspectJsonData } from '@agnes/protocol'
import { scanPages } from '../log/scan-pages.js'
import type { ScanQuery } from '../log/storage.js'
import type { ToolSource } from '../registry/tools.js'
import { CoreError, type Event, type Seq } from '../types.js'
import type { SessionImpl } from './session.js'

function invalid(message = 'invalid extension event'): never {
  throw new CoreError('E_ENVELOPE', message)
}

/** Validate before queuing so caller mutation cannot change the admitted event. */
export function prepareExtensionEvent(type: string, data: unknown, meta: ToolSource) {
  const source = meta.source
  const prefix = `x/${source}/`
  if (
    typeof type !== 'string' ||
    !['builtin', 'trusted'].includes(meta.trust) ||
    !type.startsWith(prefix) ||
    extEventType(source, type.slice(prefix.length)) !== type
  )
    invalid()
  const checked = inspectJsonData(data)
  if (!checked.ok) invalid()
  return { type, data: checked.value, source }
}

/** Called under SessionImpl's phase lock; counted history and append share the same turn boundary. */
export async function appendExtensionEvent(
  session: SessionImpl,
  event: ReturnType<typeof prepareExtensionEvent>,
): Promise<Seq> {
  const op = session.op()
  let trigger: Event | undefined
  if (op) {
    const from = op.meta.triggerSeq
    const read = (q: ScanQuery) => session.d.log.scan(q)
    const quota = session.preset.ext.eventsPerTurn
    // The ledger only grows, so the count carries over between calls in one turn and each call reads
    // only the rows after the last one counted. The turn memory is rebuilt on a new turn and on
    // rehydrate, which starts the count again from the trigger.
    const kept = session.turn?.extEvents
    const tally = kept?.triggerSeq === from ? kept : { triggerSeq: from, countedTo: from - 1, count: 0 }
    if (session.turn) session.turn.extEvents = tally
    const upto = session.lastSeq
    if (tally.count < quota && tally.countedTo < upto) {
      // Page by page, stopping on the page that reaches the quota.
      for await (const page of scanPages(read, {
        fromSeq: tally.countedTo + 1,
        toSeq: upto,
        lane: session.lane,
      })) {
        tally.count += page.filter((row) => row.origin.startsWith('ext:')).length
        tally.countedTo = (page[page.length - 1] as Event).seq
        if (tally.count >= quota) break
      }
      if (tally.count < quota) tally.countedTo = upto
    }
    if (tally.count >= quota) invalid('extension event quota exceeded')
    ;[trigger] = await read({ fromSeq: from, toSeq: from, lane: session.lane, limit: 1 })
    if (trigger?.type !== 'user/message') invalid('extension event trigger unavailable')
  }
  const actor = trigger?.actor ?? { id: 'system', org: 'local', role: 'system', deptPath: [], attrs: {} }
  const result = await session.d.log.append([
    {
      type: event.type,
      data: event.data,
      actor,
      origin: `ext:${event.source}`,
      trust: 'untrusted',
      lane: session.lane,
      ignorable: true,
    },
  ])
  return result.firstSeq
}
