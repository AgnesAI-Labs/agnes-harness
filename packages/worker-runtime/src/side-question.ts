import { askSideQuestion, type HostSession, sideQuestionRpcError } from '@agnes/host'
import type { SessionBtwResult } from '@agnes/protocol'

/** `session.btw` for a session this worker holds; the daemon cancels it with `abort` by run id. */
export async function workerSideQuestion(
  session: HostSession,
  params: Readonly<Record<string, unknown>>,
  aborts: Map<string, AbortController>,
): Promise<SessionBtwResult> {
  const runId = String(params.runId)
  if (!runId.startsWith('btw:') || aborts.has(runId)) throw new Error('Invalid side question id')
  const abort = new AbortController()
  aborts.set(runId, abort)
  try {
    return await askSideQuestion(session, String(params.question), { signal: abort.signal })
  } catch (error) {
    throw sideQuestionRpcError(error)
  } finally {
    if (aborts.get(runId) === abort) aborts.delete(runId)
  }
}
