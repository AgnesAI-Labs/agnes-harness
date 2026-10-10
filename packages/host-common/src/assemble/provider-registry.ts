import { type Context, Service } from '@agnes/cordis'
import type {
  KindMap,
  ProviderCatalogEntry,
  ProviderIdentity,
  ProviderKind,
  ProviderRegistrationPort,
  ProviderSelection,
  ProvidersCatalogPort,
  ServiceInstance,
  ServiceKind,
  ServicePorts,
} from '@agnes/extension-api'
import { ProviderError, parseSemver } from '@agnes/extension-api'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import { HostError } from '../errors.js'

declare module '@agnes/cordis' {
  interface Context {
    providers: ProvidersService
  }
}

export function providerSource(
  ctx: Context,
  origins: RowOriginLookup | undefined,
  fallback: string,
  claimed = false,
): string {
  for (let fiber = ctx.fiber; fiber !== fiber.parent.fiber; fiber = fiber.parent.fiber) {
    const origin = origins?.lookup(fiber)
    if (!origin) continue
    if (origin.trustTier === 'builtin' && origin.packageId === 'builtin') return fallback
    if (claimed && origin.packageId !== fallback)
      throw new HostError('E_EXT_LOAD', 'provider source package does not match its plugin row')
    return origin.packageId
  }
  if (origins && ctx !== ctx.root)
    throw new HostError('E_EXT_LOAD', 'provider requires a verified plugin row')
  return fallback
}

