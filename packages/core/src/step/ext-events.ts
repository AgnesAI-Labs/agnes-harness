import { CoreError, type Event, type Seq } from '@agnes/core-common/types'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { ScanQuery } from '@agnes/core-ledger/log/storage'
import { extEventType } from '@agnes/extension-api'
import { inspectJsonData } from '@agnes/protocol'
import type { ToolSource } from '../registry/tools.js'
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

const LOOP_OWNER = /^(?!(?:core|plugin)(?:\/|$))[a-z0-9._-]+(?:\/[a-z0-9._-]+)?$/
const LOOP_EVENT_NAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/

/**
 * A loop writes under the namespace of the package that owns it, `x/<package without @>/<name>`,
 * the way a plugin writes under its own row. The name has no separator of its own, so one package's
 * events can never spell another owner's type; `core` and `plugin` stay with the platform.
 */
export function prepareLoopEvent(owner: string, name: unknown, data: unknown) {
  const source = owner.replace(/^@/, '')
  if (typeof name !== 'string' || !LOOP_EVENT_NAME.test(name) || !LOOP_OWNER.test(source))
    invalid("Loop emit takes an event name inside the namespace of the loop's own package")
  const checked = inspectJsonData(data)
  if (!checked.ok) invalid('Invalid Loop event data')
  return { type: `x/${source}/${name}`, data: checked.value, source }
}

/** Called under SessionImpl's phase lock; counted history and append share the same turn boundary. */
export async function appendExtensionEvent(
  session: SessionImpl,
  event: ReturnType<typeof prepareExtensionEvent>,
  options: { loopTrigger?: boolean; sourceSeq?: number } = {},
): Promise<Seq> {
  if (options.sourceSeq !== undefined && (!Number.isSafeInteger(options.sourceSeq) || options.sourceSeq <= 0))
    invalid('invalid extension event source')
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
    const approvalResume =
      trigger?.type === 'turn/start' &&
      trigger.origin === 'system' &&
      trigger.trust === 'trusted' &&
      (trigger.data as { trigger?: string }).trigger === 'approval-resume'
    if (!trigger || (!options.loopTrigger && trigger.type !== 'user/message' && !approvalResume))
      invalid('extension event trigger unavailable')
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
      ...(options.sourceSeq === undefined ? {} : { sourceEventSeqs: [options.sourceSeq] }),
    },
  ])
  return result.firstSeq
}
