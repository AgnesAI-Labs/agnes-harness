import { hasChildControl } from '@agnes/core-child-control/child/store'
import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import { sha256Hex } from '@agnes/core-common/request/hash'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import { withNoteLanguage } from '../request/note-language.js'
import type { SessionImpl } from '../step/session.js'
import { childResultSequence } from './collected-result.js'
import { childCompletionId } from './completion-notice.js'
import { retiredCompletionIdentity } from './idle-retirement-fact.js'

const READY_STATES = new Set(['idle', 'completed', 'failed', 'waiting_approval'])

type CollectedFacts = { commandIds: Set<string>; resultSeqs: Set<number> }

async function collectedChildFacts(session: SessionImpl): Promise<Map<string, CollectedFacts>> {
  const byChild = new Map<string, CollectedFacts>()
  if (typeof session.scan !== 'function') return byChild
  for await (const rows of scanPages((query) => session.scan(query), {
    type: 'x/core/child-result-collected',
    lane: session.lane,
    toSeq: session.lastSeq,
  })) {
    for (const row of rows) {
      if (row.origin !== 'system' || row.trust !== 'trusted') continue
      const value = row.data as { childKey?: string; commandId?: string; resultSeq?: number } | undefined
      if (!value?.childKey) continue
      let facts = byChild.get(value.childKey)
      if (!facts) {
        facts = { commandIds: new Set(), resultSeqs: new Set() }
        byChild.set(value.childKey, facts)
      }
      if (typeof value.commandId === 'string' && value.commandId) facts.commandIds.add(value.commandId)
      if (typeof value.resultSeq === 'number' && value.resultSeq > 0) facts.resultSeqs.add(value.resultSeq)
    }
  }
  return byChild
}

async function isCurrentResultCollected(
  session: SessionImpl,
  row: ChildTaskRecord,
  facts: CollectedFacts | undefined,
): Promise<boolean> {
  if (!facts) return false
  if (row.state === 'waiting_approval') {
    const commandId = `child-state:${sha256Hex(JSON.stringify([row.childKey, row.stateRevision, 'waiting_approval']))}`
    return facts.commandIds.has(commandId)
  }
  if (row.state !== 'idle' && row.state !== 'completed' && row.state !== 'failed') return false
  const normalized = { ...row, boundarySeq: row.boundarySeq ?? 0 }
  const canScan = typeof session.d.log.storage.scan === 'function'
  try {
    const resultSeq = canScan ? await childResultSequence(session, normalized) : 0
    if (resultSeq > 0 && facts.resultSeqs.has(resultSeq)) return true
    const retiredId =
      row.state === 'completed' && canScan
        ? await retiredCompletionIdentity(session, normalized, resultSeq)
        : undefined
    const commandId =
      retiredId ??
      childCompletionId(
        row.childKey,
        row.state === 'failed' ? 'failed' : 'completed',
        row.state === 'idle' ? resultSeq : undefined,
      )
    return facts.commandIds.has(commandId)
  } catch {
    return false
  }
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
  const collected = await collectedChildFacts(session)
  const ready: string[] = []
  for (const row of committed) {
    if (!row.childKey || !READY_STATES.has(row.state)) continue
    if (await isCurrentResultCollected(session, row, collected.get(row.childKey))) continue
    const label = row.inputText?.trim().split('\n', 1)[0]?.slice(0, 60)
    ready.push(`- ${row.childKey} [${row.state}]${label ? ` ${label}` : ''}`)
    if (ready.length >= 8) break
  }
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
