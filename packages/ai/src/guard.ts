import type { AiErrorCode, InferenceEvent } from '@agnes/protocol'

type ErrorEvent = Extract<InferenceEvent, { type: 'error' }>

/**
 * Whether a failure of each kind may be repeated. Ten of the eleven are decided here because they
 * are properties of the failure and not of the moment: an unauthenticated route is unauthenticated
 * on the second attempt too, and a model that does not exist will not exist by the third.
 *
 * `TRANSPORT` is the exception, and the value says so rather than picking a side: whether a
 * transport failure may be repeated depends on which one it was - a 503 may, a refused connection to
 * an endpoint nobody declared may not - and the adapter that saw it is the only layer that knows.
 */
export const RETRYABLE: Record<Exclude<AiErrorCode, 'TRANSPORT'>, boolean> & { TRANSPORT: 'adapter' } = {
  AUTH: false,
  RATE_LIMIT: true,
  QUOTA: false,
  OVERFLOW: false,
  TIMEOUT: true,
  NO_MODEL: false,
  NO_ADAPTER: false,
  FORMAT: false,
  TRANSPORT: 'adapter',
  CONTRACT_MISMATCH: false,
  ABORTED: false,
}

const BACKOFF: Partial<Record<AiErrorCode, number>> = { RATE_LIMIT: 1000, TIMEOUT: 2000, TRANSPORT: 500 }

/** What a caller should do about a code, without having to hold the table itself. */
export function retryHint(code: AiErrorCode): { retryable: boolean; backoffMs: number } {
  const rule = RETRYABLE[code]
  const retryable = rule === 'adapter' ? true : rule
  return { retryable, backoffMs: retryable ? (BACKOFF[code] ?? 500) : 0 }
}

/**
 * One error event, made consistent with itself. Three things are fixed here rather than trusted from
 * below: retryability is clamped to what the code allows, an abort is reported as an abort whatever
 * reason came with it, and a wait is kept only on a failure that may actually be waited out - a
 * `retryAfterMs` attached to a permanent failure is a number that can only be acted on wrongly.
 *
 * The message is bounded. It has already been redacted by the adapter that produced it; the bound is
 * against a far end that answers with a page of text and fills the ledger row with it.
 */
export function normalizeError(e: ErrorEvent): ErrorEvent {
  const rule = RETRYABLE[e.code]
  const retryable = rule === 'adapter' ? e.retryable : rule
  const out: ErrorEvent = {
    type: 'error',
    reason: e.code === 'ABORTED' ? 'aborted' : e.reason,
    code: e.code,
    message: e.message.slice(0, 512),
    retryable,
  }
  if (retryable && e.retryAfterMs !== undefined) out.retryAfterMs = e.retryAfterMs
  if (e.requestId) out.requestId = e.requestId
  return out
}

const fail = (message: string): ErrorEvent => ({
  type: 'error',
  reason: 'error',
  code: 'TRANSPORT',
  message,
  retryable: true,
})

/**
 * The shape of an inference, enforced on the way out. Legal is `sent (delta|toolcall_end|deviation)*
 * usage done`, `sent (…)* error`, or a bare `error` - the last because a failure before anything
 * could be sent is an honest and common answer, not a malformed stream.
 *
 * That last case is why a pre-`sent` error is normalised and forwarded rather than replaced. The
 * three codes that arrive that way - no route, no adapter, no credential - are permanent
 * misconfigurations; replacing them with a retryable transport failure would have the caller wait
 * and try again against a route that cannot answer, and keep doing it until the budget is spent.
 *
 * Nothing throws out of here and nothing survives a terminal event, so a caller that has to write a
 * turn either way always gets exactly one outcome to write.
 */
export async function* guardSequence(source: AsyncIterable<InferenceEvent>): AsyncIterable<InferenceEvent> {
  let seenSent = false
  let seenUsage = false
  let terminal = false
  // A violation seen mid-stream is remembered rather than emitted on the spot: the stream may still
  // end in an error of its own, which is the more useful thing to report.
  let pendingFailure: string | undefined
  try {
    for await (const ev of source) {
      if (terminal) continue
      if (!seenSent) {
        if (ev.type === 'error') {
          yield normalizeError(ev)
          terminal = true
          continue
        }
        if (ev.type !== 'sent') {
          yield fail('missing sent')
          terminal = true
          continue
        }
        seenSent = true
        yield ev
        continue
      }
      if (ev.type === 'sent') {
        yield fail('duplicate sent')
        terminal = true
        continue
      }
      if (ev.type === 'error') {
        yield normalizeError(ev)
        terminal = true
        continue
      }
      if (ev.type === 'done') {
        terminal = true
        // A finished turn with no usage is a turn nobody can account for. It is reported as a
        // failure rather than passed on, because a caller that wrote it as a success would have a
        // completed turn and no cost row for it.
        yield seenUsage && !pendingFailure ? ev : fail(pendingFailure ?? 'done without usage')
        continue
      }
      if (ev.type === 'usage') {
        if (seenUsage) {
          pendingFailure = 'duplicate usage'
          continue
        }
        seenUsage = true
        yield ev
        continue
      }
      if (seenUsage) {
        pendingFailure = 'event after usage'
        continue
      }
      yield ev
    }
    if (!terminal) yield fail(seenSent ? 'stream ended without terminal event' : 'missing sent')
  } catch (e) {
    // The thrown value's own text is not forwarded: it is written by whatever produced the stream
    // and can quote request material.
    if (!terminal) yield fail(`source threw: ${(e as Error).name}`)
  }
}
