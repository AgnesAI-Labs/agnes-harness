import type { UINode } from '@agnes/protocol'
import { clipUtf16 as clip } from './clip.js'

type NoticeNode = Extract<UINode, { kind: 'ledger-recovery' | 'tool-source-pending' }>

/**
 * The quiet session notices core writes as diagnostics: a recovered ledger tail, and tool sources a
 * turn started without because they were still connecting. A malformed row projects to nothing.
 */
export function noticeNode(type: string, id: string, seq: number, data: unknown): NoticeNode | undefined {
  if (type === 'x/core/ledger-tail-recovered') {
    const recovery = data as { diagnosticId?: unknown; validThroughSeq?: unknown }
    if (typeof recovery.diagnosticId !== 'string' || !Number.isSafeInteger(recovery.validThroughSeq))
      return undefined
    return {
      kind: 'ledger-recovery',
      id,
      seq,
      diagnosticId: clip(recovery.diagnosticId, 128),
      validThroughSeq: Number(recovery.validThroughSeq),
    }
  }
  const pending = data as { sources?: unknown }
  const sources = Array.isArray(pending.sources)
    ? pending.sources
        .filter((source): source is string => typeof source === 'string' && source.length > 0)
        .slice(0, 16)
        .map((source) => clip(source, 128))
    : []
  return sources.length > 0 ? { kind: 'tool-source-pending', id, seq, sources } : undefined
}
