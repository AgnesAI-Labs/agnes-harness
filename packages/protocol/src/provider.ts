import type {
  AiErrorCode,
  CountResult,
  DecisionModelRecord,
  DecisionWireRequest,
  DecisionWireResult,
  InferenceEvent,
  ModelRecord,
  RequestBody,
  SlotName,
} from '../gen/ts/model.js'

// The two closed sets model.json spells as enums, restated once as runtime tuples so callers can
// iterate them (a doctor listing every slot, an error-code mapping table) without reaching into a
// generated TypeBox union. `satisfies` pins every element to a real member; test/model-schema.test.ts
// pins the other direction, that neither tuple is a subset of its enum.
export const AI_ERROR_CODES = [
  'AUTH',
  'RATE_LIMIT',
  'QUOTA',
  'OVERFLOW',
  'TIMEOUT',
  'NO_MODEL',
  'NO_ADAPTER',
  'FORMAT',
  'TRANSPORT',
  'CONTRACT_MISMATCH',
  'ABORTED',
] as const satisfies readonly AiErrorCode[]

export const SLOT_NAMES = [
  'primary',
  'escalation',
  'fast',
  'compaction',
  'verifier',
  'image',
  'video',
] as const satisfies readonly SlotName[]

// The decision slot is deliberately not a member of SlotName. Every chat-slot consumer - the CLI
// `--model <slot>=` flag, the TUI `/model`, RequestBody.slot, the inference entry - is typed on
// SlotName and so excludes it without a filter of its own. Only the route table names it.
export type DecisionSlot = 'decision'
export type RouteSlotName = SlotName | DecisionSlot

// What `Provider.decide` rejects with. It is a structural shape so the caller can read it without
// importing the implementing package: `kind` is the whole contract, `code` says which failure it
// was, `route` which decision route was being called when there was one.
export type DecisionFailureKind = 'invalid' | 'timeout' | 'unavailable'
export type DecisionFailure = Readonly<{ kind: DecisionFailureKind; code: AiErrorCode; route?: string }>

// The model-layer seam: exactly one implementation is fitted per assembled session, and the kernel
// calls it every step. It lives here rather than beside its implementation because both sides of the
// seam — the caller that fits it and the package that implements it — must agree on one declaration,
// and this package is the only one both of them may depend on. It carries methods, so it is written
// by hand instead of being generated from a data schema.
//
// `infer` takes the plain request shape, not a branded one: the brand that marks a request as having
// gone through the single derivation point belongs to the package that mints it and does not travel
// across this boundary, or no other package could construct a request at all — including in tests.
//
// `count` is optional. An implementation without it, or one answering `{ source: 'unsupported' }` for
// the route in hand, means the caller falls back to its own estimate rather than failing the turn.
export interface Provider {
  /** retry=false disables adapter retries for this call without changing shared defaults. */
  infer(
    req: RequestBody,
    opts: { signal: AbortSignal; toolNames: string[]; retry?: false },
  ): AsyncIterable<InferenceEvent>
  models(): ModelRecord[]
  count?(req: RequestBody, opts: { signal: AbortSignal }): Promise<CountResult>
  /**
   * Present only when the assembly fitted a decision adapter. Resolves `req.route`/`req.model`
   * against the decision catalogue - the caller fills them from the session's current preset on
   * every call, as it does for a chat request - calls the adapter within `req.timeoutMs`, and
   * returns priced answers that have passed an envelope check only; the answers themselves are the
   * caller's to validate. Failures reject with a DecisionFailure-shaped error.
   */
  decide?(req: DecisionWireRequest, opts: { signal: AbortSignal }): Promise<DecisionWireResult>
  /**
   * The decision catalogue, present together with `decide`. `models()` stays chat-only, so a caller
   * that needs a decision model's context window or price for a pre-check reads it here.
   */
  decisionModels?(): DecisionModelRecord[]
}
