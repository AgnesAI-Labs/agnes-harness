import type { Context } from '@agnes/cordis'
import {
  type AgentInputPort,
  type BindableKind,
  type BindableKindToken,
  type DecisionPort,
  EVENT_NAME_PATTERN,
  EXTENSION_ID_PATTERN,
  type OwnerLedgerPort,
  type ProjectionReader,
  type ProjectionReadResult,
  type ProviderCatalogEntry,
  ProviderError,
  type ServiceBinding,
  type ServiceCapability,
  type ServiceInstance,
  type ServicePortName,
  type ServicePorts,
  type ServiceProvider,
} from '@agnes/extension-api'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import { type Actor, type JsonValue, type SystemInput, validateAgainst } from '@agnes/protocol'
import { SystemInput as SystemInputSchema } from '@agnes/protocol/gen/session-v1'
import { ProviderLifetime } from './provider-lifetime.js'
import {
  installProviderRegistry,
  type ProviderRegistry,
  type ProvidersService,
  providerSource,
} from './provider-registry.js'

export type ServiceAudience = 'callback' | 'host' | 'shared'
export type ServiceDelivery = 'next-turn' | 'follow-steer'
export type ServiceDedupeKeys = 'namespaced' | 'exact'

/** Host-owned grant. It can only shrink the kind's declared ports. */
export interface ServiceDescriptor {
  readonly ports: readonly ServicePortName[]
  /** Declared service capabilities required to bind and retain this facade. */
  readonly services?: readonly ServiceCapability[]
  readonly dedupeKeys?: ServiceDedupeKeys
  readonly eventNames?: readonly string[]
  readonly projectionNames?: readonly string[]
  readonly audience?: ServiceAudience
  readonly delivery?: ServiceDelivery
  /** Business dependencies the generic ports do not carry. The host attaches them on every bind. */
  readonly capabilities?: (call: ServiceCall, binding: ServiceBinding) => object
  /** Replaces the caller input factory for this kind, including bindOwn and bindHost. */
  readonly input?: (
    call: ServiceCall,
    binding: ServiceBinding,
    descriptor: ServiceDescriptor,
  ) => AgentInputPort
}

export interface ServiceCall {
  readonly owner: string
  readonly packageId: string
  readonly session?: ServiceBinding['session']
  readonly generationId?: string
  readonly taskId?: string
  readonly signal: AbortSignal
  readonly processKey?: string
  readonly workspaceKey?: string
  readonly watermark?: number
  readonly actor?: Actor
  /**
   * Provider id inside `packageId`. A multi kind requires it and ignores selection.
   * A single kind rejects it and keeps the sole or selected provider.
   */
  readonly providerId?: string
  live(): { readonly owner: string; readonly active: boolean; readonly generationId?: string } | undefined
}

export interface ServicePortFactories {
  decisions?: (call: ServiceCall, binding: ServiceBinding, descriptor: ServiceDescriptor) => DecisionPort
  ledger?: (call: ServiceCall, binding: ServiceBinding, descriptor: ServiceDescriptor) => OwnerLedgerPort
  input?: (call: ServiceCall, binding: ServiceBinding, descriptor: ServiceDescriptor) => AgentInputPort
  projections?: ProjectionReader
  now?: () => number
  /** Live session seq. Falls back to the admission watermark when omitted. */
  lastSeq?: (call: ServiceCall) => number
}

interface InstalledService {
  readonly kind: BindableKindToken
  readonly descriptor: Required<Pick<ServiceDescriptor, 'ports' | 'dedupeKeys' | 'audience' | 'delivery'>> &
    ServiceDescriptor
}

interface OwnerClaim {
  readonly owner: string
  readonly packageId: string
  count: number
}

type Live = ReturnType<ServiceCall['live']>

