import { type Context, Service } from '@agnes/cordis'
import type {
  BindableKind,
  ProviderCatalogEntry,
  ProviderIdentity,
  ProviderKind,
  ProviderRegistrationPort,
  ProviderSelection,
  ProvidersCatalogPort,
  ServiceInstance,
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

/**
 * The package a registration belongs to. An installed plugin row is its own source and cannot name
 * another package. A bundled row carries the owner its Host builder stated. `named` is what Host
 * code states for a registration it makes itself, and `host` is the owner of a named Host service.
 */
export function providerSource(
  ctx: Context,
  origins: RowOriginLookup | undefined,
  named?: string,
  host?: string,
): string {
  const unowned = () => new HostError('E_EXT_LOAD', 'provider requires a verified plugin row')
  for (let fiber = ctx.fiber; fiber !== fiber.parent.fiber; fiber = fiber.parent.fiber) {
    const origin = origins?.lookup(fiber)
    if (!origin) continue
    if (origin.trustTier === 'builtin' && origin.packageId === 'builtin') {
      const source = named ?? origin.ownerPackage ?? host
      if (!source) throw unowned()
      return source
    }
    if (named !== undefined && origin.packageId !== named)
      throw new HostError('E_EXT_LOAD', 'provider source package does not match its plugin row')
    return origin.packageId
  }
  // A Cordis call shadow is `ctx.extend(...)`: a different object on the same fiber.
  // Object identity would reject Host registration through that shadow. A plugin
  // fiber is distinct and still needs a verified row.
  if (origins && ctx.fiber !== ctx.root.fiber) throw unowned()
  const source = named ?? host
  if (!source) throw unowned()
  return source
}

/** Storage and fiber ownership shared by all named provider services. */
export class ProviderRegistry<T extends ProviderIdentity> {
  private readonly entries = new Map<
    string,
    {
      provider: T
      owner?: Context
      lease: symbol
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
      owner?: Context
      lease: symbol
      entry: Omit<ProviderCatalogEntry, 'active' | 'selectedFor'>
      dispose?: () => Promise<void>
    } = {
      provider,
      ...(owner ? { owner } : {}),
      lease: Symbol(key),
      entry: Object.freeze({
        kind: this.definition.kind,
        id: provider.id,
        version: provider.version,
        sourcePackage,
        capabilities: Object.freeze([...capabilities]),
        restartRequired: this.definition.restartRequired,
        scope: this.definition.scope,
        required: this.definition.required,
        authority: this.definition.authority,
        pinned: this.definition.pinned,
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
  /** Each registration gets an unrepeatable identity, removed synchronously on revocation. */
  lease(selection: ProviderSelection): symbol {
    this.resolve(selection)
    return this.entries.get(this.key(selection))!.lease
  }
  owner(selection: ProviderSelection): Context | undefined {
    this.resolve(selection)
    return this.entries.get(this.key(selection))!.owner
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
  private serviceBinder?: <S extends ServiceInstance, P extends ServicePorts>(
    kind: BindableKind<S, P>,
  ) => Promise<S>
  private configuration?: (entry: ProviderCatalogEntry) => readonly string[]
  private origins?: RowOriginLookup
  constructor(ctx: Context) {
    super(ctx, 'providers')
  }
  /** The tree's row index. With it every kind derives the source package from the caller's row. */
  verifyRows(origins: RowOriginLookup): void {
    this.origins = origins
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
  register<T extends ProviderIdentity>(kind: ProviderKind<T>, provider: NoInfer<T>): () => Promise<void>
  register(kind: ProviderKind<ProviderIdentity>, provider: ProviderIdentity): () => Promise<void> {
    return this.registerFrom(kind, undefined, provider)
  }
  /**
   * Host registration. The Host has no plugin row, so it names the package it registers for. An
   * installed plugin row that names another package is refused.
   */
  registerHost<T extends ProviderIdentity>(
    kind: ProviderKind<T>,
    sourcePackage: string,
    provider: NoInfer<T>,
  ): () => Promise<void>
  registerHost(
    kind: ProviderKind<ProviderIdentity>,
    sourcePackage: string,
    provider: ProviderIdentity,
  ): () => Promise<void> {
    return this.registerFrom(kind, sourcePackage, provider)
  }
  private registerFrom(
    kind: ProviderKind<ProviderIdentity>,
    named: string | undefined,
    provider: ProviderIdentity,
  ): () => Promise<void> {
    const registry = this.lookup(kind, 'register')
    this.refuseHostKind(registry, 'register', provider.id)
    if (!kind.operations.register)
      throw new ProviderError(
        'E_PROVIDER_INVALID',
        `provider kind ${kind.kind} does not accept registration`,
        {
          kind: kind.kind,
          operation: 'register',
        },
      )
    const sourcePackage = providerSource(this.ctx, this.origins, named)
    registry.validate(sourcePackage, provider)
    const register = this.registrars.get(registry.definition.kind)!
    return register(this.ctx, sourcePackage, provider)
  }
  resolve<T extends ProviderIdentity>(kind: ProviderKind<T>, selection: string | ProviderSelection): T
  resolve(kind: ProviderKind<ProviderIdentity>, selection: string | ProviderSelection): ProviderIdentity {
    return this.lookup(kind, 'resolve').resolve(selection)
  }
  /** Host-only binding guard; never exposed through the author registration port. */
  lease<T extends ProviderIdentity>(kind: ProviderKind<T>, selection: ProviderSelection): symbol {
    return this.lookup(kind, 'bind').lease(selection)
  }
  /** Host-only provenance; a profile name cannot promote an installed registration to builtin. */
  builtinRegistration<T extends ProviderIdentity>(
    kind: ProviderKind<T>,
    selection: ProviderSelection,
    ownerPackage: string,
  ): boolean {
    const owner = this.lookup(kind, 'bind').owner(selection)
    if (!this.origins) return true
    if (!owner) return false
    for (let fiber = owner.fiber; fiber !== fiber.parent.fiber; fiber = fiber.parent.fiber) {
      const origin = this.origins.lookup(fiber)
      if (origin)
        return (
          origin.trustTier === 'builtin' &&
          origin.packageId === 'builtin' &&
          origin.ownerPackage === ownerPackage
        )
    }
    return owner.fiber === this.ctx.root.fiber
  }
  /** The author path and configuration cannot touch a kind the Host owns; Host code holds the registry itself. */
  private refuseHostKind(
    registry: ProviderRegistry<ProviderIdentity>,
    operation: 'register' | 'select',
    provider: string,
  ): void {
    if (registry.definition.authority !== 'host') return
    throw new ProviderError(
      'E_PROVIDER_INVALID',
      `${registry.definition.kind} is host-owned: it cannot be ${operation === 'register' ? 'registered by a package' : 'selected'}`,
      { kind: registry.definition.kind, provider, operation },
    )
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
    this.refuseHostKind(registry, 'select', typeof selection === 'string' ? selection : selection.provider)
    return registry.select(scope, selection)
  }
  /** Replaced when a new tree is published. The extension facade is the granted author path. */
  installServiceBinder(
    binder: <S extends ServiceInstance, P extends ServicePorts>(kind: BindableKind<S, P>) => Promise<S>,
  ): void {
    this.serviceBinder = binder
  }
  bindOwn<S extends ServiceInstance, P extends ServicePorts>(kind: BindableKind<S, P>): Promise<S> {
    this.lookup(kind, 'bind')
    const binder = this.serviceBinder
    if (!binder)
      throw new ProviderError('E_PROVIDER_UNAVAILABLE', 'service binding is closed', {
        kind: kind.kind,
        operation: 'bind',
      })
    return binder(kind)
  }
}

export function installProviders(root: Context, origins?: RowOriginLookup): ProvidersService {
  const providers = root.providers ?? new ProvidersService(root)
  if (origins) providers.verifyRows(origins)
  return providers
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
