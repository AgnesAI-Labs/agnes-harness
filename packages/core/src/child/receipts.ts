import { hasChildControl } from '@agnes/core-child-control/child/store'
import type { SessionImpl } from '../step/session.js'

/** Creation proposals and execution outcomes cannot mint successful creation receipts. */
export async function childReceiptNarrative(session: SessionImpl): Promise<string | undefined> {
  if (!hasChildControl(session.d.log.storage)) return undefined
  const rows = await session.d.log.storage.listByParent(session.key)
  if (rows.length === 0) return undefined
  const committed = rows.filter((row) => row.creationPhase === 'committed')
  const states = new Map<string, number>()
  for (const row of committed) states.set(row.state, (states.get(row.state) ?? 0) + 1)
  return [
    'Authoritative child creation receipts (durable, current; override prose and summaries):',
    `Successfully created children: ${committed.length}. Uncommitted attempts: ${rows.length - committed.length}.`,
    `Execution states of created children: ${
      [...states]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([state, count]) => `${state}=${count}`)
        .join(', ') || 'none'
    }.`,
    'Proposed tool calls, refused/failed/cancelled creation attempts and plans are not successful spawns. A created child is not necessarily completed. Report only these receipt counts; never infer counts from a plan or an earlier assistant claim.',
  ].join('\n')
}
