import { randomUUID } from 'node:crypto'
import type { RequestBody } from '@agnes/protocol'
import type { WireEvent } from '../../adapter.js'
import {
  appendPath,
  type Classified,
  checkedPayloadBase,
  failureEvent,
  plain,
  readCapped,
  readCappedBytes,
  WireFailure,
} from '../payload-wire.js'
import {
  type PayloadAdapterOptions,
  type PayloadRequest,
  PayloadWireAdapter,
} from '../payload-wire-adapter.js'
import { isStepfunAsrModel, readStepfunTranscript, stepfunAsrBody } from './stepfun.js'
import {
  classifyAudioStatus,
  MAX_SPEECH_BYTES,
  MAX_TRANSCRIPT_BYTES,
  multipartBody,
  OPENAI_AUDIO_WIRE_API,
  type OpenAiAudioPayload,
  openAiAudioUnits,
  readAudioPayload,
  speechBody,
  speechParams,
  wavHeader,
} from './wire.js'

export {
  MAX_SPEECH_BYTES,
  MAX_TRANSCRIPT_BYTES,
  OPENAI_AUDIO_WIRE_API,
  openAiAudioUnits,
  wavHeader,
} from './wire.js'
/** Recorded with every side call, so a change in what goes on the wire can be told apart in the audit. */
export const OPENAI_AUDIO_ADAPTER_VERSION = '1.0.0'

export type OpenAiAudioAdapterOptions = PayloadAdapterOptions

/**
 * Speech to text and text to speech over an OpenAI-style audio API, for a `{op, ...}` payload and
 * nothing else: no messages, no tools, no streaming. A transcription is `POST <base>/audio/transcriptions`
 * (multipart), or for a StepFun `stepaudio-` model `POST <base>/audio/asr/sse` (JSON, read as an event
 * stream); a speech is `POST <base>/audio/speech` and comes back as base64 mp3.
 *
 * It sends exactly one HTTP request per call and never retries: a rate limit comes back as a
 * retryable error carrying the vendor's wait. Redirects are refused so the key cannot be sent
 * anywhere else, replies are capped, and no error message quotes the reply, the key or the audio.
 */
export class OpenAiAudioAdapter extends PayloadWireAdapter<OpenAiAudioPayload> {
  override readonly version = OPENAI_AUDIO_ADAPTER_VERSION

  constructor(opts: OpenAiAudioAdapterOptions) {
    super({ api: OPENAI_AUDIO_WIRE_API, target: checkedPayloadBase }, opts)
  }

  protected readPayload(req: RequestBody): OpenAiAudioPayload | string {
    return readAudioPayload(req)
  }