/** Storage and fiber ownership shared by all named provider services. */
export class ProviderRegistry<T extends ProviderIdentity> {
  private readonly entries = new Map<
    string,
    {
      provider: T
      entry: Omit<ProviderCatalogEntry, 'active' | 'selectedFor'>
      dispose?: () => Promise<void>
    }
  >()
  private readonly selections = new Map<string, ProviderSelection>()
  private readonly retiring = new Set<Promise<void>>()
  private disposed = false
  constructor(readonly definition: ProviderKind<T>) {}
  private get label(): string {
    return this.definition.kind === 'model-adapter'
      ? 'model adapter'
      : this.definition.kind === 'compaction'
        ? 'compaction engine'
        : `${this.definition.kind} provider`
  }
  private key(value: ProviderIdentity | ProviderSelection): string {
    const id = 'provider' in value ? value.provider : value.id
    return this.definition.versioned ? `${id}@${value.version}` : id
  }
  register(
    sourcePackage: string,
    provider: T,
    owner?: Context,
    cleanup?: () => void | Promise<void>,
  ): () => Promise<void> {
    const capabilities = this.validate(sourcePackage, provider)
    const key = this.key(provider)
    if (this.entries.has(key))
      throw this.error('E_PROVIDER_DUPLICATE', `duplicate ${this.label}: ${key}`, 'register', provider.id)
    const record: {
      provider: T
      entry: Omit<ProviderCatalogEntry, 'active' | 'selectedFor'>
      dispose?: () => Promise<void>
    } = {
      provider,
      entry: Object.freeze({
        kind: this.definition.kind,
        id: provider.id,
        version: provider.version,
        sourcePackage,
        capabilities: Object.freeze([...capabilities]),
        restartRequired: this.definition.restartRequired,
        scope: this.definition.scope,
      }),
    }
    const mount = () => {
      this.entries.set(key, record)
      let disposal: Promise<void> | undefined
      record.dispose = () => {
        if (disposal) return disposal
        if (this.entries.get(key) !== record) return Promise.resolve()
        this.entries.delete(key)
        for (const [scope, selected] of this.selections)
          if (selected.provider === provider.id && selected.version === provider.version)
            this.selections.delete(scope)
        // Publish the Promise before invoking user cleanup, including reentrant unregister.
        disposal = Promise.resolve().then(() => cleanup?.())
        this.retiring.add(disposal)
        void disposal.then(
          () => this.retiring.delete(disposal!),
          () => this.retiring.delete(disposal!),
        )
        return disposal
      }
      return record.dispose
    }
    if (!owner) return mount()
    owner.effect(mount, `providers.register(${this.definition.kind}:${key})`)
    // Cordis' effect callback is one-shot; the public disposer retains its drain Promise.
    return record.dispose!
  }
  validate(sourcePackage: string, provider: T): readonly string[] {
    if (this.disposed)
      throw this.error(
        'E_PROVIDER_UNAVAILABLE',
        `${this.label} registry is disposed`,
        'register',
        provider?.id,
      )
    if (
      typeof provider?.id !== 'string' ||
      !provider.id.trim() ||
      typeof provider.version !== 'string' ||
      !parseSemver(provider.version) ||
      typeof sourcePackage !== 'string' ||
      !sourcePackage.trim()
    )
      throw this.error(
        'E_PROVIDER_INVALID',
        `invalid ${this.label} registration: id, semver version and source package are required`,
        'register',
        provider?.id,
      )
    let capabilities: readonly string[]
    try {
      this.definition.validate(provider)
      capabilities = this.definition.capabilities?.(provider) ?? []
    } catch (cause) {
      throw this.error(
        'E_PROVIDER_INVALID',
        `invalid ${this.label}: ${cause instanceof Error ? cause.message : 'validation failed'}`,
        'register',
        provider.id,
        cause,
      )
    }
    if (!Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== 'string'))
      throw this.error('E_PROVIDER_INVALID', `invalid ${this.label} capabilities`, 'register', provider.id)
    return capabilities
  }
  private disposal?: Promise<void>
  dispose(): Promise<void> {
    this.disposal ??= this.drain()
    return this.disposal
  }
  private async drain(): Promise<void> {
    this.disposed = true
    const results = await Promise.allSettled([
      ...this.retiring,
      ...[...this.entries.values()].map((record) => record.dispose?.()),
    ])
    this.selections.clear()
    const failed = results.filter((result) => result.status === 'rejected')
    if (failed.length)
      throw new AggregateError(
        failed.map((result) => result.reason),
        'Provider cleanup failed',
      )
  }
  resolve(selection: string | ProviderSelection): T {
    const wanted = typeof selection === 'string' ? { provider: selection } : selection
    if (this.definition.versioned && wanted.version === undefined) {
      const matches = [...this.entries.values()].filter(({ provider }) => provider.id === wanted.provider)
      if (matches.length === 1) return matches[0]!.provider
      if (matches.length > 1)
        throw this.error(
          'E_PROVIDER_INCOMPATIBLE',
          `${this.label} ${wanted.provider} has multiple versions; set ${this.definition.kind}.version`,
          'resolve',
          wanted.provider,
        )
    }
    const found = this.entries.get(this.key(wanted))
    if (found && (wanted.version === undefined || wanted.version === found.provider.version))
      return found.provider
    throw this.error(
      this.values().some((provider) => provider.id === wanted.provider)
        ? 'E_PROVIDER_INCOMPATIBLE'
        : 'E_PROVIDER_UNKNOWN',
      `${this.label} is not registered: ${wanted.provider}${wanted.version ? `@${wanted.version}` : ''}; install and enable its package, or change ${this.definition.kind}.provider`,
      'resolve',
      wanted.provider,
    )
  }
  private error(
    code: ConstructorParameters<typeof ProviderError>[0],
    message: string,
    operation: string,
    provider?: string,
    cause?: unknown,
  ): ProviderError {
    return new ProviderError(code, message, {
      kind: this.definition.kind,
      provider,
      operation,
      cause,
      hint: 'Install and enable the provider package, or choose an installed compatible provider.',
    })
  }

  select(scope: string, selection: string | ProviderSelection): T {
    const provider = this.resolve(selection)
    this.selections.set(scope, { provider: provider.id, version: provider.version })
    return provider
  }
  clearSelection(scope: string): void {
    this.selections.delete(scope)
  }
  /** Registered providers in insertion order, for named service operations. */
  values(): readonly T[] {
    return [...this.entries.values()].map(({ provider }) => provider)
  }
  catalog(): readonly ProviderCatalogEntry[] {
    return Object.freeze(
      [...this.entries.values()]
        .map(({ provider, entry }) => {
          const selectedFor = Object.freeze(
            [...this.selections]
              .filter(
                ([, s]) =>
                  s.provider === provider.id &&
                  (!this.definition.versioned || s.version === provider.version),
              )
              .map(([scope]) => scope)
              .sort(),
          )
          return Object.freeze({ ...entry, active: selectedFor.length > 0, selectedFor })
        })
        .sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version)),
    )
  }
}

