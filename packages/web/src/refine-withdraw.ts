import type { RefinementWithdrawOutcome } from '@agnes/web-ui/conversation'

type WithdrawClient = { session: { refineRollback(sessionId: string, appliedSeq: number): Promise<unknown> } }

/**
 * Withdraws one applied experience review of a session (`appliedSeq`, as its timeline line carries it)
 * and says how the daemon answered: done, refused because an entry changed since (a person has to
 * resolve it), refused for another reason, or failed.
 */
export async function withdrawRefinement(
  client: WithdrawClient,
  sessionId: string,
  appliedSeq: number,
): Promise<RefinementWithdrawOutcome> {
  try {
    await client.session.refineRollback(sessionId, appliedSeq)
    return { kind: 'withdrawn' }
  } catch (error) {
    const data = (error as { data?: { code?: unknown; reason?: unknown; changed?: unknown } } | null)?.data
    if (data?.code === 'SEMANTIC_REJECTED' && typeof data.reason === 'string') {
      if (data.reason !== 'changed-since') return { kind: 'refused', reason: data.reason }
      const changed = Array.isArray(data.changed)
        ? data.changed.filter((name): name is string => typeof name === 'string')
        : []
      return changed.length > 0 ? { kind: 'changed-since', changed } : { kind: 'changed-since' }
    }
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
