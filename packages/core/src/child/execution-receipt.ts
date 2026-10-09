import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import type { ChildStatus } from '@agnes/extension-api'
import type { SessionImpl } from '../step/session.js'

/** Bounded child-local execution evidence. Never infer effects from an assistant message. */
export async function childExecutionReceipt(
  parent: SessionImpl,
  record: ChildTaskRecord,
): Promise<ChildStatus['receipt']> {
  const query = { fromSeq: record.boundarySeq + 1, order: 'desc' as const }
  const [calls, results] = await Promise.all([
    parent.d.log.storage.scan(record.childKey, { ...query, type: 'tool/call', limit: 32 }),
    parent.d.log.storage.scan(record.childKey, { ...query, type: 'tool/result', limit: 32 }),
  ])
  const names = new Map(
    calls.map((row) => {
      const data = row.data as { toolUseId: string; name: string }
      return [data.toolUseId, data.name]
    }),
  )
  return {
    workspace: { cwd: record.cwd, isolation: record.isolation },
    tools: results.reverse().flatMap((row) => {
      const data = row.data as { toolUseId: string; isError?: boolean }
      const name = names.get(data.toolUseId)
      return name ? [{ seq: row.seq, name, isError: data.isError === true }] : []
    }),
    truncated:
      calls.length === 32 ||
      results.length === 32 ||
      results.some((row) => !names.has((row.data as { toolUseId: string }).toolUseId)),
  }
}
