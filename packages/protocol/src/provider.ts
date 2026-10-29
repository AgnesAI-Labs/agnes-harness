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
//
// `describeRoute` is optional too. It names the adapter and endpoint that would serve a route and
// model: the adapter identity and wire API, the endpoint host only (never a path or credentials), and
// a digest of the full routing configuration. The host is what an audit row records; the digest lets a
// caller detect, between two calls, that the same route name now resolves to a different target
// without the base URL itself ever leaving the provider. An implementation without it, or one that
// does not know the route, returns undefined.
//
// `audio` is optional as well: the payload facts of the payload-only audio adapter, for a caller that
// must check and size a voice payload before it sends one without depending on the AI package. An
// implementation without it serves no voice calls.
export interface Provider {
  /** retry=false disables adapter retries for this call without changing shared defaults. */
  infer(
    req: RequestBody,
    opts: { signal: AbortSignal; toolNames: string[]; retry?: false },
  ): AsyncIterable<InferenceEvent>
  models(): ModelRecord[]
  count?(req: RequestBody, opts: { signal: AbortSignal }): Promise<CountResult>
  describeRoute?(
    route: string,
    model: string,
  ):
    | Readonly<{
        adapter: Readonly<{ id: string; version: string | null }>
        api: string
        endpointHost: string | null
        routeDigest: string
      }>
    | undefined
  audio?: ProviderAudioFacts | undefined
}

/** The format of a base64 PCM WAV, read from its header; `dataBytes` is the sound after the header. */
export type ProviderWavFacts = Readonly<{
  sampleRate: number
  channels: number
  bits: number
  byteRate: number
  dataBytes: number
}>

export type ProviderAudioFacts = Readonly<{
  /** Undefined when the text is not base64 or does not start with a RIFF/WAVE/PCM header. */
  wav(base64: string): ProviderWavFacts | undefined
  /** The units a payload is accounted in (audio seconds rounded up, or UTF-8 bytes of speech text). */
  units(payload: unknown): number | undefined
}>
