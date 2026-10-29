import type {
  BindableKind,
  BindOptions,
  ServiceInstance,
  ServicePortName,
  ServicePorts,
  ServiceProvider,
} from './service-provider.js'

export type ProviderLifecycleScope = 'session' | 'generation' | 'workspace' | 'process'

/** A generation recreates session/generation owners; longer-lived owners require restart. */
export function providerRestartRequired(scope: ProviderLifecycleScope): boolean {
  return scope === 'workspace' || scope === 'process'
}
const providerType: unique symbol = Symbol('provider type')

/** A provider kind describes registration, not the operations of its providers. */
export interface ProviderIdentity {
  readonly id: string
  readonly version: string
}

export interface ProviderSelection {
  provider: string
  /** Optional except when more than one version of a versioned kind is installed. */
  version?: string
}

/**
 * Who may register and select providers of a kind. `open`: any enabled package. `host`: the Host
 * registers the one implementation at process start; packages cannot register or select it, and
 * the catalog shows it read-only.
 */
export type ProviderAuthority = 'open' | 'host'

/** What an author may do with a kind: provide an implementation, bind the owner's instance, or both. */
export interface KindOperations {
  readonly register: boolean
  readonly bind: boolean
}

/** The one token family. Every `ctx.providers` call takes the exact token its owner installed. */
export interface ProviderKind<T extends ProviderIdentity> {
  readonly kind: string
  readonly restartRequired: boolean
  readonly scope: ProviderLifecycleScope
  /** Assembly fails with `E_SEAM_MISSING` when no selected provider resolves. */
  readonly required: boolean
  /** `host`: only the Host registers it; a package registration is refused and it cannot be selected. */
  readonly authority: ProviderAuthority
  /** The selection is recorded per session and replaced only by an explicit repin. */
  readonly pinned: boolean
  readonly operations: KindOperations
  /** Invariant token: use the exact token installed by the kind owner. */
  readonly [providerType]: (value: T) => T
  readonly versioned?: boolean
  readonly validate: (provider: T) => void
  readonly capabilities?: (provider: T) => readonly string[]
}

export interface KindOptions<T extends ProviderIdentity> {
  readonly kind: string
  readonly scope?: ProviderLifecycleScope
  readonly authority?: ProviderAuthority
  readonly required?: boolean
  readonly pinned?: boolean
  readonly versioned?: boolean
  /** Default true. A bind-only kind is installed by the Host and never accepts author providers. */
  readonly register?: boolean
  readonly validate: (provider: T) => void
  readonly capabilities?: (provider: T) => readonly string[]
}

const PORTS: readonly ServicePortName[] = ['ledger', 'input', 'projections', 'decisions']
const INSTANCE_SCOPES = ['request', 'session', 'workspace', 'process']

/**
 * A kind that also supports `bindOwn`: its providers are `ServiceProvider`s and `bind` is the
 * maximum grant. A host descriptor may only shrink the declared ports.
 */
export function defineKind<S extends ServiceInstance, P extends ServicePorts>(
  options: Omit<KindOptions<ServiceProvider<S, P>>, 'validate'> & {
    readonly bind: BindOptions
    readonly validate?: (provider: ServiceProvider<S, P>) => void
  },
): BindableKind<S, P>
export function defineKind<T extends ProviderIdentity>(options: KindOptions<T>): ProviderKind<T>
export function defineKind(
  options: Omit<KindOptions<never>, 'validate'> & {
    readonly validate?: (provider: never) => void
    readonly bind?: BindOptions
  },
): unknown {
  if (
    !/^[a-z][a-z0-9-]*$/.test(options.kind) ||
    (options.validate !== undefined && typeof options.validate !== 'function') ||
    (options.bind === undefined && typeof options.validate !== 'function') ||
    (options.versioned !== undefined && typeof options.versioned !== 'boolean') ||
    (options.register !== undefined && typeof options.register !== 'boolean') ||
    (options.required !== undefined && typeof options.required !== 'boolean') ||
    (options.pinned !== undefined && typeof options.pinned !== 'boolean')
  )
    throw new Error('Provider kind requires a name and a validator')
  const scope = options.scope ?? 'generation'
  if (!['session', 'generation', 'workspace', 'process'].includes(scope))
    throw new TypeError('Invalid provider lifecycle scope')
  if (options.authority !== undefined && options.authority !== 'open' && options.authority !== 'host')
    throw new TypeError('Invalid provider authority')
  const { register, bind, validate, authority, required, pinned, ...rest } = options
  const operations = Object.freeze({ register: register ?? true, bind: bind !== undefined })
  const check = validate as ((provider: ProviderIdentity) => void) | undefined
  const token = {
    ...rest,
    authority: authority ?? 'open',
    required: required ?? false,
    pinned: pinned ?? false,
    scope,
    restartRequired: providerRestartRequired(scope),
    operations,
    [providerType]: (value: ProviderIdentity) => value,
  }
  if (!bind) return Object.freeze({ ...token, validate: check! })
  const ports = Object.freeze([...(bind.ports ?? [])])
  if (
    (bind.cardinality !== 'single' && bind.cardinality !== 'multi') ||
    !INSTANCE_SCOPES.includes(bind.instanceScope) ||
    new Set(ports).size !== ports.length ||
    ports.some((port) => !PORTS.includes(port))
  )
    throw new TypeError('Invalid bindable kind')
  return Object.freeze({
    ...token,
    cardinality: bind.cardinality,
    instanceScope: bind.instanceScope,
    ports,
    validate(provider: ProviderIdentity) {
      if (typeof (provider as Partial<ServiceProvider>)?.open !== 'function')
        throw new Error('service provider requires open')
      check?.(provider)
    },
  })
}

/** Read-only metadata. Active means selected in the reported configuration, not session liveness. */
export interface ProviderCatalogEntry extends ProviderIdentity {
  readonly kind: string
  readonly sourcePackage: string
  readonly capabilities: readonly string[]
  readonly restartRequired: boolean
  readonly scope: ProviderLifecycleScope
  readonly required: boolean
  readonly authority: ProviderAuthority
  readonly pinned: boolean
  readonly active: boolean
  readonly selectedFor: readonly string[]
}

export interface ProvidersCatalogPort {
  catalog(): readonly ProviderCatalogEntry[]
}

/**
 * Typed author registration shared by provider kinds; operation lifecycles stay with their owners.
 * The Host attributes a registration to the package of the calling plugin row.
 */
export interface ProviderRegistrationPort extends ProvidersCatalogPort {
  register<T extends ProviderIdentity>(kind: ProviderKind<T>, provider: NoInfer<T>): () => Promise<void>
  resolve<T extends ProviderIdentity>(kind: ProviderKind<T>, selection: string | ProviderSelection): T
  /** Binds the admitted callback. A host without a binder fails closed. */
  bindOwn<S extends ServiceInstance, P extends ServicePorts>(kind: BindableKind<S, P>): Promise<S>
}

export interface ProviderPluginContext {
  providers: ProviderRegistrationPort
}
