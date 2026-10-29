// StepFun's speech-to-text speaks its own dialect: a JSON request to `<base>/audio/asr/sse` and a
// server-sent-event reply. These are the pure pieces of it; index.ts sends the request.
import type { OpenAiAudioPayload } from './wire.js'

export const STEPFUN_DEFAULT_VOICE = 'cixingnansheng'

/** Models of the StepFun audio family: speech to text and text to speech. */
export const isStepfunModel = (model: string): boolean => /^(stepaudio-|step-tts-)/.test(model)
/** The models that transcribe through the SSE endpoint rather than the OpenAI multipart one. */
export const isStepfunAsrModel = (model: string): boolean => /^stepaudio-/.test(model)

/** The JSON body of `POST <base>/audio/asr/sse`. The recording travels as the payload's base64 WAV. */
export const stepfunAsrBody = (model: string, p: Extract<OpenAiAudioPayload, { op: 'transcribe' }>): string =>
  JSON.stringify({
    audio: {
      data: p.audio.data,
      input: {
        transcription: {
          model,
          ...(p.language === undefined ? {} : { language: p.language }),
          enable_itn: true,
        },
        format: { type: 'wav' },
      },
    },
  })

type Transcript = { ok: true; text: string } | { ok: false; retryable: boolean }

/**
 * Reads the event stream of a transcription until its `transcript.text.done` event and returns that
 * text. Deltas are ignored. An `error` event, a stream over `maxBytes` or an unusable done event is
 * a failure that asking again would not fix; a stream that ends without a done event is retryable.
 * Nothing from the stream is quoted back. `signal` cancels the read.
 */
export async function readStepfunTranscript(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Transcript> {
  const reader = body.getReader()
  const stop = () => void reader.cancel().catch(() => undefined)
  signal?.addEventListener('abort', stop, { once: true })
  const decoder = new TextDecoder('utf-8')
  let total = 0
  let pending = ''
  // Looks at one line; returns a verdict once the stream has said how it ends.
  const judge = (line: string): Transcript | undefined => {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
    if (!trimmed.startsWith('data:')) return undefined
    const data = trimmed.slice(5).trimStart()
    if (data === '' || data === '[DONE]') return undefined
    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      return { ok: false, retryable: false }
    }
    if (event === null || typeof event !== 'object') return { ok: false, retryable: false }
    const { type, text } = event as { type?: unknown; text?: unknown }
    if (type === 'error') return { ok: false, retryable: false }
    if (type !== 'transcript.text.done') return undefined
    return typeof text === 'string' ? { ok: true, text } : { ok: false, retryable: false }
  }
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) return { ok: false, retryable: false }
      pending += decoder.decode(next.value, { stream: true })
      for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
        const verdict = judge(pending.slice(0, at))
        pending = pending.slice(at + 1)
        if (verdict) return verdict
      }
    }
    pending += decoder.decode()
    return judge(pending) ?? { ok: false, retryable: true }
  } catch {
    // The connection broke mid-stream; the caller tells an abort from a transport fault.
    return { ok: false, retryable: true }
  } finally {
    signal?.removeEventListener('abort', stop)
    await reader.cancel().catch(() => undefined)
  }
}
