import type { FactChainAnchor, FactChainResult, UINode } from '@agnes/protocol'
import type { TraceRow } from './trace-model.js'

/**
 * The trace row a fact-chain link points at: the request with that call id, the tool call with that
 * tool use, or for an artifact the tool call whose call/result range holds the artifact's record
 * (else the last tool call before it). A feedback candidate needs its chain read first.
 */
export function resolveFactRow(
  rows: readonly TraceRow[],
  nodes: readonly UINode[],
  anchor: FactChainAnchor,
): string | undefined {
  if (anchor.kind === 'request') return rows.find((row) => row.requestTraceId === anchor.callId)?.id
  if (anchor.kind === 'tool') return rows.find((row) => row.tool?.toolUseId === anchor.toolUseId)?.id
  if (anchor.kind === 'artifact') {
    const tools = nodes.filter(
      (node): node is Extract<UINode, { kind: 'tool' }> => node.kind === 'tool' && node.seq <= anchor.seq,
    )
    const holder =
      tools.find((node) => (node.resultSeq ?? node.seq) >= anchor.seq) ??
      tools.reduce<(typeof tools)[number] | undefined>(
        (last, node) => (!last || node.seq > last.seq ? node : last),
        undefined,
      )
    return holder && rows.some((row) => row.id === holder.id) ? holder.id : undefined
  }
  return undefined
}

/** A feedback candidate's authoring record names the tool call (or at least the turn) behind it. */
export function authoringRow(rows: readonly TraceRow[], result: FactChainResult): string | undefined {
  const authoring = result.nodes.find((node) => node.kind === 'authoring')
  if (!authoring) return undefined
  const byTool = authoring.toolUseId
    ? rows.find((row) => row.tool?.toolUseId === authoring.toolUseId)
    : undefined
  if (byTool) return byTool.id
  const turn = authoring.turn
  return typeof turn === 'number'
    ? rows.filter((row) => row.turn === turn).findLast((row) => row.kind === 'assistant')?.id
    : undefined
}
