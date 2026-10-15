import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import type { ChildStatus } from '@agnes/core-effects/effects/tool-context'
import type { SessionImpl } from '../step/session.js'
import { childExecutionReceipt } from './execution-receipt.js'

export function snapshotFromRecord(record: ChildTaskRecord): ChildStatus {
  const terminal = record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled'
  return {
    state:
      record.state === 'failed' || record.state === 'cancelled' ? 'error' : terminal ? 'done' : 'running',
    lastSeq: 0,
  }
}

export async function snapshotFromLedger(parent: SessionImpl, record: ChildTaskRecord): Promise<ChildStatus> {
  const base = snapshotFromRecord(record)
  try {
    const fromSeq = (record.boundarySeq + 1) as typeof record.boundarySeq
    const tail = await parent.d.log.storage.scan(record.childKey, { fromSeq, order: 'desc', limit: 1 })
    const msgs = await parent.d.log.storage.scan(record.childKey, {
      fromSeq,
      type: 'assistant/message',
      order: 'desc',
      limit: 1,
    })
    const content = (msgs[0]?.data as { content?: Array<{ type?: string; text?: string }> } | undefined)
      ?.content
    const text = (content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    return {
      ...base,
      lastSeq: tail[0]?.seq ?? base.lastSeq,
      ...(text ? { text } : {}),
      receipt: await childExecutionReceipt(parent, record),
    }
  } catch {
    return base
  }
}
