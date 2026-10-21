import { type Context, Service } from '@agnes/cordis'
import { bindChildAgentSession, CoreError, childAgentAllowlist, setChildAgentAllowlist } from '@agnes/core'
import type {
  ChildAgentAllowlist,
  ChildAgentCatalogEntry,
  ChildAgentHandle,
  ChildAgentListing,
  ChildAgentParentScope,
  ChildAgentProvider,
  ChildAgentProviderStartOptions,
  ChildAgentService,
  ChildAgentSessionService,
  ChildAgentStartOptions,
  ProviderSelection,
} from '@agnes/extension-api'
import { childAgentKind, ProviderError } from '@agnes/extension-api'
import {
  installProviderRegistry,
  type ProviderRegistry,
  providerSource,
} from '@agnes/host-common/assemble/provider-registry'
import { RELEASE_DEFAULTS } from '@agnes/package-manager'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import { resolveSessionCapabilities } from '../profile/session-capabilities.js'

declare module '@agnes/cordis' {
  interface Context {
    childAgents: ChildAgentRegistry
  }
}

export class ChildAgentRegistry extends Service implements ChildAgentService {
  private readonly registry: ProviderRegistry<ChildAgentProvider>
  private readonly records = new WeakMap<
    ChildAgentProvider,
    {
      provider: ChildAgentProvider
      entry: ChildAgentCatalogEntry
      lifetime: AbortController
      handles: Set<ChildAgentHandle>
      starting: Set<Promise<unknown>>
    }
  >()

  constructor(
    ctx: Context,
    private readonly origins?: RowOriginLookup,
    private readonly selection?: ProviderSelection,
    private readonly launch: NonNullable<ChildAgentProviderStartOptions['launch']> = {},
  ) {
    super(ctx, 'childAgents')
    this.registry = installProviderRegistry(ctx, childAgentKind, (owner, source, provider) =>
      this.registerOwned(owner, provider, source),
    )
  }

  private registerOwned(
    owner: Context,
    provider: ChildAgentProvider,
    sourcePackage?: string,
  ): () => Promise<void> {
    const record = {
      provider,
      entry: Object.freeze({
        id: provider.id,
        version: provider.version,
        sourcePackage: providerSource(owner, this.origins, sourcePackage),
        capabilities: Object.freeze({ ...provider.capabilities }),
      }),
      lifetime: new AbortController(),
      handles: new Set<ChildAgentHandle>(),
      starting: new Set<Promise<unknown>>(),
    }
    const unregister = this.registry.register(record.entry.sourcePackage, provider, owner, async () => {
      record.lifetime.abort()
      this.registry.clearSelection(`child:${provider.id}`)
      const starts = await Promise.allSettled([...record.starting])
      const handles = [...record.handles]
      record.handles.clear()
      const disposed = await Promise.allSettled(handles.map((handle) => handle.dispose()))
      const failures = [...starts, ...disposed].filter((result) => result.status === 'rejected')
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Child provider cleanup failed',
        )
    })
    this.records.set(provider, record)
    let disposal: Promise<void> | undefined
    return () => {
      if (!disposal) {
        try {
          disposal = Promise.resolve(unregister())
        } catch (error) {
          disposal = Promise.reject(error)
        }
      }
      return disposal
    }
  }

  catalog(): readonly ChildAgentCatalogEntry[] {
    return Object.freeze(
      this.registry
        .catalog()
        .map((entry) => this.records.get(this.registry.resolve(entry.id))!.entry)
        .sort((a, b) => a.id.localeCompare(b.id)),
    )
  }

  setSessionAllowlist(sessionKey: string, allowlist: ChildAgentAllowlist | undefined): void {
    setChildAgentAllowlist(sessionKey, allowlist)
  }

  allowlist(sessionKey: string): ChildAgentAllowlist | undefined {
    return childAgentAllowlist(sessionKey)
  }

  forSession(parent: ChildAgentParentScope): ChildAgentSessionService {
    return bindChildAgentSession(this, parent)
  }

  adopt(
    providerId: string | undefined,
    task: string,
    options: ChildAgentStartOptions & { invocationId: string },
  ): Promise<ChildAgentHandle> {
    return this.startOrAdopt(providerId, task, options, true)
  }

  start(
    providerId: string | undefined,
    task: string,
    options: ChildAgentStartOptions,
  ): Promise<ChildAgentHandle> {
    return this.startOrAdopt(providerId, task, options, false)
  }

  private async startOrAdopt(
    providerId: string | undefined,
    task: string,
    options: ChildAgentStartOptions,
    recovering: boolean,
  ): Promise<ChildAgentHandle> {
    const provider = this.registry.resolve(providerId ?? this.selection ?? RELEASE_DEFAULTS.childProvider)
    providerId = provider.id
    const record = this.records.get(provider)!
    if (record.lifetime.signal.aborted)
      throw childProviderError(provider, 'E_PROVIDER_UNAVAILABLE', 'child agent provider was unloaded')
    if (!options?.signal || !options.sessionKey)
      throw childProviderError(
        provider,
        'E_PROVIDER_INVALID',
        'child agent start requires a session and a signal',
      )
    options.signal.throwIfAborted()
    const refusal = resolveSessionCapabilities({
      ...(this.allowlist(options.sessionKey) ? { childAllowlist: this.allowlist(options.sessionKey)! } : {}),
      childRequest: { providerId, ...(options.model ? { model: options.model } : {}) },
    }).childRefusal
    if (refusal) throw new CoreError(refusal.code, refusal.message, refusal.detail)
    refuseMissingCapability(record.provider, options)
    if (recovering && (!provider.adopt || !options.invocationId))
      throw childProviderError(
        provider,
        'E_PROVIDER_INCOMPATIBLE',
        'child provider cannot adopt this invocation',
      )
    const startSignal = AbortSignal.any([options.signal, record.lifetime.signal])
    const starting = Promise.resolve()
      .then(() => {
        startSignal.throwIfAborted()
        return recovering
          ? record.provider.adopt!(task, {
              ...options,
              launch: Object.freeze({ ...this.launch }),
              invocationId: options.invocationId!,
              signal: startSignal,
            })
          : record.provider.start(task, {
              ...options,
              launch: Object.freeze({ ...this.launch }),
              signal: startSignal,
            })
      })
      .then(
        async (raw) => {
          if (!raw || typeof raw.dispose !== 'function' || typeof raw.sendMessage !== 'function') {
            if (typeof raw?.dispose === 'function') await raw.dispose()
            throw childProviderError(provider, 'E_PROVIDER_INVALID', 'invalid child agent handle')
          }
          let disposal: Promise<void> | undefined
          const handle: ChildAgentHandle = {
            id: raw.id,
            providerId: raw.providerId,
            capabilities: raw.capabilities,
            events: () => raw.events(),
            sendMessage: (text, signal) => raw.sendMessage(text, signal),
            interrupt: () => raw.interrupt(),
            result: () => raw.result(),
            dispose: () => {
              disposal ??= Promise.resolve().then(async () => {
                await raw.dispose()
                record.handles.delete(handle)
                if (!record.handles.size) this.registry.clearSelection(scope)
              })
              return disposal
            },
          }
          if (startSignal.aborted) {
            await handle.dispose()
            return undefined
          }
          record.handles.add(handle)
          return handle
        },
        (error: unknown) => {
          if (startSignal.aborted && error === startSignal.reason) return undefined
          throw error
        },
      )
    const scope = `child:${providerId}`
    record.starting.add(starting)
    let handle: ChildAgentHandle | undefined
    try {
      handle = await starting
    } finally {
      record.starting.delete(starting)
    }
    if (!handle) {
      options.signal.throwIfAborted()
      throw childProviderError(provider, 'E_PROVIDER_UNAVAILABLE', 'child agent provider was unloaded')
    }
    this.registry.select(scope, providerId)
    return handle
  }

  async list(sessionKey: string): Promise<readonly ChildAgentListing[]> {
    const lists = await Promise.all(
      this.registry.values().map((provider) => provider.list?.(sessionKey) ?? Promise.resolve([])),
    )
    const seen = new Set<string>()
    const children: ChildAgentListing[] = []
    for (const list of lists) {
      for (const child of list) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        children.push(child)
      }
    }
    return children
  }
}

