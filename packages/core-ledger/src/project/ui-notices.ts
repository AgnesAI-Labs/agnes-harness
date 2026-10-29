import type { UINode } from '@agnes/protocol'
import { clipUtf16 as clip } from './clip.js'

type NoticeNode = Extract<
  UINode,
  { kind: 'ledger-recovery' | 'tool-source-pending' | 'workspace-undo' | 'memory-external-change' }
>

/**
 * The quiet session notices core writes as diagnostics: a recovered ledger tail, tool sources a
 * turn started without because they were still connecting, a turn's file changes being undone, and
 * memory files changed outside the memory provider before an injection. A malformed row projects to nothing.
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
  if (type === 'x/core/workspace-undo') {
    const undo = data as { turn?: unknown; restored?: unknown; failed?: unknown; conflicts?: unknown }
    if (
      !Number.isSafeInteger(undo.turn) ||
      Number(undo.turn) < 1 ||
      !Array.isArray(undo.restored) ||
      !Array.isArray(undo.failed) ||
      !Array.isArray(undo.conflicts)
    )
      return undefined
    return {
      kind: 'workspace-undo',
      id,
      seq,
      turn: Number(undo.turn),
      restored: undo.restored.length,
      failed: undo.failed.length,
      conflicts: undo.conflicts.length,
    }
  }
  if (type === 'x/core/memory-external-change') {
    const change = data as { paths?: unknown }
    const paths = Array.isArray(change.paths)
      ? change.paths
          .filter((path): path is string => typeof path === 'string' && path.length > 0)
          .slice(0, 16)
          .map((path) => clip(path, 128))
      : []
    return paths.length > 0 ? { kind: 'memory-external-change', id, seq, paths } : undefined
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
