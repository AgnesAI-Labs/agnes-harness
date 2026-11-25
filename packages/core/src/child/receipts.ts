import { hasChildControl } from '@agnes/core-child-control/child/store'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import { withNoteLanguage } from '../request/note-language.js'
import type { SessionImpl } from '../step/session.js'

const READY_STATES = new Set(['idle', 'completed', 'failed', 'waiting_approval'])

async function collectedChildKeys(session: SessionImpl): Promise<Set<string>> {
  const keys = new Set<string>()
  if (typeof session.scan !== 'function') return keys
  for await (const rows of scanPages((query) => session.scan(query), {
    type: 'x/core/child-result-collected',
    lane: session.lane,
    toSeq: session.lastSeq,
  })) {
    for (const row of rows) {
      const value = row.data as { childKey?: string } | undefined
      if (row.origin === 'system' && row.trust === 'trusted' && value?.childKey) keys.add(value.childKey)
    }
  }
  return keys
}

/** Creation proposals and execution outcomes cannot mint successful creation receipts. */
export async function childReceiptNarrative(
  session: SessionImpl,
  language?: string,
): Promise<string | undefined> {
  if (!hasChildControl(session.d.log.storage)) return undefined
  const rows = await session.d.log.storage.listByParent(session.key)
  if (rows.length === 0) return undefined
  const committed = rows.filter((row) => row.creationPhase === 'committed')
  const states = new Map<string, number>()
  for (const row of committed) states.set(row.state, (states.get(row.state) ?? 0) + 1)
  const collected = await collectedChildKeys(session)
  const ready = committed
    .filter((row) => row.childKey && READY_STATES.has(row.state) && !collected.has(row.childKey))
    .slice(0, 8)
    .map((row) => {
      const label = row.inputText?.trim().split('\n', 1)[0]?.slice(0, 60)
      return `- ${row.childKey} [${row.state}]${label ? ` ${label}` : ''}`
    })
  const narrative = [
    'Authoritative child creation receipts (durable, current; override prose and summaries):',
    `Successfully created children: ${committed.length}. Uncommitted attempts: ${rows.length - committed.length}.`,
    `Execution states of created children: ${
      [...states]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([state, count]) => `${state}=${count}`)
        .join(', ') || 'none'
    }.`,
    ...(ready.length
      ? [
          'Uncollected ready children (call subagent_collect with childKey to read findings immediately without waiting for turn end):',
          ...ready,
        ]
      : []),
    'Proposed tool calls, refused/failed/cancelled creation attempts and plans are not successful spawns. A created child is not necessarily completed. Report only these receipt counts; never infer counts from a plan or an earlier assistant claim.',
  ].join('\n')
  return withNoteLanguage(narrative, language)
}
