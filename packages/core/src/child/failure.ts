import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import { clipUtf16 } from '@agnes/core-ledger/project/clip'
import type { ChildStatus } from '@agnes/extension-api'
import type { SessionImpl } from '../step/session.js'

const MAX_CODE_CHARS = 64
const MAX_MESSAGE_CHARS = 300

/**
 * Why a failed child's last turn ended: the error it recorded, or the cap it stopped at. Empty when
 * neither applies. `error.message` is clipped, single-line adapter text.
 */
export type ChildEnd = Pick<ChildStatus, 'error' | 'stopReason'>

/** At most `max` UTF-16 units, ending in `…` when cut. The cut never splits a surrogate pair. */
export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${clipUtf16(text, max - 1)}…`
}

/** One line with no control or invisible characters. */
const oneLine = (text: string): string => text.replace(/[\p{C}\s]+/gu, ' ').trim()

/**
 * What a turn's end says about a failure: a `turn/end` row's data or the outcome a run returned. The
 * error text was written by a provider adapter, so it reaches the parent as bounded data: it is
 * never trusted and never placed where an instruction would be read.
 */
export function childEnd(turnEnd: unknown): ChildEnd {
  const end = turnEnd as { reason?: unknown; error?: { code?: unknown; message?: unknown } } | undefined
  if (end?.reason === 'budget' || end?.reason === 'max_steps') return { stopReason: end.reason }
  if (end?.reason !== 'error' || typeof end.error?.code !== 'string') return {}
  const code = clipText(oneLine(end.error.code), MAX_CODE_CHARS)
  if (!code) return {}
  const message = typeof end.error.message === 'string' ? end.error.message : ''
  return { error: { code, message: clipText(oneLine(message), MAX_MESSAGE_CHARS) } }
}

/** The end of a run that threw before its turn recorded one. */
export function thrownChildEnd(error: unknown): ChildEnd {
  const code = (error as { code?: unknown } | undefined)?.code
  return childEnd({
    reason: 'error',
    error: {
      code: typeof code === 'string' ? code : 'E_INTERNAL',
      message: error instanceof Error ? error.message : String(error),
    },
  })
}

/** The end of the child's last turn, read from its durable rows. */
export async function lastChildEnd(parent: SessionImpl, record: ChildTaskRecord): Promise<ChildEnd> {
  const fromSeq = (record.boundarySeq + 1) as typeof record.boundarySeq
  const end = await parent.d.log.storage.scan(record.childKey, {
    type: 'turn/end',
    fromSeq,
    order: 'desc',
    limit: 1,
  })
  return childEnd(end[0]?.data)
}

/**
 * What follows `failed` in a sentence about a child: `: CODE (message)`, `: stopped at its budget`,
 * `: stopped at its step limit`, or nothing. The one wording for the notice and the child tools.
 */
export function childFailureSuffix(end: ChildEnd): string {
  if (end.error) return `: ${end.error.code}${end.error.message ? ` (${end.error.message})` : ''}`
  if (end.stopReason === 'budget') return ': stopped at its budget'
  if (end.stopReason === 'max_steps') return ': stopped at its step limit'
  return ''
}
