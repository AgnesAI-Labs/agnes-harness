import { type HostSession, voiceRpcError, voiceSpeak, voiceTranscribe } from '@agnes/host'

/**
 * `session.voice.transcribe` / `session.voice.speak` for a session this worker holds, on the route the
 * daemon chose; the daemon cancels a call with `abort` by its run id.
 */
export async function workerVoice(
  session: HostSession,
  method: 'voice.transcribe' | 'voice.speak',
  params: Readonly<Record<string, unknown>>,
  aborts: Map<string, AbortController>,
): Promise<unknown> {
  const runId = String(params.runId)
  if (!runId.startsWith('voice:') || aborts.has(runId)) throw new Error('Invalid voice call id')
  const abort = new AbortController()
  aborts.set(runId, abort)
  const options = { route: String(params.route), signal: abort.signal }
  const { language, voice, speed } = params
  try {
    if (method === 'voice.transcribe')
      return await voiceTranscribe(
        session,
        { audio: String(params.audio), ...(typeof language === 'string' ? { language } : {}) },
        options,
      )
    return await voiceSpeak(
      session,
      {
        text: String(params.text),
        ...(typeof voice === 'string' ? { voice } : {}),
        ...(typeof speed === 'number' ? { speed } : {}),
      },
      options,
    )
  } catch (error) {
    throw voiceRpcError(error)
  } finally {
    if (aborts.get(runId) === abort) aborts.delete(runId)
  }
}
