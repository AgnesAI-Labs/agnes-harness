import type { SurfaceNode } from '@agnes/extension-api'

export type Cut = {
  keepFromSeq: number
  summarizeRange: [number, number]
  turnPrefixRange?: [number, number]
  /** The single summarized range ends inside the turn that is still running. */
  inProgressTail?: true
}

const isCutPoint = (node: SurfaceNode): boolean =>
  node.type === 'user/message' || node.type === 'assistant/message'

export function estimateTokens(node: SurfaceNode): number {
  const estimate = node.tokensEstimate
  return typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= 0 ? estimate : 64
}

function previousCutPoint(nodes: readonly SurfaceNode[], from: number): number {
  for (let index = from; index >= 0; index--) if (isCutPoint(nodes[index] as SurfaceNode)) return index
  return -1
}

function turnStart(nodes: readonly SurfaceNode[], from: number): number {
  for (let index = from; index >= 0; index--) if (nodes[index]?.type === 'user/message') return index
  return -1
}

/**
 * Whether masking `nodes[i..j]` keeps every tool call and its results on the same side, judged by
 * position exactly as core judges a replace: a result belongs to the nearest assistant before it,
 * looking back past results and users and stopping at a summary. The range may not start on a
 * result, and the node after it may not be one. Proposing only ranges this accepts is what keeps
 * core from refusing the plan.
 */
export function pairClosed(nodes: readonly SurfaceNode[], i: number, j: number): boolean {
  if (nodes[i]?.type === 'tool/result' || nodes[j + 1]?.type === 'tool/result') return false
  let owner = -1
  for (let k = 0; k < nodes.length; k++) {
    const type = nodes[k]?.type
    if (type === 'assistant/message') owner = k
    else if (type === 'summary') owner = -1
    else if (type === 'tool/result' && owner >= 0 && (k >= i && k <= j) !== (owner >= i && owner <= j))
      return false
  }
  return true
}

/**
 * Selects the oldest node in the retained suffix: the closest user or assistant message at or after
 * the token threshold or, when the budget is already crossed inside the trailing results, the last
 * one before it, so only the final step is kept. Starting at an assistant summarizes the turn's
 * opening separately as a prefix or, when there is no earlier history to pair it with, as one range
 * marked as ending inside a running turn. Pinned nodes are always kept.
 */
export function chooseCut(nodes: readonly SurfaceNode[], keepRecentTokens: number): Cut | null {
  if (nodes.length < 2) return null

  const budget = Number.isFinite(keepRecentTokens) ? Math.max(0, keepRecentTokens) : 0
  let accumulated = 0
  let thresholdIndex = nodes.length - 1
  let reached = false
  for (; thresholdIndex >= 0; thresholdIndex--) {
    accumulated += estimateTokens(nodes[thresholdIndex] as SurfaceNode)
    if (accumulated >= budget) {
      reached = true
      break
    }
  }
  if (!reached || thresholdIndex <= 0) return null

  let cut = nodes.findIndex((node, index) => index >= thresholdIndex && isCutPoint(node))
  if (cut < 0) cut = previousCutPoint(nodes, thresholdIndex - 1)
  const pinned = nodes.findIndex((node, index) => index < cut && node.pinned === true)
  if (pinned >= 0) cut = previousCutPoint(nodes, pinned)
  // Only a batch whose results sit on both sides of a runtime note moves the cut back here.
  while (cut > 0 && !pairClosed(nodes, 0, cut - 1)) cut = previousCutPoint(nodes, cut - 1)
  if (cut <= 0 || nodes[0]?.type === 'tool/result' || nodes.slice(0, cut).some((node) => node.pinned))
    return null

  const at = (index: number) => (nodes[index] as SurfaceNode).seq
  // An existing summary stays inside the range, so repeated compaction replaces it rather than
  // stacking summaries. A range holding nothing else would only summarize it again, which cannot
  // come out smaller.
  const onlySummary = (end: number) => end === 0 && nodes[0]?.type === 'summary'
  if (onlySummary(cut - 1)) return null
  const whole: Cut = { keepFromSeq: at(cut), summarizeRange: [at(0), at(cut - 1)] }
  if (nodes[cut]?.type !== 'assistant/message') return whole
  const start = turnStart(nodes, cut)
  if (
    start > 0 &&
    !onlySummary(start - 1) &&
    pairClosed(nodes, 0, start - 1) &&
    pairClosed(nodes, start, cut - 1)
  )
    return { ...whole, summarizeRange: [at(0), at(start - 1)], turnPrefixRange: [at(start), at(cut - 1)] }
  return { ...whole, inProgressTail: true }
}
