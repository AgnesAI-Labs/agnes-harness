/** Presentation only: retain the complete projection for diagnostics, trace and accounting. */
export function isConversationNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return true
  const value = node as { kind?: string; text?: string; thinking?: string; lostChars?: number }
  if (value.kind === 'context' || value.kind === 'context-sections') return false
  // An attempt whose streamed text died with its process has nothing to show but that it was lost.
  if (value.kind === 'assistant')
    return Boolean(value.text?.trim() || value.thinking?.trim() || value.lostChars !== undefined)
  return true
}

export function shouldShowEmptyState(
  content: readonly unknown[] | { nodes: readonly unknown[]; turns?: readonly unknown[] } | undefined,
): boolean {
  if (!content) return true
  if ('nodes' in content) return !content.turns?.length && !content.nodes.some(isConversationNode)
  return !content.some(isConversationNode)
}
