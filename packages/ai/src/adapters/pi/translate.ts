import type { ToolCall } from '@agnes/protocol'
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
        },
      ]
    }
  }
}