function childProviderError(
  provider: ChildAgentProvider,
  code: 'E_PROVIDER_INVALID' | 'E_PROVIDER_INCOMPATIBLE' | 'E_PROVIDER_UNAVAILABLE',
  message: string,
): ProviderError {
  return new ProviderError(code, message, { kind: 'child-agent', provider: provider.id, operation: 'start' })
}

function refuseMissingCapability(provider: ChildAgentProvider, options: ChildAgentStartOptions): void {
  if (options.budget !== undefined && !provider.capabilities.budget)
    throw childProviderError(
      provider,
      'E_PROVIDER_INCOMPATIBLE',
      `child provider ${provider.id} cannot enforce a child budget`,
    )
  if (options.toolFilter !== undefined && !provider.capabilities.toolFilter)
    throw childProviderError(
      provider,
      'E_PROVIDER_INCOMPATIBLE',
      `child provider ${provider.id} cannot filter child tools`,
    )
  if (options.fork && !provider.capabilities.inheritsParentContext)
    throw childProviderError(
      provider,
      'E_PROVIDER_INCOMPATIBLE',
      `child provider ${provider.id} cannot inherit parent context`,
    )
  if (options.model && !provider.capabilities.modelSelection)
    throw childProviderError(
      provider,
      'E_PROVIDER_INCOMPATIBLE',
      `child provider ${provider.id} cannot select a child model`,
    )
  if (options.isolation === 'worktree' && !provider.capabilities.worktree)
    throw childProviderError(
      provider,
      'E_PROVIDER_INCOMPATIBLE',
      `child provider ${provider.id} cannot isolate a child worktree`,
    )
}

export function installChildAgents(
  root: Context,
  origins?: RowOriginLookup,
  selection?: ProviderSelection,
  launch?: ChildAgentProviderStartOptions['launch'],
): ChildAgentRegistry {
  return new ChildAgentRegistry(root, origins, selection, launch)
}

export function childAgentCatalog(root: Context): readonly ChildAgentCatalogEntry[] {
  return root.childAgents.catalog()
}
