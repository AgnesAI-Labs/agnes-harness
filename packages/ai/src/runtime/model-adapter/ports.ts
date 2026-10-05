import type {
  ActionContext,
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  Outcome,
} from '@agnes/extension-api/runtime'
import type { ModelRecord, RequestBody } from '@agnes/protocol'
import type {
  ActionFrame,
  AttemptRef,
  DataRef,
  EffectResult,
  PreparedModelRequest,
  ReconcileResult,
  UsageMeasurement,
} from '@agnes/protocol/runtime'
import type { ManualRoute } from '../../adapters/pi/index.js'

/** What the host verified about one media plan the request carries; digests only, never bytes. */
export type ModelWireMedia = Readonly<{
  planKey: string
  planDigest: string
  usageIds: readonly string[]
  parts: readonly Readonly<{ kind: 'text' | 'image'; sha256: string }>[]
}>

export type ModelWireSource = Readonly<{
  prepared: PreparedModelRequest
  route: ManualRoute
  model: ModelRecord
  request: RequestBody
  media?: readonly ModelWireMedia[]
}>

/** The original installed owner supplies purpose-bound capabilities, not caller credential JSON. */
export type ModelAdapterDeployment = {
  readonly packageDigest: string
  readonly config: AuthorSchema<EmptyAuthorConfig>
  readonly usage: AuthorSchema<UsageMeasurement>
  readonly usageAuthorityId: string
  /** Selected deployment's legacy credit rate; absent leaves estimated credits unknown. */
  readonly creditsPerUsd?: number
  readonly units: Readonly<{
    input: string
    output: string
    cacheRead: string
    cacheWrite: string
    reasoning: string
  }>
  installed(context: CallContext): boolean
  load(ref: DataRef, frame: ActionFrame, context: ActionContext): Promise<Outcome<ModelWireSource>>
  current(source: ModelWireSource, frame: ActionFrame, context: CallContext): boolean
  /**
   * The host's restricted model egress for this call. Every request goes through the fetch it
   * returns; without one the call is refused before the credential is used. The global fetch is
   * never a fallback.
   */
  egress?(
    source: ModelWireSource,
    frame: ActionFrame,
    context: ActionContext,
  ): typeof globalThis.fetch | undefined
  withCredential<T>(
    source: ModelWireSource,
    frame: ActionFrame,
    context: ActionContext,
    consume: (credential: string | undefined) => Promise<T>,
  ): Promise<Outcome<T>>
  /** Synchronous current permit/credential/egress fence immediately before actual wire fetch. */
  beforeSend(source: ModelWireSource, frame: ActionFrame, context: ActionContext, bodyDigest: string): boolean
  /** Saves complete/partial effects independently of user authorization after the send. */
  save(frame: ActionFrame, result: EffectResult, bodyDigest: string | null): Promise<void>
  lookup(
    frame: ActionFrame,
    evidence: readonly DataRef[],
    context: ActionContext,
    target: AttemptRef | null,
  ): Promise<ReconcileResult>
}
