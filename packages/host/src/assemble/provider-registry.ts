import { type Context, Service } from '@agnes/cordis'
import type {
  ProviderCatalogEntry,
  ProviderIdentity,
  ProviderKind,
  ProviderRegistrationPort,
  ProviderSelection,
  ProvidersCatalogPort,
} from '@agnes/extension-api'
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
    if (this.disposed) throw new HostError('E_HOST_CLOSED', `${this.label} registry is disposed`)
    if (
      typeof provider?.id !== 'string' ||
      !provider.id.trim() ||
      typeof provider.version !== 'string' ||
      !provider.version.trim() ||
      typeof sourcePackage !== 'string' ||
      !sourcePackage.trim()
    )
      throw new HostError('E_API_RANGE', `invalid ${this.label} registration`)
    this.definition.validate(provider)
    const capabilities = this.definition.capabilities?.(provider) ?? []
    if (!Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== 'string'))
      throw new HostError('E_API_RANGE', `invalid ${this.label} capabilities`)
    const key = this.key(provider)
    if (this.entries.has(key)) throw new HostError('E_API_RANGE', `duplicate ${this.label}: ${key}`)
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
      }),
    }
    const mount = () => {
      this.entries.set(key, record)
      let disposal: Promise<void> | undefined
      record.dispose = () => {
        if (disposal) return disposal
        if (this.entries.get(key) !== record) return Promise.resolve()
        this.entries.delete(key)
        try {
          disposal = Promise.resolve(cleanup?.())
        } catch (error) {
          disposal = Promise.reject(error)
        }
        return disposal
      }
      return record.dispose
    }
    return owner ? owner.effect(mount, `providers.register(${this.definition.kind}:${key})`) : mount()
  }
  async dispose(): Promise<void> {
    this.disposed = true
    const results = await Promise.allSettled([...this.entries.values()].map((record) => record.dispose?.()))
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
        throw new HostError(
          'E_DEP_MISSING',
          `${this.label} ${wanted.provider} has multiple versions; set ${this.definition.kind}.version`,
        )
    }
    const found = this.entries.get(this.key(wanted))
    if (found && (wanted.version === undefined || wanted.version === found.provider.version))
      return found.provider
    throw new HostError(
      'E_DEP_MISSING',
      `${this.label} is not registered: ${wanted.provider}${wanted.version ? `@${wanted.version}` : ''}; install and enable its package, or change ${this.definition.kind}.provider`,
      {
        detail: {
          kind: this.definition.kind,
          id: wanted.provider,
          provider: wanted.provider,
          ...(this.definition.restartRequired ? { effect: 'restart-required' } : {}),
          ...(wanted.version ? { version: wanted.version } : {}),
          hint: 'Install and enable the provider package, or choose an installed provider.',
        },
      },
    )
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
    (owner: Context, source: string, provider: ProviderIdentity) => () => void | Promise<void>
  >()
  private configuration?: (entry: ProviderCatalogEntry) => readonly string[]
  constructor(ctx: Context) {
    super(ctx, 'providers')
  }
  add<T extends ProviderIdentity>(
    registry: ProviderRegistry<T>,
    owner = this.ctx,
    register?: (owner: Context, source: string, provider: T) => () => void | Promise<void>,
  ): void {
    if (this.kinds.has(registry.definition.kind))
      throw new HostError('E_API_RANGE', `duplicate provider kind: ${registry.definition.kind}`)
    const shared = registry as unknown as ProviderRegistry<ProviderIdentity>
    owner.effect(() => {
      this.kinds.set(registry.definition.kind, shared)
      this.registrars.set(registry.definition.kind, (ctx, source, provider) =>
        register ? register(ctx, source, provider as T) : shared.register(source, provider, ctx),
      )
      return () => {
        if (this.kinds.get(registry.definition.kind) === shared) {
          this.kinds.delete(registry.definition.kind)
          this.registrars.delete(registry.definition.kind)
        }
      }
    })
  }
  register<T extends ProviderIdentity>(
    kind: string | ProviderKind<T>,
    sourcePackage: string,
    provider: T,
  ): () => void | Promise<void> {
    const name = typeof kind === 'string' ? kind : kind.kind
    const register = this.registrars.get(name)
    if (!register)
      throw new HostError(
        'E_DEP_MISSING',
        `provider kind ${name} is not registered; enable its service plugin`,
      )
    return register(this.ctx, sourcePackage, provider)
  }
  resolve<T extends ProviderIdentity>(kind: ProviderKind<T>, selection: string | ProviderSelection): T {
    const registry = this.kinds.get(kind.kind)
    if (!registry)
      throw new HostError(
        'E_DEP_MISSING',
        `provider kind ${kind.kind} is not registered; enable its service plugin`,
      )
    return registry.resolve(selection) as T
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
    const registry = this.kinds.get(kind)
    if (!registry)
      throw new HostError(
        'E_DEP_MISSING',
        `provider kind ${kind} is not registered; enable its service plugin`,
      )
    return registry.select(scope, selection)
  }
}

export function installProviders(root: Context): ProvidersService {
  return root.providers ?? new ProvidersService(root)
}
export function installProviderRegistry<T extends ProviderIdentity>(
  ctx: Context,
  definition: ProviderKind<T>,
  register?: (owner: Context, source: string, provider: T) => () => void | Promise<void>,
): ProviderRegistry<T> {
  const registry = new ProviderRegistry(definition)
  installProviders(ctx.root).add(registry, ctx, register)
  return registry
}
