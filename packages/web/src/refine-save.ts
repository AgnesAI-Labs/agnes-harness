import type { RefinementSaveOutcome } from '@agnes/web-ui/conversation'

type SaveClient = {
  session: { refineSave(sessionId: string, kind: string, id: string, target?: 'user'): Promise<unknown> }
}
type Outcome = Extract<RefinementSaveOutcome, { kind: 'receipt' }>['state']
const OUTCOMES = new Set<string>(['saved', 'installed', 'awaiting-approval', 'refused', 'unknown'])

/**
 * Saves one entry an applied review kept to the session's workspace (or, with `target: 'user'`, to user
 * memory), as the owner's own save, and says
 * how the daemon answered: the receipt's outcome and reason (never the entry's text), a refusal before
 * any receipt (for example the entry is no longer in the session), or a failure to ask.
 */
export async function saveRefinementEntry(
  client: SaveClient,
  sessionId: string,
  kind: 'memory' | 'prompt' | 'skill',
  id: string,
  target?: 'user',
): Promise<RefinementSaveOutcome> {
  try {
    const result = (await (target
      ? client.session.refineSave(sessionId, kind, id, target)
      : client.session.refineSave(sessionId, kind, id))) as {
      receipt?: {
        outcome?: unknown
        reason?: unknown
        layer?: unknown
        userMemoryRead?: unknown
        initiator?: unknown
      }
    } | null
    const outcome = result?.receipt?.outcome
    if (typeof outcome !== 'string' || !OUTCOMES.has(outcome))
      return { kind: 'failed', message: 'unexpected answer' }
    const reason = result?.receipt?.reason
    return {
      kind: 'receipt',
      state: outcome as Outcome,
      ...(typeof reason === 'string' ? { reason } : {}),
      // A save to user memory says so, and where it asked for it, whether the workspace reads user memory.
      ...(result?.receipt?.layer === 'user' ? { target: 'user-memory' as const } : {}),
      ...(typeof result?.receipt?.userMemoryRead === 'boolean'
        ? { userMemoryRead: result.receipt.userMemoryRead }
        : {}),
      ...(result?.receipt?.initiator === 'user' ? { initiator: 'user' as const } : {}),
    }
  } catch (error) {
    const data = (error as { data?: { code?: unknown; reason?: unknown } } | null)?.data
    if (data?.code === 'SEMANTIC_REJECTED' && typeof data.reason === 'string')
      return { kind: 'refused', reason: data.reason }
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
