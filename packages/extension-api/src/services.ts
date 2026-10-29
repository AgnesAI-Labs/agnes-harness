import type { Actor, JsonValue, ServiceCapability } from '@agnes/protocol'
import { validateServiceCapability } from '@agnes/protocol'
import type { Logger, PlatformView } from './common.js'
import type { ToolContext } from './tool.js'

export type { ServiceCapability, ServiceEffectPolicy } from '@agnes/protocol'
export interface SessionChildJobs {
  list(): Promise<readonly import('./child-agent.js').ChildAgentListing[]>
  /** Query services receive no cancellation opening. */
  cancel?(id: string): Promise<void>
}
export interface ServiceContext {
  /** Session-owned read-only resources; each access re-enters current workspace authority. */
  readonly sessionFiles?: ToolContext['sessionFiles']
  /** Host-generated only for a journal-admitted session effect declaring controlLeaseMs. */
  readonly controlGrant?: Readonly<{ grantId: string; expiresAt: number }>
  readonly scope?: Readonly<{ kind: 'profile'; profileId: string; activationId: string }>
  readonly admission?: Readonly<{
    operationId: string
    subjectDigest: string
    prepared: PreparedServiceEffect
    controlGrant?: Readonly<{ grantId: string; expiresAt: number }>
    approval?: ToolContext['approval']
  }>
  /** Server-validated session read scope; this never opens or mutates a conversation. */
  readonly sessionAccess?: { requireRead(sessionId: string): Promise<void> }
  readonly store?: import('./profile-services.js').OwnedStore
  readonly wake?: import('./profile-services.js').SessionWakePort
  readonly childJobs?: SessionChildJobs
  /** Host-bound identity, never caller input. Use session.workspaceRoot for workspace-owned state, policy and config. Non-session services may omit it; refuse identity-dependent operations when absent. */
  readonly session?: import('./common.js').SessionRef
  /** Present only on authorized, journaled effect services. Queries cannot start processes. */
  readonly sandbox?: Pick<ToolContext['sandbox'], 'openProcess'>
  readonly actor: Actor
  readonly source: string
  readonly requestId: string
  /** Execution directory snapshot at the start of this call (or the explicitly requested operation).
   * May differ from workspaceRoot in a future version; use workspaceRoot for workspace-owned state, policy and config.
   * Session defaults currently equal workspaceRoot; explicit process/child overrides do not change workspace identity.
   */
  readonly cwd: string
  readonly exec: ToolContext['exec']
  readonly fs: ToolContext['fs']
  readonly net: ToolContext['net']
  readonly artifacts: ToolContext['artifacts']
  readonly authorize: ToolContext['authorize']
  // Same read-only view a tool gets; services never get sandbox (they do not spawn).
  readonly platform: PlatformView
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly log: Logger
}
export type ServiceDef<
  I extends JsonValue = JsonValue,
  O extends JsonValue = JsonValue,
> = ServiceCapability & {
  /** Pure, bounded preparation under query authority. The Host binds both inputs and revision. */
  prepare?(input: I, ctx: ServiceContext): Promise<PreparedServiceEffect>
  handler(input: I, ctx: ServiceContext): Promise<O>
}
export interface PreparedServiceEffect {
  readonly input: JsonValue
  readonly presentation: JsonValue
  readonly resourceRevision?: string
}
/** Static data contract only; Host compiles schemas and enforces grants before invoking handlers. */
export function checkServiceDef(def: unknown): { ok: true } | { ok: false; problems: string[] } {
  try {
    if (def === null || typeof def !== 'object') throw new Error('object required')
    if (
      Reflect.ownKeys(def).some(
        (key) => typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(def, key) ?? {})),
      )
    )
      throw new Error('data fields required')
    const capability = { ...def } as Record<string, unknown>
    const handler = Object.getOwnPropertyDescriptor(def, 'handler')?.value
    const prepare = Object.getOwnPropertyDescriptor(def, 'prepare')?.value
    if (prepare !== undefined && typeof prepare !== 'function')
      return { ok: false, problems: ['prepare: expected function'] }
    delete capability.prepare
    delete capability.handler
    const checked = validateServiceCapability(capability)
    if (typeof handler !== 'function') return { ok: false, problems: ['handler: expected function'] }
    return checked.ok
      ? { ok: true }
      : { ok: false, problems: checked.errors.map((e) => `${e.path}: ${e.message}`) }
  } catch {
    return { ok: false, problems: ['service: invalid definition'] }
  }
}
