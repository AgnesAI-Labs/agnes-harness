import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import type { SessionImpl } from '../step/session.js'

const MAX_CODE_CHARS = 64
const MAX_MESSAGE_CHARS = 300

/** Why a failed child's turn ended in error. `message` is clipped, single-line adapter text. */
export type ChildFailure = { code: string; message: string }

/** One line, no control or invisible characters, at most `max` characters. */
function plain(text: string, max: number): string {
  const line = text.replace(/[\p{C}\s]+/gu, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/**
 * The error a `turn/end` row recorded, or nothing when the turn did not end in error. The text was
 * written by a provider adapter, so it reaches the parent as bounded data: it is never trusted and
 * never placed where an instruction would be read.
 */
export function childFailure(turnEnd: unknown): ChildFailure | undefined {
  const data = turnEnd as { reason?: unknown; error?: { code?: unknown; message?: unknown } } | undefined
  if (data?.reason !== 'error' || typeof data.error?.code !== 'string') return undefined
  const code = plain(data.error.code, MAX_CODE_CHARS)
  if (!code) return undefined
  return {
    code,
    message: typeof data.error.message === 'string' ? plain(data.error.message, MAX_MESSAGE_CHARS) : '',
  }
}

/** The failure of the child's last turn, read from its durable rows. */
export async function lastChildFailure(
  parent: SessionImpl,
  record: ChildTaskRecord,
): Promise<ChildFailure | undefined> {
  const fromSeq = (record.boundarySeq + 1) as typeof record.boundarySeq
  const end = await parent.d.log.storage.scan(record.childKey, {
    type: 'turn/end',
    fromSeq,
    order: 'desc',
    limit: 1,
  })
  return childFailure(end[0]?.data)
}

/** `: CODE (message)` for a sentence that names the failure, or nothing. */
export function failureSuffix(failure: ChildFailure | undefined): string {
  if (!failure) return ''
  return `: ${failure.code}${failure.message ? ` (${failure.message})` : ''}`
}
