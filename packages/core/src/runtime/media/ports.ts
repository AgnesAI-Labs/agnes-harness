import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import type { RequestMediaLimits } from '../../orchestrator/request-media.js'

export type MediaSourceRead = Readonly<{
  blob: W.BlobRef
  bytes: Uint8Array
  /** Retained verbatim in the manifest; a changed version is drift. */
  version: string
  trust: W.ContextItem['trust']
  sourceTool: string
}>

/** Reads media under the caller's current authority; refusal and revocation are `denied`. */
export interface MediaSourceAccess {
  open(ref: W.PublicRef, context: CallContext): Promise<Outcome<MediaSourceRead>>
  /** Synchronous revocation fence: changes whenever source access may have been withdrawn. */
  epoch(context: CallContext): string
}

export type VisionTarget = Readonly<{
  model: W.BindingRef
  route: W.ModelRouteSnapshot
  generation: W.GenerationOptions
  sessionParameterRef: W.DomainReference
  credentialRef: W.SecretHandle | null
  parserVersion: string
  viewSchema: W.SchemaRef
}>
/** Resolves the image-slot target from the current catalog and session parameters. */
export interface VisionTargetSource {
  resolve(context: CallContext, plan: W.MediaPlan): Promise<Outcome<VisionTarget>>
}

export interface MediaDeployment {
  readonly binding: W.BindingRef
  readonly packageDigest: string
  readonly packageVersion?: string
  readonly configSchema: W.SchemaRef
  readonly requires: readonly W.ServiceRequirement[]
  /** agh.state binding used to read child results with `probeActionResult`. */
  readonly state: W.BindingRef
  /** Explicit product limits; there are no defaults. */
  readonly limits: RequestMediaLimits
  readonly sources: MediaSourceAccess
  /** `null` makes conversion unavailable. */
  readonly vision: VisionTargetSource | null
  /** Synchronous current permission for the call. */
  authorize(context: CallContext): boolean
}