  /** The request a payload becomes: where it goes, what it carries and what may be reported of it. */
  protected prepare(base: URL, req: RequestBody, p: OpenAiAudioPayload): PayloadRequest {
    const { model } = req
    if (p.op === 'speech') {
      const params = speechParams(model, p)
      return {
        url: appendPath(base, '/audio/speech').href,
        headers: { 'content-type': 'application/json', accept: 'audio/*' },
        body: speechBody(model, p, params),
        report: {
          model,
          op: 'speech',
          voice: params.voice,
          ...(params.speed === undefined ? {} : { speed: params.speed }),
          response_format: 'mp3',
          inputBytes: new TextEncoder().encode(p.text).length,
        },
      }
    }
    const report = {
      model,
      op: 'transcribe',
      ...(p.language === undefined ? {} : { language: p.language }),
      mimeType: 'audio/wav',
      audioBytes: (wavHeader(p.audio.data)?.dataBytes ?? 0) + 44,
      audioSeconds: openAiAudioUnits(p),
    }
    if (isStepfunAsrModel(model))
      return {
        url: appendPath(base, '/audio/asr/sse').href,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: stepfunAsrBody(model, p),
        report,
      }
    const boundary = `agnes-${randomUUID()}`
    return {
      url: appendPath(base, '/audio/transcriptions').href,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, accept: 'application/json' },
      body: multipartBody(
        { model, ...(p.language === undefined ? {} : { language: p.language }) },
        Buffer.from(p.audio.data, 'base64'),
        boundary,
      ),
      report,
    }
  }

  protected async classify(response: Response): Promise<Classified> {
    // The body is never read: the status decides, and a vendor's error text may quote the request.
    await response.body?.cancel().catch(() => undefined)
    return classifyAudioStatus(response.status)
  }

  protected requestIdOf(headers: Headers): string | undefined {
    const value = headers.get('x-request-id')
    return value !== null && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined
  }

  protected async read(
    response: Response,
    payload: OpenAiAudioPayload,
    ctx: { req: RequestBody; signal: AbortSignal; requestId: string | undefined },
  ): Promise<WireEvent[]> {
    const { status } = response
    const units = openAiAudioUnits(payload) ?? 0
    const usage: WireEvent = {
      type: 'usage',
      tokens: { input: units, output: 0, cacheRead: 0, cacheWrite: 0 },
      // Credits are the facade's to work out, from the catalogue price.
      creditSource: 'estimated',
      response: {
        status,
        ...(ctx.requestId === undefined ? {} : { id: ctx.requestId }),
        model: ctx.req.model,
      },
    }
    try {
      const text = await this.#result(response, payload, ctx.req.model, ctx.signal)
      return [
        ...(text === '' ? [] : [{ type: 'text_delta' as const, delta: text }]),
        usage,
        { type: 'done', reason: 'stop' },
      ]
    } catch (error) {
      if (ctx.signal.aborted || !(error instanceof WireFailure)) throw error
      // The vendor ran the call and bills it, so the units are charged before the error. A stream that
      // ended early is the connection's fault and worth asking again; a reply that cannot be used is not.
      return [usage, failureEvent(this.id, error.code, error.code === 'TRANSPORT')]
    }
  }

  /** A successful reply as the text the call returns: a transcript, or the speech as base64. */
  async #result(
    response: Response,
    payload: OpenAiAudioPayload,
    model: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (payload.op === 'speech') {
      const type = (response.headers.get('content-type') ?? '').toLowerCase()
      if (!type.startsWith('audio/') && !type.startsWith('application/octet-stream')) {
        await response.body?.cancel().catch(() => undefined)
        throw new WireFailure('FORMAT')
      }
      const bytes = await readCappedBytes(response, MAX_SPEECH_BYTES, signal)
      if (bytes.byteLength === 0) throw new WireFailure('FORMAT')
      return Buffer.from(bytes).toString('base64')
    }
    if (isStepfunAsrModel(model)) {
      if (!response.body) throw new WireFailure('FORMAT')
      const transcript = await readStepfunTranscript(response.body, MAX_TRANSCRIPT_BYTES, signal)
      if (transcript.ok) return transcript.text
      throw new WireFailure(transcript.retryable ? 'TRANSPORT' : 'FORMAT')
    }
    let reply: unknown
    try {
      reply = JSON.parse(await readCapped(response, MAX_TRANSCRIPT_BYTES, signal))
    } catch (error) {
      throw error instanceof WireFailure ? error : new WireFailure('FORMAT')
    }
    if (!plain(reply) || typeof reply.text !== 'string') throw new WireFailure('FORMAT')
    return reply.text
  }
}

/**
 * Asks the vendor for its model list with the key: an answer proves the address and the key, a
 * rejected key is told apart, a rate limit is "throttled" and everything else - a bad address, a
 * transport fault, a timeout - is just "failed". No model is called, so nothing is billed, and no
 * part of the reply leaves this function.
 */
export async function probeOpenAiAudioEndpoint(args: {
  baseUrl: string
  credential: string
  request: typeof globalThis.fetch
  signal: AbortSignal
}): Promise<'ok' | 'throttled' | 'auth' | 'failed'> {
  const base = checkedPayloadBase(args.baseUrl)
  if (typeof base === 'string') return 'failed'
  try {
    const response = await args.request(appendPath(base, '/models').href, {
      method: 'GET',
      headers: { authorization: `Bearer ${args.credential}`, accept: 'application/json' },
      redirect: 'error',
      signal: args.signal,
    })
    await response.body?.cancel().catch(() => undefined)
    if (response.status >= 200 && response.status < 300) return 'ok'
    if (response.status === 401 || response.status === 403) return 'auth'
    return response.status === 429 ? 'throttled' : 'failed'
  } catch {
    return 'failed'
  }
}
