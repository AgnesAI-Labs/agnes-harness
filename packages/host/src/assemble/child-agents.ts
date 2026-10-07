import {
  assertChildAgentAllowed,
  childAgentAllowlist,
  inProcessChildAgentProvider,
  IN_PROCESS_CHILD_PROVIDER_ID,
  setChildAgentAllowlist,
} from '@agnes/core'
import { type Context, Service } from '@agnes/cordis'
import { defineProviderKind } from '@agnes/extension-api'
import type {
  ProviderSelection,
  ChildAgentAllowlist,
  ChildAgentCatalogEntry,
  ChildAgentHandle,
  ChildAgentListing,
  ChildAgentProvider,
  ChildAgentService,
  ChildAgentStartOptions,
} from '@agnes/extension-api'
import { normalizePluginExport, type RowOriginLookup } from '@agnes/plugin-runtime/host'
import { HostError } from '../errors.js'
import type { PackageModule } from './packages.js'
import { installProviderRegistry, providerSource, type ProviderRegistry } from './provider-registry.js'

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
            CAPABILITIES.some((flag) => typeof provider.capabilities[flag] !== 'boolean')
          )
            throw new HostError('E_API_RANGE', 'invalid child agent registration')
        },
        capabilities: (provider) => CAPABILITIES.filter((flag) => provider.capabilities[flag]),
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
    }
    const unregister = this.registry.register(record.entry.sourcePackage, provider, this.ctx, () => {
      record.lifetime.abort()
      this.registry.clearSelection(`child:${provider.id}`)
      const handles = [...record.handles]
      record.handles.clear()
      for (const handle of handles) void Promise.resolve(handle.dispose()).catch(() => undefined)
    })
    this.records.set(provider, record)
    return unregister
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

  async start(
    providerId: string | undefined,
    task: string,
    options: ChildAgentStartOptions,
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
    const handle = await record.provider.start(task, {
      ...options,
      signal: AbortSignal.any([options.signal, record.lifetime.signal]),
    })
    if (!handle || typeof handle.dispose !== 'function' || typeof handle.sendMessage !== 'function')
      throw new HostError('E_API_RANGE', `invalid child agent handle: ${providerId}`)
    if (record.lifetime.signal.aborted) {
      await handle.dispose()
      throw new HostError('E_DEP_MISSING', `child agent provider was unloaded: ${providerId}`)
    }
    record.handles.add(handle)
    const scope = `child:${providerId}`
    this.registry.select(scope, providerId)
    const registry = this.registry
    return {
      id: handle.id,
      providerId: handle.providerId,
      capabilities: handle.capabilities,
      events: () => handle.events(),
      sendMessage: (text, signal) => handle.sendMessage(text, signal),
      interrupt: () => handle.interrupt(),
      result: () => handle.result(),
      async dispose() {
        record.handles.delete(handle)
        if (!record.handles.size) registry.clearSelection(scope)
        await handle.dispose()
      },
    }
  }

  async list(sessionKey: string): Promise<readonly ChildAgentListing[]> {
    const lists = await Promise.all(
      this.registry
        .values()
        .map((provider) => provider.list?.(sessionKey) ?? Promise.resolve([])),
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
