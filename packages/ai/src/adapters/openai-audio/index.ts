import { randomUUID } from 'node:crypto'
import type { ModelAdapterConfig } from '@agnes/extension-api'
import type { AiErrorCode, ModelRecord, RequestBody, RouteDecl } from '@agnes/protocol'
import { createDeploymentFetch } from '@agnes/system-node/deployment-network'
import { type AdapterStreamOptions, WireAdapter, type WireEvent } from '../../adapter.js'
import { AiSetupError } from '../../errors.js'
import { sha256Hex } from '../../hash.js'
import {
  appendPath,
  checkedPayloadBase,
  type FailureDetail,
  parseRetryAfter,
  failureEvent as payloadFailureEvent,
  plain,
  readCapped,
  readCappedBytes,
  WireFailure,
  zeroUsageEvent,
} from '../payload-wire.js'
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

type Network = { fetch: typeof globalThis.fetch; close(): Promise<void> }
type RouteState = { decl: RouteDecl; base: URL; models: ModelRecord[]; network: Network }
type Dispatch = {
  url: string
  headers: Record<string, string>
  body: string | Uint8Array<ArrayBuffer>
  /** What the request-capture hook may see: metadata only, never the recording or the text. */
  report: Record<string, unknown>
}

const failureEvent = (code: AiErrorCode, retryable: boolean, detail: FailureDetail = {}): WireEvent =>
  payloadFailureEvent(OPENAI_AUDIO_WIRE_API, code, retryable, detail)

/** The vendor's id for a call, when the header holds something that is safe to record. */
function requestIdOf(headers: Headers): string | undefined {
  const value = headers.get('x-request-id')
  return value !== null && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined
}

export type OpenAiAudioAdapterOptions = {
  routes: ModelAdapterConfig['routes']
  /** Replaces the network layer of each route. By default every route gets a deployment pool. */
  network?: (decl: RouteDecl) => Network
  /** The clock `retry-after` dates are measured against. */
  clock?: () => number
}

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
export class OpenAiAudioAdapter extends WireAdapter {
  override readonly version = OPENAI_AUDIO_ADAPTER_VERSION
  override readonly acceptsPayload = true
  readonly id = OPENAI_AUDIO_WIRE_API
  readonly #routes = new Map<string, RouteState>()
  readonly #lifetime = new AbortController()
  readonly #clock: () => number
  #closing: Promise<void> | undefined

  constructor(opts: OpenAiAudioAdapterOptions) {
    super()
    this.#clock = opts.clock ?? Date.now
    const planned = new Map<string, Omit<RouteState, 'network'>>()
    for (const route of opts.routes) {
      const { models, keyless: _keyless, ...decl } = route
      const fail = (code: ConstructorParameters<typeof AiSetupError>[0], reason: string) =>
        new AiSetupError(code, { route: decl.route, reason })
      if (decl.api !== OPENAI_AUDIO_WIRE_API) throw fail('NO_ADAPTER', 'the route is for another api')
      const base = checkedPayloadBase(decl.baseUrl)
      if (typeof base === 'string') throw fail('INVALID_BASE_URL', base)
      if (planned.has(decl.route)) throw fail('DUPLICATE_ROUTE', 'the route is declared twice')
      // A contract prefix would be written into `system`, which this payload has no place for.
      if (
        models.some(
          (m) => m.route !== decl.route || m.api !== OPENAI_AUDIO_WIRE_API || m.contract_id !== null,
        )
      )
        throw fail('CONTRACT_MISMATCH', 'a model does not belong to this route or names a contract')
      planned.set(decl.route, { decl: structuredClone(decl), base, models: structuredClone(models) })
    }
    const opened: Network[] = []
    try {
      for (const [name, route] of planned) {
        const network = opts.network?.(route.decl) ?? createDeploymentFetch({ ...route.decl.networkTimeouts })
        opened.push(network)
        this.#routes.set(name, { ...route, network })
      }
    } catch (error) {
      for (const network of opened) void network.close().catch(() => undefined)
      throw error
    }
  }