function closed(kind: string, operation: string, cause?: unknown): ProviderError {
  return new ProviderError('E_PROVIDER_UNAVAILABLE', 'service binding is closed', {
    kind,
    operation,
    ...(cause === undefined ? {} : { cause }),
  })
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function claimKey(kind: string, id: string, version: string): string {
  return `${kind}\0${id}\0${version}`
}

function clean(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

/**
 * One binding runtime for every service kind. There is no cross-callback instance cache: a shared
 * instance would keep the first callback's admission, so each admitted call opens its own instance.
 * `instanceScope` is still required and is the selection key. Process-wide sharing stays inside the
 * feature that already reference-counts that resource.
 */
export class ServiceBindings {
  private readonly installed = new Map<string, InstalledService>()
  private readonly admittedOpens = new WeakMap<object, object>()
  private readonly claims = new Map<string, OwnerClaim>()
  private readonly registries = new WeakMap<Context, Map<object, unknown>>()
  constructor(private readonly current: () => ProvidersService) {}

  install<S extends ServiceInstance, P extends ServicePorts>(
    ctx: Context,
    kind: BindableKind<S, P>,
    descriptor: ServiceDescriptor,
    origins?: RowOriginLookup,
    claimPublic?: (
      context: Context,
      rowId: string,
      source: string,
      provider: ServiceProvider<S, P>,
      register: () => () => Promise<void>,
    ) => () => Promise<void>,
  ): void {
    const existing = this.installed.get(kind.kind)
    if (existing && existing.kind !== kind)
      throw new ProviderError(
        'E_PROVIDER_INVALID',
        `provider token for ${kind.kind} does not match the installed kind`,
        {
          kind: kind.kind,
          operation: 'install',
        },
      )
    // The first descriptor wins. A later tree retries registry install without widening the grant.
    if (!existing) this.installed.set(kind.kind, { kind, descriptor: freezeDescriptor(kind, descriptor) })
    let registry!: ProviderRegistry<ServiceProvider<S, P>>
    registry = installProviderRegistry(ctx, kind, (owner, source, provider) => {
      const verified = providerSource(owner, origins, source)
      const register = () =>
        registry.register(verified, provider, owner, async () => {
          await provider.dispose?.()
        })
      for (let fiber = owner.fiber; fiber !== fiber.parent.fiber; fiber = fiber.parent.fiber) {
        const origin = origins?.lookup(fiber)
        if (!origin) continue
        if (origin.packageId !== verified && origin.ownerPackage !== verified)
          throw closed(kind.kind, 'register')
        return claimPublic ? claimPublic(owner, origin.rowId, verified, provider, register) : register()
      }
      return register()
    })
    const registries = this.registries.get(ctx) ?? new Map()
    registries.set(kind, registry)
    this.registries.set(ctx, registries)
  }

  /** Host holds the registry; author registration still refuses host-owned kinds. */
  registerHost<S extends ServiceInstance, P extends ServicePorts>(
    ctx: Context,
    kind: BindableKind<S, P>,
    provider: ServiceProvider<S, P>,
    source: string,
  ): () => Promise<void> {
    const registry = this.registries.get(ctx)?.get(kind)
    if (!registry || kind.authority !== 'host') throw closed(kind.kind, 'register')
    // Public provider resolution must never turn a factory into an ungranted open capability.
    const guarded: ServiceProvider<S, P> = {
      ...provider,
      id: provider.id,
      version: provider.version,
      open: (ports) => {
        if (this.admittedOpens.get(ports?.binding) !== kind) throw closed(kind.kind, 'open')
        this.admittedOpens.delete(ports.binding)
        return provider.open(ports)
      },
    }
    // The exact invariant token above owns the registry installed with S and P.
    return (registry as ProviderRegistry<ServiceProvider<S, P>>).register(source, guarded, ctx)
  }

  noteOwner(kind: string, id: string, version: string, owner: string, packageId: string): void {
    if (!EXTENSION_ID_PATTERN.test(owner) || !clean(packageId)) throw closed(kind, 'register')
    const key = claimKey(kind, id, version)
    const existing = this.claims.get(key)
    if (existing && (existing.owner !== owner || existing.packageId !== packageId))
      throw closed(kind, 'register')
    if (existing) {
      existing.count += 1
      return
    }
    this.claims.set(key, { owner, packageId, count: 1 })
  }

  forget(kind: string, id: string, version: string): void {
    const key = claimKey(kind, id, version)
    const existing = this.claims.get(key)
    if (!existing) return
    existing.count -= 1
    if (existing.count <= 0) this.claims.delete(key)
  }

  /** Events and projection names the installed descriptor still grants. Absent until install. */
  grants(kind: string):
    | {
        readonly events: boolean
        readonly projections: readonly string[]
        readonly services?: readonly ServiceCapability[]
      }
    | undefined {
    const installed = this.installed.get(kind)
    if (!installed) return undefined
    return Object.freeze({
      events: (installed.descriptor.eventNames?.length ?? 0) > 0,
      ...(installed.descriptor.services?.length ? { services: installed.descriptor.services } : {}),
      projections: Object.freeze([...(installed.descriptor.projectionNames ?? [])]),
    })
  }

  /** One package for this owner. Mixed packages fail closed instead of picking one. */
  claimPackage(kind: string, owner: string): string | undefined {
    const packages = new Set<string>()
    for (const [key, claim] of this.claims) {
      if (!key.startsWith(`${kind}\0`) || claim.owner !== owner) continue
      packages.add(claim.packageId)
    }
    if (packages.size !== 1) return undefined
    return [...packages][0]
  }

  async bind<S extends ServiceInstance, P extends ServicePorts>(
    kind: BindableKind<S, P>,
    call: ServiceCall,
    factories: ServicePortFactories,
  ): Promise<S> {
    const installed = this.installed.get(kind.kind)
    if (!installed || installed.kind !== kind)
      throw new ProviderError(
        'E_PROVIDER_INVALID',
        `provider token for ${kind.kind} does not match the installed kind`,
        {
          kind: kind.kind,
          operation: 'bind',
        },
      )
    assertCall(kind, call)
    const descriptor = installed.descriptor
    const provider = this.choose(kind, call, descriptor)
    const selection = { provider: provider.id, version: provider.version }
    const lease = this.current().lease(kind, selection)
    const binding = snapshot(call)
    const lifetime = new ProviderLifetime(kind.kind, provider.id)
    let disposeOnce: Promise<void> | undefined
    const readLive = (): Live => {
      try {
        return call.live()
      } catch {
        return undefined
      }
    }
    const open = (live: Live): boolean => {
      if (disposeOnce || lifetime.signal.aborted || call.signal.aborted) return false
      try {
        if (this.current().lease(kind, selection) !== lease) return false
      } catch {
        return false
      }
      if (!live?.active || live.owner !== call.owner) return false
      return binding.generationId === undefined || live.generationId === binding.generationId
    }
    const enter = (operation: string): void => {
      if (!open(readLive())) throw closed(kind.kind, operation)
    }
    const grants = new Set(descriptor.ports)
    if (grants.has('ledger') && call.watermark === undefined) throw closed(kind.kind, 'bind')
    if (grants.has('input') && !call.actor?.id) throw closed(kind.kind, 'bind')
    const ports = buildPorts(kind, call, binding, descriptor, factories, grants, enter, lifetime)
    if (!open(readLive())) throw closed(kind.kind, 'bind')
    // A service instance may own a `then` method. Awaiting the open result would adopt that method
    // and never settle. Only a real Promise is waited on, and its fulfillment is kept inside a
    // plain holder so the instance itself is never resolved as a thenable.
    if (kind.authority === 'host') this.admittedOpens.set(binding, kind)
    let opened: S | Promise<S>
    try {
      opened = provider.open(ports as P)
    } finally {
      this.admittedOpens.delete(binding)
    }
    const raw = (
      await new Promise<{ value: unknown }>((resolve, reject) => {
        try {
          if (opened instanceof Promise) opened.then((value) => resolve({ value }), reject)
          else resolve({ value: opened })
        } catch (error) {
          reject(error)
        }
      })
    ).value
    if (!open(readLive()) || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
      try {
        await disposeRaw(raw)
      } catch (cause) {
        throw closed(kind.kind, 'bind', cause)
      }
      throw closed(kind.kind, 'bind')
    }
    return facade(
      raw as S,
      lifetime,
      enter,
      () => disposeOnce,
      (promise) => {
        disposeOnce = promise
      },
    )
  }

  private choose<S extends ServiceInstance, P extends ServicePorts>(
    kind: BindableKind<S, P>,
    call: ServiceCall,
    descriptor: InstalledService['descriptor'],
  ): ServiceProvider<S, P> {
    if (kind.cardinality === 'single' && call.providerId !== undefined) throw closed(kind.kind, 'bind')
    const scope = serviceBindingScope(kind, call)
    let providers: ProvidersService
    try {
      providers = this.current()
    } catch (cause) {
      throw closed(kind.kind, 'bind', cause)
    }
    // Disposal drops the Cordis service. A missing registry is a closed binding, not a TypeError.
    if (!providers?.catalog) throw closed(kind.kind, 'bind')
    const owned = providers
      .catalog()
      .filter((entry) => entry.kind === kind.kind && owns(entry, call, descriptor, this.claims, kind))
    if (kind.cardinality === 'multi') {
      const id = call.providerId
      if (!clean(id)) throw closed(kind.kind, 'bind')
      const matches = owned.filter((entry) => entry.id === id)
      const chosen = matches.length === 1 ? matches[0] : undefined
      if (!chosen) throw closed(kind.kind, 'bind')
      return providers.resolve(kind, { provider: chosen.id, version: chosen.version })
    }
    const selected = owned.filter((entry) => entry.selectedFor.includes(scope))
    const chosen =
      selected.length === 1 ? selected[0] : selected.length === 0 && owned.length === 1 ? owned[0] : undefined
    if (!chosen) throw closed(kind.kind, 'bind')
    return providers.resolve(kind, { provider: chosen.id, version: chosen.version })
  }
}

export function serviceBindingScope(
  kind: Pick<BindableKind, 'kind' | 'instanceScope'>,
  call: ServiceCall,
): string {
  let identity = 'request'
  if (kind.instanceScope === 'session')
    identity = `${call.generationId}\0${call.session?.key}\0${call.session?.lane}`
  else if (kind.instanceScope === 'workspace') identity = call.workspaceKey ?? ''
  else if (kind.instanceScope === 'process') identity = call.processKey ?? ''
  return `binding:${kind.kind}:${identity}`
}

function owns(
  entry: ProviderCatalogEntry,
  call: ServiceCall,
  descriptor: InstalledService['descriptor'],
  claims: ReadonlyMap<string, OwnerClaim>,
  kind: BindableKindToken & {
    readonly authority?: string
    readonly operations?: { readonly register: boolean }
  },
): boolean {
  if (descriptor.audience === 'shared')
    return kind.authority === 'host' && kind.operations?.register === false
  if (entry.sourcePackage !== call.packageId) return false
  if (descriptor.audience === 'host') return true
  const claim = claims.get(claimKey(entry.kind, entry.id, entry.version))
  return claim?.owner === call.owner && claim.packageId === call.packageId
}

function assertCall(kind: BindableKindToken, call: ServiceCall): void {
  if (!EXTENSION_ID_PATTERN.test(call.owner) || !clean(call.packageId)) throw closed(kind.kind, 'bind')
  if (kind.instanceScope === 'session') {
    const session = call.session
    if (
      !session ||
      !clean(session.key) ||
      !clean(session.lane) ||
      typeof session.workspaceRoot !== 'string' ||
      session.workspaceRoot.includes('\0') ||
      !clean(call.generationId)
    )
      throw closed(kind.kind, 'bind')
  } else if (kind.instanceScope === 'workspace') {
    if (!clean(call.workspaceKey)) throw closed(kind.kind, 'bind')
  } else if (kind.instanceScope === 'process') {
    if (!clean(call.processKey)) throw closed(kind.kind, 'bind')
  }
}

function snapshot(call: ServiceCall): ServiceBinding {
  const session = call.session
    ? Object.freeze({
        key: call.session.key,
        lane: call.session.lane,
        workspaceRoot: call.session.workspaceRoot,
      })
    : undefined
  return Object.freeze({
    owner: call.owner,
    packageId: call.packageId,
    ...(call.generationId === undefined ? {} : { generationId: call.generationId }),
    ...(session === undefined ? {} : { session }),
    ...(call.taskId === undefined ? {} : { taskId: call.taskId }),
    signal: call.signal,
  })
}

function freezeDescriptor(
  kind: BindableKindToken,
  descriptor: ServiceDescriptor,
): InstalledService['descriptor'] {
  const allowed = new Set(kind.ports)
  if (
    descriptor.ports.some((port) => !allowed.has(port)) ||
    new Set(descriptor.ports).size !== descriptor.ports.length
  )
    throw new ProviderError('E_PROVIDER_INVALID', 'service descriptor exceeds the kind grant', {
      kind: kind.kind,
      operation: 'install',
    })
  const dedupeKeys = descriptor.dedupeKeys ?? 'namespaced'
  const audience = descriptor.audience ?? 'callback'
  const delivery = descriptor.delivery ?? 'next-turn'
  if (
    (dedupeKeys !== 'namespaced' && dedupeKeys !== 'exact') ||
    (audience !== 'callback' && audience !== 'host' && audience !== 'shared') ||
    (delivery !== 'next-turn' && delivery !== 'follow-steer')
  )
    throw new ProviderError('E_PROVIDER_INVALID', 'service descriptor is invalid', {
      kind: kind.kind,
      operation: 'install',
    })
  const granted = new Set(descriptor.ports)
  const eventNames = Object.freeze([...(descriptor.eventNames ?? [])])
  const projectionNames = Object.freeze([...(descriptor.projectionNames ?? [])])
  if (
    (granted.has('ledger') && eventNames.some((name) => !EVENT_NAME_PATTERN.test(name))) ||
    new Set(eventNames).size !== eventNames.length ||
    (!granted.has('ledger') && eventNames.length > 0) ||
    new Set(projectionNames).size !== projectionNames.length ||
    (!granted.has('projections') && projectionNames.length > 0)
  )
    throw new ProviderError('E_PROVIDER_INVALID', 'service descriptor event name is invalid', {
      kind: kind.kind,
      operation: 'install',
    })
  const capabilities = descriptor.capabilities
  const input = descriptor.input
  if (
    (capabilities !== undefined && typeof capabilities !== 'function') ||
    (input !== undefined && typeof input !== 'function')
  )
    throw new ProviderError('E_PROVIDER_INVALID', 'service descriptor is invalid', {
      kind: kind.kind,
      operation: 'install',
    })
  return Object.freeze({
    ports: Object.freeze([...descriptor.ports]),
    services: Object.freeze(JSON.parse(JSON.stringify(descriptor.services ?? [])) as ServiceCapability[]),
    dedupeKeys,
    audience,
    delivery,
    eventNames,
    projectionNames,
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(input === undefined ? {} : { input }),
  })
}

function namespaceKey(kind: string, owner: string, key: string, mode: ServiceDedupeKeys): string {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\0') || key.length > 256)
    throw closed(kind, 'deliver')
  if (mode === 'exact') return key
  const prefixed = `svc/${kind}/${owner}/${key}`
  if (prefixed.length > 256) throw closed(kind, 'deliver')
  return prefixed
}

function buildPorts(
  kind: BindableKindToken,
  call: ServiceCall,
  binding: ServiceBinding,
  descriptor: InstalledService['descriptor'],
  factories: ServicePortFactories,
  grants: ReadonlySet<ServicePortName>,
  enter: (operation: string) => void,
  lifetime: ProviderLifetime,
): ServicePorts {
  const guard = (operation: string, run: () => unknown) =>
    guardedCall(run, descriptor, [], operation, enter, lifetime)
  let decisions: DecisionPort | undefined
  let ledger: OwnerLedgerPort | undefined
  let input: AgentInputPort | undefined
  let projections: ProjectionReader | undefined
  let capabilities: object | undefined
  if (grants.has('decisions')) {
    if (!factories.decisions) throw closed(kind.kind, 'bind')
    const raw = factories.decisions(call, binding, descriptor)
    decisions = Object.freeze({
      request: (spec: Parameters<DecisionPort['request']>[0]) =>
        guard('decision.request', () => raw.request(spec)) as ReturnType<DecisionPort['request']>,
      get: (handle: Parameters<DecisionPort['get']>[0]) =>
        guard('decision.get', () => raw.get(handle)) as ReturnType<DecisionPort['get']>,
      wait: (handle: Parameters<DecisionPort['wait']>[0], options?: Parameters<DecisionPort['wait']>[1]) =>
        guard('decision.wait', () =>
          raw.wait(handle, {
            signal: AbortSignal.any([
              call.signal,
              lifetime.signal,
              ...(options?.signal ? [options.signal] : []),
            ]),
          }),
        ) as ReturnType<DecisionPort['wait']>,
    })
  }
  if (grants.has('ledger')) {
    if (!factories.ledger) throw closed(kind.kind, 'bind')
    const raw = factories.ledger(call, binding, descriptor)
    ledger = Object.freeze({
      scanOwn: (query: Parameters<OwnerLedgerPort['scanOwn']>[0]) =>
        guard('scan', () => raw.scanOwn(query)) as Promise<Awaited<ReturnType<OwnerLedgerPort['scanOwn']>>>,
      appendOwn: (name: string, data: JsonValue, sourceSeq?: number) =>
        guard('append', () => raw.appendOwn(name, data, sourceSeq)) as Promise<number>,
    })
  }
  if (grants.has('input')) {
    const inputFactory = descriptor.input ?? factories.input
    if (!inputFactory) throw closed(kind.kind, 'bind')
    const raw = inputFactory(call, binding, descriptor)
    input = Object.freeze({
      deliver: (key: string, input: Omit<SystemInput, 'source'>, signal: AbortSignal) =>
        guard('deliver', () => {
          if (!(signal instanceof AbortSignal) || !input || typeof input !== 'object' || 'source' in input)
            throw closed(kind.kind, 'deliver')
          const system = { ...structuredClone(input), source: call.owner }
          if (!validateAgainst(SystemInputSchema, system).ok) throw closed(kind.kind, 'deliver')
          const finalKey = namespaceKey(kind.kind, call.owner, key, descriptor.dedupeKeys)
          const joined = AbortSignal.any([signal, call.signal, lifetime.signal])
          joined.throwIfAborted()
          return raw.deliver(finalKey, system, joined)
        }) as Promise<number>,
    })
  }
  if (descriptor.capabilities) {
    const raw = descriptor.capabilities(call, binding)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw closed(kind.kind, 'bind')
    capabilities = wrapCapabilities(raw, enter, lifetime)
  }
  if (grants.has('projections')) {
    if (!factories.projections) throw closed(kind.kind, 'bind')
    const raw = factories.projections
    const allowed = new Set(descriptor.projectionNames)
    const reader: ProjectionReader = {
      readOwn: <T extends JsonValue>(name: string) =>
        guard('read', () => {
          if (!allowed.has(name))
            return Promise.resolve({
              status: 'unavailable' as const,
              name,
              error: { code: 'E_PROJECTION_STATE' as const, safeMessage: 'projection unavailable' },
            })
          return raw.readOwn<T>(name)
        }) as Promise<ProjectionReadResult<T>>,
    }
    projections = Object.freeze(reader)
  }
  const ports: ServicePorts & { capabilities?: object } = {
    binding,
    ...(decisions === undefined ? {} : { decisions }),
    ...(ledger === undefined ? {} : { ledger }),
    ...(input === undefined ? {} : { input }),
    ...(projections === undefined ? {} : { projections }),
    ...(capabilities === undefined ? {} : { capabilities }),
    now: () => guard('now', () => factories.now?.() ?? Date.now()) as number,
  }
  if (grants.has('ledger')) {
    Object.defineProperty(ports, 'lastSeq', {
      enumerable: true,
      get() {
        return guard('lastSeq', () => factories.lastSeq?.(call) ?? call.watermark) as number
      },
    })
  }
  return Object.freeze(ports)
}

function guardedCall(
  fn: (...args: unknown[]) => unknown,
  thisArg: object,
  args: unknown[],
  operation: string,
  enter: (operation: string) => void,
  lifetime: ProviderLifetime,
): unknown {
  enter(operation)
  let result: unknown
  try {
    result = Reflect.apply(fn, thisArg, args)
  } catch (error) {
    enter(operation)
    throw error
  }
  if (!isPromise(result)) {
    enter(operation)
    return result
  }
  return lifetime.track(
    Promise.resolve(result).then(
      (value) => {
        enter(operation)
        return value
      },
      (error) => {
        enter(operation)
        throw error
      },
    ),
  )
}

/** `typeof fn === 'function'` narrows to `Function`, which this file cannot call. */
function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function'
}

/** Functions re-check admission. One nested object, such as a queue, keeps its original receiver. */
function wrapCapabilities(
  value: object,
  enter: (operation: string) => void,
  lifetime: ProviderLifetime,
): object {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const prop = (value as Record<string, unknown>)[key]
    if (isCallable(prop)) {
      out[key] = (...args: unknown[]) => guardedCall(prop, value, args, key, enter, lifetime)
    } else if (prop && typeof prop === 'object' && !Array.isArray(prop)) {
      const nested: Record<string, unknown> = {}
      for (const method of Object.keys(prop)) {
        const fn = (prop as Record<string, unknown>)[method]
        if (isCallable(fn))
          nested[method] = (...args: unknown[]) => guardedCall(fn, prop, args, method, enter, lifetime)
        else nested[method] = fn
      }
      out[key] = Object.freeze(nested)
    } else out[key] = prop
  }
  return Object.freeze(out)
}

