import type { EventEnvelope, JsonValue, SystemInput } from '@agnes/protocol'
import type { Seq, SessionRef } from './common.js'
import type { DecisionPort } from './decisions.js'
import type { ProjectionReader } from './projections.js'
import type { ProviderIdentity, ProviderKind } from './provider-kind.js'

/** Host-admitted identity. Selectors and authority flags on the original session are not copied. */
export interface ServiceBinding {
  readonly owner: string
  readonly packageId: string
  readonly generationId?: string
  readonly session?: Pick<SessionRef, 'key' | 'lane' | 'workspaceRoot'>
  readonly taskId?: string
  readonly signal: AbortSignal
}

export interface OwnerLedgerQuery {
  readonly names: readonly string[]
  readonly limit: number
  readonly cursor?: string
  readonly asOfSeq?: Seq
}

export interface OwnerLedgerPage {
  readonly events: readonly EventEnvelope[]
  readonly asOfSeq: Seq
  readonly nextCursor?: string
}

/** Relative event names only. The host stamps namespace, origin, trust, and lane. */
export interface OwnerLedgerPort {
  scanOwn(query: OwnerLedgerQuery): Promise<OwnerLedgerPage>
  appendOwn(name: string, data: JsonValue, sourceSeq?: Seq): Promise<Seq>
}

/** Host stamps source, actor, lane, target and trust from the admitted call. */
export interface AgentInputPort {
  deliver(key: string, input: Omit<SystemInput, 'source'>, signal: AbortSignal): Promise<Seq>
}

export type ServicePortName = 'ledger' | 'input' | 'projections' | 'decisions'

export interface ServicePorts {
  readonly decisions?: DecisionPort
  readonly binding: ServiceBinding
  readonly ledger?: OwnerLedgerPort
  readonly input?: AgentInputPort
  readonly projections?: ProjectionReader
  readonly lastSeq?: Seq
  now(): number
}

export interface ServiceInstance {
  dispose?(): void | Promise<void>
}

export interface ServiceProvider<
  S extends ServiceInstance = ServiceInstance,
  P extends ServicePorts = ServicePorts,
> extends ProviderIdentity {
  open(ports: P): S | Promise<S>
  /** Registration-owned resources. Distinct from the instance dispose the binding calls. */
  dispose?(): void | Promise<void>
}

export type ServiceInstanceScope = 'request' | 'session' | 'workspace' | 'process'

const serviceInstance: unique symbol = Symbol('service instance')
const servicePortGrant: unique symbol = Symbol('service port grant')

/** The binding half every bindable kind carries. */
export interface BindOptions {
  readonly cardinality: 'single' | 'multi'
  readonly instanceScope: ServiceInstanceScope
  readonly ports?: readonly ServicePortName[]
}

/**
 * Fields every bindable kind has. Specific kinds are invariant, so maps and binders store this
 * instead of `BindableKind<ServiceInstance, ServicePorts>`.
 */
export interface BindableKindToken {
  readonly kind: string
  readonly cardinality: 'single' | 'multi'
  readonly instanceScope: ServiceInstanceScope
  readonly scope: ProviderKind<ServiceProvider>['scope']
  readonly ports: readonly ServicePortName[]
}

/** `ports` is the maximum grant. A host descriptor may only shrink it. */
export interface BindableKind<
  S extends ServiceInstance = ServiceInstance,
  P extends ServicePorts = ServicePorts,
> extends ProviderKind<ServiceProvider<S, P>>,
    BindableKindToken {
  readonly operations: { readonly register: boolean; readonly bind: true }
  /** Type-only. Carries the instance so register and bindOwn infer S. Not installed at runtime. */
  readonly [serviceInstance]?: S
  /** Type-only. Carries the port grant so register and bindOwn infer P. Not installed at runtime. */
  readonly [servicePortGrant]?: P
}

export interface ServiceBindingPort {
  bindOwn<S extends ServiceInstance, P extends ServicePorts>(kind: BindableKind<S, P>): Promise<S>
}

/**
 * Author facade over the same provider registry. Package identity comes from the loader, and the
 * owner comes from the manifest; the provider cannot pass either.
 */
export interface ServiceAuthorPort extends ServiceBindingPort {
  register<S extends ServiceInstance, P extends ServicePorts>(
    kind: BindableKind<S, P>,
    provider: NoInfer<ServiceProvider<S, P>>,
  ): () => Promise<void>
}