  routes(): RouteDecl[] {
    return [...this.#routes.values()].map((r) => structuredClone(r.decl))
  }

  models(route: string): ModelRecord[] {
    return structuredClone(this.#routes.get(route)?.models ?? [])
  }

  async *stream(route: string, req: RequestBody, opts: AdapterStreamOptions): AsyncIterable<WireEvent> {
    yield* await this.#exchange(route, req, opts)
  }

  /** Ends calls in flight, then closes each route's connection pool. Safe to call again. */
  dispose(): Promise<void> {
    this.#closing ??= (async () => {
      this.#lifetime.abort()
      const routes = [...this.#routes.values()]
      for (const r of routes) this.bindCredential(r.decl.route, undefined)
      await Promise.allSettled(routes.map((r) => r.network.close()))
    })()
    return this.#closing
  }

  /** The request a payload becomes: where it goes, what it carries and what may be reported of it. */
  #dispatchFor(base: URL, model: string, p: OpenAiAudioPayload): Dispatch {
    if (p.op === 'speech') {
      const body = speechBody(model, p)
      const sent = JSON.parse(body) as { voice: string; speed?: number }
      return {
        url: appendPath(base, '/audio/speech').href,
        headers: { 'content-type': 'application/json', accept: 'audio/*' },
        body,
        report: {
          model,
          op: 'speech',
          voice: sent.voice,
          ...(sent.speed === undefined ? {} : { speed: sent.speed }),
          response_format: 'mp3',
          inputBytes: new TextEncoder().encode(p.text).length,
        },
      }
    }
    const header = wavHeader(p.audio.data)
    const report = {
      model,
      op: 'transcribe',
      ...(p.language === undefined ? {} : { language: p.language }),
      mimeType: 'audio/wav',
      audioBytes: (header?.dataBytes ?? 0) + 44,
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

  async #exchange(route: string, req: RequestBody, opts: AdapterStreamOptions): Promise<WireEvent[]> {
    const state = this.#lifetime.signal.aborted ? undefined : this.#routes.get(route)
    if (!state) return [failureEvent('NO_ADAPTER', false)]
    const payload = readAudioPayload(req)
    if (typeof payload === 'string') return [failureEvent('CONTRACT_MISMATCH', false, { word: payload })]
    const key = this.credentialFor(route)
    if (key === undefined) return [failureEvent('AUTH', false, { word: 'no_credential' })]

    // One limit for the whole call: the reply arrives as one piece, so the first byte comes about
    // when the last does and the two caller limits come to the same thing.
    const timeout = AbortSignal.timeout(Math.min(opts.timeoutMs.firstToken, opts.timeoutMs.total))
    const signal = AbortSignal.any([opts.signal, timeout, this.#lifetime.signal])
    const interrupted = (): WireEvent =>
      opts.signal.aborted || this.#lifetime.signal.aborted
        ? failureEvent('ABORTED', false)
        : timeout.aborted
          ? failureEvent('TIMEOUT', true)
          : failureEvent('TRANSPORT', true)
    if (signal.aborted) return [interrupted()]

    const dispatch = this.#dispatchFor(state.base, req.model, payload)
    opts.reportSent?.({
      sentHash: sha256Hex(dispatch.body),
      transforms: [{ event: 'payload_body', ext: OPENAI_AUDIO_WIRE_API }],
    })
    try {
      await opts.reportRequest?.(dispatch.report)
    } catch {
      /* Request capture is passive and never decides whether to send. */
    }
    // The capture hook can take a while; a call that ended meanwhile is not dispatched or reported.
    if (signal.aborted) return [interrupted()]
    opts.reportDispatch?.()
    let response: Response
    try {
      response = await state.network.fetch(dispatch.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, ...dispatch.headers },
        body: dispatch.body,
        redirect: 'error',
        signal,
      })
    } catch {
      return [interrupted()]
    }

    const { status } = response
    const requestId = requestIdOf(response.headers)
    if (status < 200 || status >= 300) {
      // The body is never read: the status decides, and a vendor's error text may quote the request.
      await response.body?.cancel().catch(() => undefined)
      const cause = classifyAudioStatus(status)
      const retryAfterMs =
        cause.code === 'RATE_LIMIT'
          ? parseRetryAfter(response.headers.get('retry-after'), this.#clock())
          : undefined
      const failure = failureEvent(cause.code, cause.retryable, { status, retryAfterMs, requestId })
      return cause.zeroUsage ? [zeroUsageEvent(status, requestId), failure] : [failure]
    }
    try {
      const text = await this.#readResult(response, payload, req.model, signal)
      if (signal.aborted) return [interrupted()]
      return [
        ...(text === '' ? [] : [{ type: 'text_delta' as const, delta: text }]),
        {
          type: 'usage',
          tokens: { input: openAiAudioUnits(payload) ?? 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          // Credits are the facade's to work out, from the catalogue price.
          creditSource: 'estimated',
          response: { status, ...(requestId === undefined ? {} : { id: requestId }), model: req.model },
        },
        { type: 'done', reason: 'stop' },
      ]
    } catch (error) {
      if (signal.aborted || !(error instanceof WireFailure)) return [interrupted()]
      // A stream that ended early is the connection's fault and worth asking again; a reply that
      // cannot be used is the vendor's and is not.
      return [failureEvent(error.code, error.code === 'TRANSPORT')]
    }
  }

  /** A successful reply as the text the call returns: a transcript, or the speech as base64. */
  async #readResult(
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
