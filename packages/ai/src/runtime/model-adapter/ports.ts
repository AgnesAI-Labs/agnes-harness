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

export type ModelWireSource = Readonly<{
  prepared: PreparedModelRequest
  route: ManualRoute
  model: ModelRecord
  request: RequestBody
}>

/** The original installed owner supplies purpose-bound capabilities, not caller credential JSON. */
export type ModelAdapterDeployment = {
  readonly packageDigest: string
  readonly config: AuthorSchema<EmptyAuthorConfig>
  readonly usage: AuthorSchema<UsageMeasurement>
  readonly usageAuthorityId: string
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
