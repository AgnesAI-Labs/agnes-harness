import type { ResponseMeta, ToolCall } from '@agnes/protocol'
import type { Api, AssistantMessageEvent, Model } from '@earendil-works/pi-ai'
import type { WireEvent } from '../../adapter.js'
import { classifyPiError } from './errors.js'

/**
 * One pi event, as zero or more outward events. Twelve kinds arrive and six leave: the bracketing
 * `*_start` / `*_end` pairs carry nothing the caller cannot see from the deltas themselves, and
 * `start` only announces a message that the opening stamp already described.
 *
 * `nextOrdinal` numbers the tool calls of one stream. It is passed in rather than kept here because
 * two streams can be in flight in one process, and a counter shared between them would hand the
 * same call two different numbers depending on interleaving.
 */
export function translateEvent(
  ev: AssistantMessageEvent,
  model: Model<Api>,
  nextOrdinal: () => number,
  wire: ResponseMeta = {},
): WireEvent[] {
  switch (ev.type) {
    case 'start':
    case 'text_start':
    case 'text_end':
    case 'thinking_start':
    case 'thinking_end':
    case 'toolcall_start':
      return []
    case 'text_delta':
      return [{ type: 'text_delta', delta: ev.delta }]
    case 'thinking_delta':
      return [{ type: 'thinking_delta', delta: ev.delta }]
    case 'toolcall_delta':
      return [{ type: 'toolcall_delta', delta: ev.delta }]
    case 'toolcall_end':
      return [
        {
          type: 'toolcall_end',
          call: {
            toolUseId: ev.toolCall.id,
            name: ev.toolCall.name,
            // Pi's JSON arrays are readonly at the type boundary; protocol consumers only read them.
            args: ev.toolCall.arguments as ToolCall['args'],
            ordinal: nextOrdinal(),
          },
        },
      ]
    case 'done': {
      const u = ev.message.usage
      // Tokens only. What they cost is priced one layer up, where the deployment's own credit rate
      // is known - an adapter pricing from the catalogue alone would produce a number in dollars for
      // a column that may not be denominated in dollars. `estimated` says a gateway did not bill it.
      const usage: WireEvent = {
        type: 'usage',
        tokens: {
          input: u.input,
          output: u.output,
          cacheRead: u.cacheRead,
          cacheWrite: u.cacheWrite,
          ...(u.reasoning !== undefined ? { reasoning: u.reasoning } : {}),
        },
        creditSource: 'estimated',
        ...withResponse(wire, ev.message.responseId, ev.message.responseModel),
      }
      // A deferred answer is not a finish this package can express yet; it reads as a stop, which is
      // the closest honest reading until the deferred path exists.
      const reason = ev.reason === 'length' ? 'length' : ev.reason === 'toolUse' ? 'toolUse' : 'stop'
      return [usage, { type: 'done', reason }]
    }
    case 'error': {
      // The window comes from the model this request actually went to. Passing nothing here left one
      // arm of the classification with a single supplier - a test - and unreachable for a user: an
      // overflow the provider did not spell out is only visible against the declared window.
      const c = classifyPiError(ev.error, model.contextWindow)
      return [
        {
          type: 'error',
          reason: ev.reason === 'aborted' ? 'aborted' : 'error',
          code: c.code,
          message: c.message,
          retryable: c.retryable,
          ...(c.retryAfterMs !== undefined ? { retryAfterMs: c.retryAfterMs } : {}),
          ...(ev.error.responseId ? { requestId: ev.error.responseId } : {}),
          ...withResponse(wire, ev.error.responseId, ev.error.responseModel),
        },
      ]
    }
  }
}

// Header values recorded verbatim. Every other header is recorded by name only: a value can be a
// cookie, a token or an account id, while a name - a local proxy's `x-litellm-*`, say - is the signal
// that tells a reviewer which hop actually answered.
const HEADER_VALUES = new Set([
  'x-request-id',
  'request-id',
  'server',
  'via',
  'cf-ray',
  'openai-processing-ms',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'retry-after',
  'retry-after-ms',
])

/** What the HTTP response itself says about who answered: status, allowlisted values, all names. */
export function responseMeta(res: Response): ResponseMeta {
  const names = [...new Set([...res.headers.keys()].map((n) => n.toLowerCase().slice(0, 128)))].sort()
  const headers: Record<string, string> = {}
  for (const name of names) {
    const value = HEADER_VALUES.has(name) ? res.headers.get(name) : null
    if (value !== null) headers[name] = value.slice(0, 256)
  }
  return {
    status: res.status,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(names.length > 0 ? { headerNames: names.slice(0, 64) } : {}),
  }
}

/** The `response` member of a usage or error event, or nothing when nothing was learned. */
export function withResponse(wire: ResponseMeta, id?: string, model?: string): { response?: ResponseMeta } {
  const response: ResponseMeta = {
    ...wire,
    ...(id ? { id: id.slice(0, 128) } : {}),
    ...(model ? { model: model.slice(0, 256) } : {}),
  }
  return Object.keys(response).length > 0 ? { response } : {}
}