export class ProvidersService extends Service implements ProvidersCatalogPort, ProviderRegistrationPort {
  private readonly kinds = new Map<string, ProviderRegistry<ProviderIdentity>>()
  private readonly registrars = new Map<
    string,
    (owner: Context, source: string, provider: ProviderIdentity) => () => Promise<void>
  >()
  private serviceBinder?: (kind: ServiceKind) => Promise<ServiceInstance>
  private configuration?: (entry: ProviderCatalogEntry) => readonly string[]
  constructor(ctx: Context) {
    super(ctx, 'providers')
  }
  add<T extends ProviderIdentity>(
    registry: ProviderRegistry<T>,
    owner = this.ctx,
    register?: (owner: Context, source: string, provider: T) => () => Promise<void>,
  ): void {
    if (this.kinds.has(registry.definition.kind))
      throw new ProviderError(
        'E_PROVIDER_DUPLICATE',
        `duplicate provider kind: ${registry.definition.kind}`,
        { kind: registry.definition.kind, operation: 'add' },
      )
    const shared = registry as unknown as ProviderRegistry<ProviderIdentity>
    owner.effect(() => {
      this.kinds.set(registry.definition.kind, shared)
      this.registrars.set(registry.definition.kind, (ctx, source, provider) =>
        register ? register(ctx, source, provider as T) : shared.register(source, provider, ctx),
      )
      return async () => {
        if (this.kinds.get(registry.definition.kind) === shared) {
          this.kinds.delete(registry.definition.kind)
          this.registrars.delete(registry.definition.kind)
        }
        await registry.dispose()
      }
    })
  }
  register<K extends keyof KindMap>(
    kind: K,
    sourcePackage: string,
    provider: KindMap[NoInfer<K>],
  ): () => Promise<void>
  register<T extends ProviderIdentity>(
    kind: ProviderKind<T>,
    sourcePackage: string,
    provider: T,
  ): () => Promise<void>
  register(
    kind: string | { readonly kind: string },
    sourcePackage: string,
    provider: ProviderIdentity,
  ): () => Promise<void> {
    const registry = this.lookup(kind, 'register')
    registry.validate(sourcePackage, provider)
    const register = this.registrars.get(registry.definition.kind)!
    return register(this.ctx, sourcePackage, provider)
  }
  resolve<K extends keyof KindMap>(kind: K, selection: string | ProviderSelection): KindMap[K]
  resolve<T extends ProviderIdentity>(kind: ProviderKind<T>, selection: string | ProviderSelection): T
  resolve(kind: string | { readonly kind: string }, selection: string | ProviderSelection): ProviderIdentity {
    return this.lookup(kind, 'resolve').resolve(selection)
  }
  private lookup(
    kind: string | { readonly kind: string },
    operation: string,
  ): ProviderRegistry<ProviderIdentity> {
    const name = typeof kind === 'string' ? kind : kind.kind
    const registry = this.kinds.get(name)
    if (!registry)
      throw new ProviderError(
        'E_PROVIDER_UNKNOWN',
        `provider kind ${name} is not registered; enable its service plugin`,
        { kind: name, operation },
      )
    if (typeof kind !== 'string' && kind !== registry.definition)
      throw new ProviderError(
        'E_PROVIDER_INVALID',
        `provider token for ${name} does not match the installed kind`,
        { kind: name, operation },
      )
    return registry
  }
  catalog(): readonly ProviderCatalogEntry[] {
    return Object.freeze(
      [...this.kinds.values()]
        .flatMap((registry) => registry.catalog())
        .map((entry) => {
          const selectedFor = Object.freeze(
            [...new Set([...entry.selectedFor, ...(this.configuration?.(entry) ?? [])])].sort(),
          )
          return Object.freeze({ ...entry, selectedFor, active: selectedFor.length > 0 })
        })
        .sort(
          (a, b) =>
            a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id) || a.version.localeCompare(b.version),
        ),
    )
  }
  /** A live read-only configuration view survives replacement of the plugin tree. */
  configurationSource(read: (entry: ProviderCatalogEntry) => readonly string[]): void {
    this.configuration = read
  }
  select(kind: string, selection: string | ProviderSelection, scope = 'profile'): ProviderIdentity {
    const registry = this.lookup(kind, 'select')
    return registry.select(scope, selection)
  }
  /** Replaced when a new tree is published. The extension facade is the granted author path. */
  installServiceBinder(binder: (kind: ServiceKind) => Promise<ServiceInstance>): void {
    this.serviceBinder = binder
  }
  bindOwn<S extends ServiceInstance, P extends ServicePorts>(kind: ServiceKind<S, P>): Promise<S> {
    this.lookup(kind, 'bind')
    const binder = this.serviceBinder
    if (!binder)
      throw new ProviderError('E_PROVIDER_UNAVAILABLE', 'service binding is closed', {
        kind: kind.kind,
        operation: 'bind',
      })
    return binder(kind) as Promise<S>
  }
}

export function installProviders(root: Context): ProvidersService {
  return root.providers ?? new ProvidersService(root)
}
export function installProviderRegistry<T extends ProviderIdentity>(
  ctx: Context,
  definition: ProviderKind<T>,
  register?: (owner: Context, source: string, provider: T) => () => Promise<void>,
): ProviderRegistry<T> {
  const registry = new ProviderRegistry(definition)
  installProviders(ctx.root).add(registry, ctx, register)
  return registry
}