function methodNames(value: object): string[] {
  const names = new Set<string>()
  let current: object | null = value
  while (current && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key === 'constructor' || key === 'then' || key === 'catch' || key === 'dispose') continue
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (!descriptor || descriptor.get || descriptor.set || typeof descriptor.value !== 'function') continue
      names.add(key)
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  return [...names]
}

function facade<S extends ServiceInstance>(
  raw: S,
  lifetime: ProviderLifetime,
  enter: (operation: string) => void,
  current: () => Promise<void> | undefined,
  setDispose: (promise: Promise<void>) => void,
): S {
  const target: Record<string, unknown> = {}
  // Identity fields only. Objects stay on the raw instance so the facade cannot carry authority.
  for (const key of Object.keys(raw)) {
    if (key === 'then' || key === 'catch' || key === 'dispose') continue
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      target[key] = value
  }
  for (const key of methodNames(raw)) {
    const fn = (raw as Record<string, unknown>)[key]
    if (typeof fn !== 'function') continue
    target[key] = (...args: unknown[]) => {
      return guardedCall(fn as (...args: unknown[]) => unknown, raw, args, key, enter, lifetime)
    }
  }
  target.dispose = () => {
    const existing = current()
    if (existing) return existing
    enter('dispose')
    const promise = lifetime.close(() => {
      const dispose = raw.dispose
      return typeof dispose === 'function' ? dispose.call(raw) : undefined
    })
    setDispose(promise)
    return promise
  }
  return Object.freeze(target) as S
}

async function disposeRaw(value: unknown): Promise<void> {
  if (!value || typeof value !== 'object') return
  const dispose = (value as { dispose?: unknown }).dispose
  if (typeof dispose !== 'function') return
  await dispose.call(value)
}
