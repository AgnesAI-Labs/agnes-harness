import type { RequestBody } from '@agnes/protocol'
import type { WireEvent } from '../../adapter.js'
import type { Classified } from '../payload-wire.js'
import {
  type PayloadAdapterOptions,
  type PayloadRequest,
  PayloadWireAdapter,
} from '../payload-wire-adapter.js'
import {
  answersText,
  classifyStatus,
  endpointFor,
  generationId,
  JEV_WIRE_API,
  type JevPayload,
  MAX_ERROR_BYTES,
  MAX_RESPONSE_BYTES,
  parseReply,
  readCapped,
  readHead,
  readPayload,
  vendorBody,
} from './wire.js'

export { JEV_WIRE_API }
/** Recorded with every side call, so a change in what goes on the wire can be told apart in the audit. */
export const JEV_ADAPTER_VERSION = '1.0.0'

/**
 * How long an idle pooled connection is kept. The questions of one decision loop are a few seconds
 * apart, and the pool's own default (a few seconds) would close the connection between them and pay
 * a new handshake each time. A hint from the server still takes precedence.
 */
const KEEP_ALIVE_MS = 60_000

export type JevAdapterOptions = PayloadAdapterOptions

/**
 * Answers a `{state, questions}` payload with TypeSafe System One, over `POST <baseUrl>/systemone`.
 *
 * It sends exactly one HTTP request per call and never retries: a rate limit comes back as a
 * retryable error carrying the vendor's wait, and the caller decides whether to ask again, as a new
 * call. Redirects are refused so the key cannot be sent anywhere else, a reply is capped at 1 MiB,
 * and no error message quotes the reply, the key or the vendor's account fields.
 */
export class JevAdapter extends PayloadWireAdapter<JevPayload> {
  override readonly version = JEV_ADAPTER_VERSION

  constructor(opts: JevAdapterOptions) {
    super({ api: JEV_WIRE_API, target: endpointFor, keepAliveMs: KEEP_ALIVE_MS }, opts)
  }

  protected readPayload(req: RequestBody): JevPayload | string {
    return readPayload(req)
  }

  protected prepare(url: URL, req: RequestBody, payload: JevPayload): PayloadRequest {
    const body = vendorBody(req.model, payload)
    return {
      url: url.href,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
      report: JSON.parse(body),
    }
  }

  protected async classify(response: Response, signal: AbortSignal): Promise<Classified> {
    return classifyStatus(response.status, await readHead(response, MAX_ERROR_BYTES, signal))
  }

  protected requestIdOf(headers: Headers): string | undefined {
    return generationId(headers)
  }

  protected async read(
    response: Response,
    _payload: JevPayload,
    ctx: { signal: AbortSignal; requestId: string | undefined },
  ): Promise<WireEvent[]> {
    const reply = parseReply(await readCapped(response, MAX_RESPONSE_BYTES, ctx.signal))
    const id = reply.id ?? ctx.requestId
    return [
      { type: 'text_delta', delta: answersText(reply.answers) },
      {
        type: 'usage',
        tokens: { input: reply.inputTokens, output: reply.outputTokens, cacheRead: 0, cacheWrite: 0 },
        // Credits are the facade's to work out, from the vendor's dollars or the catalogue price.
        creditSource: 'estimated',
        ...(reply.usdMicros === undefined
          ? {}
          : { billing: { usdMicros: reply.usdMicros, source: 'gateway', subscription: false } }),
        response: { status: response.status, ...(id === undefined ? {} : { id }), model: reply.model },
      },
      { type: 'done', reason: 'stop' },
    ]
  }
}
