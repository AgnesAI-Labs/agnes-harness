import { type Context, Service } from '@agnes/cordis'
import {
  assertChildAgentAllowed,
  bindChildAgentSession,
  childAgentAllowlist,
  IN_PROCESS_CHILD_PROVIDER_ID,
  inProcessChildAgentProvider,
  setChildAgentAllowlist,
} from '@agnes/core'
import type {
  ChildAgentAllowlist,
  ChildAgentCatalogEntry,
  ChildAgentHandle,
  ChildAgentListing,
  ChildAgentParentScope,
  ChildAgentProvider,
  ChildAgentService,
  ChildAgentSessionService,
  ChildAgentStartOptions,
  ProviderSelection,
} from '@agnes/extension-api'
import { defineProviderKind } from '@agnes/extension-api'
import { normalizePluginExport, type RowOriginLookup } from '@agnes/plugin-runtime/host'
import { HostError } from '../errors.js'
import type { PackageModule } from './packages.js'
import { installProviderRegistry, type ProviderRegistry, providerSource } from './provider-registry.js'

declare module '@agnes/cordis' {
  interface Context {
    childAgents: ChildAgentRegistry
  }
}

const CAPABILITIES = [
  'continuable',
  'interrupt',
  'modelSelection',
  'inheritsParentContext',
  'worktree',
] as const

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
  ) {
    super(ctx, 'childAgents')
    this.registry = installProviderRegistry(
      ctx,
      defineProviderKind<ChildAgentProvider>({
        kind: 'child-agent',
        validate(provider) {
          if (
            typeof provider?.id !== 'string' ||
            !provider.id.trim() ||
            typeof provider.version !== 'string' ||
            !provider.version.trim() ||
            typeof provider.start !== 'function' ||
            !provider.capabilities ||
            CAPABILITIES.some((flag) => typeof provider.capabilities[flag] !== 'boolean') ||
            (['budget', 'toolFilter'] as const).some(
              (flag) =>
                provider.capabilities[flag] !== undefined && typeof provider.capabilities[flag] !== 'boolean',
            )
          )
            throw new HostError('E_API_RANGE', 'invalid child agent registration')
        },
        capabilities: (provider) =>
          ([...CAPABILITIES, 'budget', 'toolFilter'] as const).filter((flag) => provider.capabilities[flag]),
      }),
      (owner, source, provider) => owner.childAgents.register(provider, source),
    )
  }

  register(provider: ChildAgentProvider, sourcePackage?: string): () => Promise<void> {
    this.registry.definition.validate(provider)
    const record = {
      provider,
      entry: Object.freeze({
        id: provider.id,
        version: provider.version,
        sourcePackage: providerSource(
          this.ctx,
          this.origins,
          sourcePackage ?? '@agnes/base',
          sourcePackage !== undefined,
        ),
        capabilities: Object.freeze({ ...provider.capabilities }),
      }),
      lifetime: new AbortController(),
      handles: new Set<ChildAgentHandle>(),
      starting: new Set<Promise<unknown>>(),
    }
    const unregister = this.registry.register(record.entry.sourcePackage, provider, this.ctx, async () => {
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
    const provider = this.registry.resolve(providerId ?? this.selection ?? IN_PROCESS_CHILD_PROVIDER_ID)
    providerId = provider.id
    const record = this.records.get(provider)!
    if (record.lifetime.signal.aborted)
      throw new HostError('E_DEP_MISSING', `child agent provider was unloaded: ${providerId}`)
    if (!options?.signal || !options.sessionKey)
      throw new HostError('E_API_RANGE', 'child agent start requires a session and a signal')
    options.signal.throwIfAborted()
    assertChildAgentAllowed(options.sessionKey, {
      providerId,
      ...(options.model ? { model: options.model } : {}),
    })
    refuseMissingCapability(record.provider, options)
    if (recovering && (!provider.adopt || !options.invocationId))
      throw new HostError('E_API_RANGE', 'child provider cannot adopt this invocation')
    const startSignal = AbortSignal.any([options.signal, record.lifetime.signal])
    const starting = Promise.resolve()
      .then(() =>
        recovering
          ? record.provider.adopt!(task, {
              ...options,
              invocationId: options.invocationId!,
              signal: startSignal,
            })
          : record.provider.start(task, {
              ...options,
              signal: startSignal,
            }),
      )
      .then(
        async (raw) => {
          if (!raw || typeof raw.dispose !== 'function' || typeof raw.sendMessage !== 'function')
            throw new HostError('E_API_RANGE', 'invalid child agent handle')
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
      throw new HostError('E_DEP_MISSING', `child agent provider was unloaded: ${providerId}`)
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

function refuseMissingCapability(provider: ChildAgentProvider, options: ChildAgentStartOptions): void {
  if (options.budget !== undefined && !provider.capabilities.budget)
    throw new HostError(
      'E_CAPABILITY_UNDECLARED',
      `child provider ${provider.id} cannot enforce a child budget`,
    )
  if (options.toolFilter !== undefined && !provider.capabilities.toolFilter)
    throw new HostError('E_CAPABILITY_UNDECLARED', `child provider ${provider.id} cannot filter child tools`)
  if (options.fork && !provider.capabilities.inheritsParentContext)
    throw new HostError(
      'E_CAPABILITY_UNDECLARED',
      `child provider ${provider.id} cannot inherit parent context`,
    )
  if (options.model && !provider.capabilities.modelSelection)
    throw new HostError(
      'E_CAPABILITY_UNDECLARED',
      `child provider ${provider.id} cannot select a child model`,
    )
  if (options.isolation === 'worktree' && !provider.capabilities.worktree)
    throw new HostError(
      'E_CAPABILITY_UNDECLARED',
      `child provider ${provider.id} cannot isolate a child worktree`,
    )
}

export function installChildAgents(
  root: Context,
  origins?: RowOriginLookup,
  selection?: ProviderSelection,
): ChildAgentRegistry {
  return new ChildAgentRegistry(root, origins, selection)
}

/** Supply the in-process child provider through the same ordinary row and registry as community providers. */
export function withBuiltinChildAgents(
  modules: ReadonlyMap<string, PackageModule>,
): ReadonlyMap<string, PackageModule> {
  const builtin = modules.get('@agnes/base')
  if (!builtin || builtin.plugins?.some((row) => row.declaration.id === 'child-agent:in-process'))
    return modules
  const provider = inProcessChildAgentProvider()
  const result = new Map(modules)
  result.set('@agnes/base', {
    ...builtin,
    plugins: [
      ...(builtin.plugins ?? []),
      {
        declaration: {
          id: 'child-agent:in-process',
          export: 'childAgentPlugin',
          default: true,
          inject: ['childAgents'],
          provide: [],
          runtime: 'in-process',
        },
        entry: normalizePluginExport({
          inject: ['childAgents'],
          apply(ctx: Context) {
            ctx.childAgents.register(provider)
          },
        }),
      },
    ],
  })
  return result
}

export function childAgentCatalog(root: Context): readonly ChildAgentCatalogEntry[] {
  return root.childAgents.catalog()
}
