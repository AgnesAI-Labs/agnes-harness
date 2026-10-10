import type { EventEnvelope, JsonValue } from '@agnes/protocol'
import type { Seq, SessionRef } from './common.js'
import type { ProjectionReader } from './projections.js'
import {
  defineProviderKind,
  type ProviderIdentity,
  type ProviderKind,
  type ProviderLifecycleScope,
} from './provider-kind.js'

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

/** Actor, lane, target, and trust come from the admitted call, not from arguments. */
export interface AgentInputPort {
  deliver(key: string, text: string, signal: AbortSignal): Promise<Seq>
}

export type ServicePortName = 'ledger' | 'input' | 'projections'

export interface ServicePorts {
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

/** `ports` is the maximum grant. A host descriptor may only shrink it. */
export interface ServiceKind<
  S extends ServiceInstance = ServiceInstance,
  P extends ServicePorts = ServicePorts,
> extends ProviderKind<ServiceProvider<S, P>> {
  readonly cardinality: 'single' | 'multi'
  readonly instanceScope: ServiceInstanceScope
  readonly ports: readonly ServicePortName[]
}

export interface ServiceKindOptions<S extends ServiceInstance, P extends ServicePorts> {
  readonly kind: string
  readonly cardinality: 'single' | 'multi'
  readonly instanceScope: ServiceInstanceScope
  readonly ports?: readonly ServicePortName[]
  readonly scope?: ProviderLifecycleScope
  readonly versioned?: boolean
  readonly validate?: (provider: ServiceProvider<S, P>) => void
  readonly capabilities?: (provider: ServiceProvider<S, P>) => readonly string[]
}

const PORTS: readonly ServicePortName[] = ['ledger', 'input', 'projections']
const INSTANCE_SCOPES: readonly ServiceInstanceScope[] = ['request', 'session', 'workspace', 'process']

export function defineServiceKind<S extends ServiceInstance, P extends ServicePorts>(
  options: ServiceKindOptions<S, P>,
): ServiceKind<S, P> {
  const ports = Object.freeze([...(options.ports ?? [])])
  if (
    (options.cardinality !== 'single' && options.cardinality !== 'multi') ||
    !INSTANCE_SCOPES.includes(options.instanceScope) ||
    new Set(ports).size !== ports.length ||
    ports.some((port) => !PORTS.includes(port))
  )
    throw new TypeError('Invalid service kind')
  const kind = defineProviderKind<ServiceProvider<S, P>>({
    kind: options.kind,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.versioned === undefined ? {} : { versioned: options.versioned }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    validate(provider) {
      if (typeof provider?.open !== 'function') throw new Error('service provider requires open')
      options.validate?.(provider)
    },
  })
  // Object spread drops the provider-kind symbol. assign keeps that token on the service kind.
  return Object.freeze(
    Object.assign({}, kind, {
      cardinality: options.cardinality,
      instanceScope: options.instanceScope,
      ports,
    }) as ServiceKind<S, P>,
  )
}

export interface ServiceBindingPort {
  bindOwn<S extends ServiceInstance, P extends ServicePorts>(kind: ServiceKind<S, P>): Promise<S>
}

/**
 * Author facade over the same provider registry. Package identity comes from the loader, and the
 * owner comes from the manifest; the provider cannot pass either.
 */
export interface ServiceAuthorPort extends ServiceBindingPort {
  register<S extends ServiceInstance, P extends ServicePorts>(
    kind: ServiceKind<S, P>,
    provider: ServiceProvider<S, P>,
  ): () => Promise<void>
}
