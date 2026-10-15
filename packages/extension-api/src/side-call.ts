import type { AiErrorCode, Billing, JsonValue, RequestBody, TokenCounts } from '@agnes/protocol'

/**
 * Where a side call goes. It must name a route and model in the assembled catalog; a slot name is
 * not accepted.
 */
export type SideCallTarget = Readonly<{ route: string; model: string }>

/**
 * What a loop asks of one side model call. Core sends it as written: no main system prompt, no
 * conversation history and no untrusted envelope. An out-of-range option is refused at `prepare`,
 * never truncated.
 */
export interface SideCallOptions {
  /** Plugin-chosen purpose tag recorded with the call, for example `sample.decide`. Matches `/^[a-z][a-z0-9._-]{0,63}$/`. */
  label: string
  target: SideCallTarget
  /** Deadline for the whole call, raced by Core. 100 to 120000 milliseconds, default 10000. */
  deadlineMs?: number
  /** Sent as is. At most 1 MiB (the request schema limit). */
  system?: string
  /**
   * Only `user` and `assistant` messages are allowed; an assistant message carries no `toolCalls`
   * and a `tool_result` block is refused. An image requires a target model that declares image input.
   */
  messages?: RequestBody['messages']
  /** Structured payload handed to the adapter unchanged as `RequestBody.payload`. At most 1 MiB of canonical JSON. */
  payload?: JsonValue
  sampling?: RequestBody['sampling']
  /** `'json'` makes Core parse the returned text into a `JsonValue`. Default `'text'`. */
  output?: 'text' | 'json'
  /**
   * Stable id; the effect id is `side:<invocationId>`. Matches `/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,122}$/`
   * and must not look like a credential. Core generates one when it is omitted.
   */
  invocationId?: string
}

declare const preparedSideCall: unique symbol

/**
 * A validated, frozen call that is ready to send. It belongs to the `LoopContext` that prepared it
 * and to that turn; another context or turn is refused at `invoke`.
 */
export type PreparedSideCall = Readonly<{
  invocationId: string
  label: string
  target: Readonly<{ route: string; model: string }>
  /**
   * Identity of the adapter behind the target, for audit. `null` when the provider publishes no
   * identity. Built-in adapters have one too.
   */
  adapter: Readonly<{ id: string; version: string | null; api: string; endpointHost: string | null }> | null
  deadlineMs: number
  /** SHA-256 of the canonical JSON of `{label, target, system, messages, payload, sampling, output, deadlineMs}`. */
  requestHash: string
  estimate: Readonly<{
    inputTokens: number
    source: 'provider' | 'estimate'
    projectedCredits: number | null
    contextWindow: number | null
  }>
}> & { readonly [preparedSideCall]: true }

export type SideCallUsage = Readonly<{
  tokens: TokenCounts
  credits: number
  creditSource: 'gateway' | 'estimated'
  /**
   * The price the vendor reported for this call, in whole micro-dollars. Present when the adapter
   * reported billing; otherwise credits are the facade's estimate from the catalog price.
   */
  billing?: Billing
  timing?: Readonly<{ ttftMs?: number; durationMs?: number }>
}>

export type SideCallFailure = 'deadline' | 'cancelled' | 'adapter-error' | 'invalid-output'

/**
 * The outcome of `invoke`. Adapter errors, an expired deadline, a cancellation and unusable output
 * come back as `failed`; they are not thrown. Core never retries: a loop that wants another try
 * calls again with a new `invocationId`.
 */
export type SideCallResult =
  | Readonly<{
      status: 'ok'
      invocationId: string
      text: string
      json?: JsonValue
      usage: SideCallUsage
      latencyMs: number
      response?: Readonly<{ id?: string; model?: string }>
      /** True when this is the recorded result of an earlier call with the same `invocationId`. */
      replayed: boolean
    }>
  | Readonly<{
      status: 'failed'
      invocationId: string
      reason: SideCallFailure
      code?: AiErrorCode
      /** `deadline` is retryable; `cancelled` and `invalid-output` are not; `adapter-error` follows the adapter's own flag. */
      retryable: boolean
      dispatch: 'not-sent' | 'may-have-sent'
      /** Present when a cost row was written; an estimate (`creditSource: 'estimated'`) when no usage was observed. */
      usage?: SideCallUsage
      latencyMs: number
      replayed: boolean
    }>
  /** The process stopped before the outcome was recorded; the call may or may not have reached the vendor. */
  | Readonly<{ status: 'unknown'; invocationId: string; reason: 'interrupted'; replayed: boolean }>
  /** Nothing was written: no intent row, no cost row, no adapter call. */
  | Readonly<{ status: 'refused'; invocationId: string; reason: 'budget' | 'usage-unrecorded' }>

export type SideCallStatus =
  | Readonly<{ status: 'absent'; invocationId: string }>
  | Readonly<{ status: 'in-flight'; invocationId: string }>
  | Readonly<{
      status: 'finished'
      invocationId: string
      label: string
      requestHash: string
      result: SideCallResult
    }>

/**
 * Side model calls: a one-off model request to a chosen route and model, outside the main
 * conversation and its context. Two steps, so a loop can check the estimate before it spends.
 *
 * Errors are thrown before anything is written, so a throw means nothing was recorded:
 * - `prepare` throws `E_ENVELOPE` (`detail.reason`: `label`, `deadline`, `payload-size`, `messages`,
 *   `image-input` or `invocation-id`) for an out-of-range option, and `E_MODEL_UNKNOWN`
 *   (`target-unknown`) when the target is not in the provider's catalog.
 * - `prepare` and `invoke` throw `E_RELATION` (`no-turn`) outside an open turn.
 * - `invoke` throws `E_REQUEST_FROZEN` for a call prepared by another context or turn (`foreign`,
 *   `turn`) or when the catalog record or adapter identity changed after `prepare`
 *   (`target-changed`); `E_RELATION` when the `invocationId` already has a record with a different
 *   `requestHash` (`invocation-reused`) or is running in this process (`invocation-in-flight`); and
 *   `E_LANE_BUSY` (`CONTROL_PAUSED`) while the session is paused; the prepared call is not
 *   consumed and can be invoked again.
 * - Every method throws `E_CLOSED` once the session is closing or the loop's execution scope was
 *   revoked.
 *
 * Calls may run concurrently within a turn. A turn cannot finish while one is still unsettled
 * (`E_RELATION`, `side-call-in-flight`).
 */
export interface LoopSideCallPort {
  prepare(options: SideCallOptions): Promise<PreparedSideCall>
  invoke(prepared: PreparedSideCall, signal: AbortSignal): Promise<SideCallResult>
  status(invocationId: string): Promise<SideCallStatus>
}
