import type {
  AiErrorCode,
  CountResult,
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
}
