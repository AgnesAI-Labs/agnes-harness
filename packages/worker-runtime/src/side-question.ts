import { askSideQuestion, type HostSession, sideQuestionRpcError } from '@agnes/host'
import type { SessionBtwResult } from '@agnes/protocol'
import { workerVoice } from './voice.js'

/** The session commands that are one side call each, answered by `workerSideCall`. */
export const SIDE_CALL_COMMANDS = { btw: true, 'voice.transcribe': true, 'voice.speak': true } as const

/** A side call for a session this worker holds: a side question or one voice call. */
export function workerSideCall(
  session: HostSession,
  cmd: { method: string; params: unknown },
  aborts: Map<string, AbortController>,
): Promise<unknown> {
  const params = cmd.params as Readonly<Record<string, unknown>>
  if (cmd.method === 'voice.transcribe' || cmd.method === 'voice.speak')
    return workerVoice(session, cmd.method, params, aborts)
  return workerSideQuestion(session, params, aborts)
}

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
