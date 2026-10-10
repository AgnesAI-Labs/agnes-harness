import type { ChildAgentProvider } from './child-agent.js'
import type { CompactionEngine } from './compaction-engine.js'
import type { LoopFactory } from './loop.js'
import type { MemoryProvider } from './memory.js'
import type { ModelAdapter } from './model-adapter.js'
import type { PersistenceProvider } from './persistence.js'
import type { ReferenceResolver } from './reference-resolver.js'
import type { SandboxProvider } from './sandbox-provider.js'
import type { ServiceInstance, ServiceKind, ServicePorts } from './service-provider.js'
import type { ToolPolicy } from './tool-policy.js'
import type { ToolRuntimeProvider } from './tool-runtime.js'
import type { WebhookTriggerProvider } from './webhook-trigger.js'

/** Built-in names bind registration and resolution to the same contract. */
export interface KindMap {
  'webhook-trigger': WebhookTriggerProvider
  'reference-resolver': ReferenceResolver
  memory: MemoryProvider
  loop: LoopFactory
  'model-adapter': ModelAdapter
  compaction: CompactionEngine
  persistence: PersistenceProvider
  sandbox: SandboxProvider
  'tool-runtime': ToolRuntimeProvider
  'tool-policy': ToolPolicy
  'child-agent': ChildAgentProvider
}
export type ProviderLifecycleScope = 'session' | 'generation' | 'workspace' | 'process'
export const PROVIDER_LIFECYCLE_SCOPES = Object.freeze({
  'webhook-trigger': 'process',
  'reference-resolver': 'generation',
  memory: 'session',
  loop: 'session',
  'model-adapter': 'generation',
  compaction: 'generation',
  persistence: 'process',
  sandbox: 'process',
  'tool-runtime': 'session',
  'tool-policy': 'generation',
  'child-agent': 'session',
} as const satisfies Record<keyof KindMap, ProviderLifecycleScope>)

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

export interface ProviderKind<T extends ProviderIdentity> {
  readonly kind: string
  readonly restartRequired: boolean
  readonly scope: ProviderLifecycleScope
  /** Invariant token: use the exact token installed by the kind service. */
  readonly [providerType]: (value: T) => T
  readonly versioned?: boolean
  readonly validate: (provider: T) => void
  readonly capabilities?: (provider: T) => readonly string[]
}

export function defineProviderKind<T extends ProviderIdentity>(
  definition: Omit<ProviderKind<T>, 'restartRequired' | 'scope' | typeof providerType> & {
    scope?: ProviderLifecycleScope /** @deprecated Derived from scope. */
    restartRequired?: boolean
  },
): ProviderKind<T> {
  if (
    !/^[a-z][a-z0-9-]*$/.test(definition.kind) ||
    typeof definition.validate !== 'function' ||
    (definition.restartRequired !== undefined && typeof definition.restartRequired !== 'boolean') ||
    (definition.versioned !== undefined && typeof definition.versioned !== 'boolean')
  )
    throw new Error('Provider kind requires a name and a validator')
  const scope =
    definition.scope ?? PROVIDER_LIFECYCLE_SCOPES[definition.kind as keyof KindMap] ?? 'generation'
  if (!['session', 'generation', 'workspace', 'process'].includes(scope))
    throw new TypeError('Invalid provider lifecycle scope')
  return Object.freeze({
    ...definition,
    scope,
    restartRequired: providerRestartRequired(scope),
    [providerType]: (value: T) => value,
  })
}

/** Read-only metadata. Active means selected in the reported configuration, not session liveness. */
export interface ProviderCatalogEntry extends ProviderIdentity {
  readonly kind: string
  readonly sourcePackage: string
  readonly capabilities: readonly string[]
  readonly restartRequired: boolean
  readonly scope: ProviderLifecycleScope
  readonly active: boolean
  readonly selectedFor: readonly string[]
}

export interface ProvidersCatalogPort {
  catalog(): readonly ProviderCatalogEntry[]
}

/** The same author entry point for every kind; named services remain compatibility facades. */
export interface ProviderRegistrationPort extends ProvidersCatalogPort {
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
  resolve<K extends keyof KindMap>(kind: K, selection: string | ProviderSelection): KindMap[K]
  resolve<T extends ProviderIdentity>(kind: ProviderKind<T>, selection: string | ProviderSelection): T
  /** Binds the admitted callback. A host without a binder fails closed. */
  bindOwn<S extends ServiceInstance, P extends ServicePorts>(kind: ServiceKind<S, P>): Promise<S>
}

export interface ProviderPluginContext {
  providers: ProviderRegistrationPort
}
