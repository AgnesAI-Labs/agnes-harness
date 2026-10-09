import { type Context, Service } from '@agnes/cordis'
import { defaultToolPolicy, defaultToolRuntimeProvider, LoopEventRegistry } from '@agnes/core'
import type {
  LoopEventContext,
  LoopEventHandler,
  LoopEventName,
  LoopEventPayloadMap,
  LoopEventRegistryPort,
  LoopEventReturnMap,
  ToolPolicy,
  ToolPolicyRegistryPort,
  ToolPolicySettingsContext,
  ToolRuntimeProvider,
  ToolRuntimeRegistryPort,
} from '@agnes/extension-api'
import { defineProviderKind, ProviderError } from '@agnes/extension-api'
import { ProviderLifetime } from '@agnes/host-common/assemble/provider-lifetime'
import {
  installProviderRegistry,
  type ProviderRegistry,
  providerSource,
} from '@agnes/host-common/assemble/provider-registry'
import type { PackageModule } from '@agnes/host-extensions/assemble/packages'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'

declare module '@agnes/cordis' {
  interface Context {
    toolRuntimes: ToolRuntimeRegistryPort
    toolPolicies: ToolPolicyRegistryPort
    loopEvents: LoopEventRegistryPort
  }
}

export class ToolRuntimesService extends Service implements ToolRuntimeRegistryPort {
  private readonly registry: ProviderRegistry<ToolRuntimeProvider>
  constructor(
    ctx: Context,
    private readonly origins?: RowOriginLookup,
  ) {
    super(ctx, 'toolRuntimes')
    this.registry = installProviderRegistry(
      ctx,
      defineProviderKind<ToolRuntimeProvider>({
        kind: 'tool-runtime',
        validate(provider) {
          if (typeof provider.create !== 'function') throw new Error('Invalid tool runtime provider')
        },
        capabilities: () => ['single', 'batch', 'scheduling', 'cancel'],
      }),
      (owner, source, provider) => owner.toolRuntimes.register(source, provider),
    )
    this.register('@agnes/core', defaultToolRuntimeProvider)
  }
  register(sourcePackage: string, provider: ToolRuntimeProvider) {
    const source = providerSource(this.ctx, this.origins, sourcePackage, true)
    this.registry.validate(source, provider)
    const owner = new ProviderLifetime('tool-runtime', provider.id)
    const wrapped: ToolRuntimeProvider = {
      ...provider,
      create: (options, signal) =>
        owner.run(async (creationSignal) => {
          const runtime = await provider.create(options, creationSignal)
          const instance = new ProviderLifetime('tool-runtime', provider.id)
          const dispose = owner.own(() =>
            instance.close(
              () => runtime?.dispose?.(),
              () => runtime?.cancel?.(),
            ),
          )
          if (creationSignal.aborted) {
            await dispose()
            creationSignal.throwIfAborted()
          }
          if (
            !runtime ||
            ['execute', 'batch', 'cancel', 'dispose'].some(
              (key) => typeof runtime[key as keyof typeof runtime] !== 'function',
            )
          ) {
            await dispose()
            throw new ProviderError('E_PROVIDER_INVALID', 'Invalid tool runtime instance', {
              kind: 'tool-runtime',
              provider: provider.id,
              operation: 'create',
            })
          }
          return {
            execute: (call, execution, callSignal) =>
              instance.run(
                (joined) => runtime.execute(call, execution, joined),
                AbortSignal.any([callSignal, owner.signal]),
              ),
            batch: (calls, execution, callSignal) =>
              instance.run(
                (joined) => runtime.batch(calls, execution, joined),
                AbortSignal.any([callSignal, owner.signal]),
              ),
            cancel: async () => {
              await runtime.cancel()
              await instance.drain()
            },
            dispose,
          }
        }, signal),
    }
    return this.registry.register(source, wrapped, this.ctx, () => owner.close(() => provider.cleanup?.()))
  }

  resolve(id: string) {
    return this.registry.resolve(id)
  }
  catalog() {
    return Object.freeze(
      this.registry
        .catalog()
        .map(({ id, version, sourcePackage }) => Object.freeze({ id, version, sourcePackage })),
    )
  }
}

export class ToolPoliciesService extends Service implements ToolPolicyRegistryPort {
  private readonly registry: ProviderRegistry<ToolPolicy>
  constructor(
    ctx: Context,
    private readonly origins?: RowOriginLookup,
  ) {
    super(ctx, 'toolPolicies')
    this.registry = installProviderRegistry(
      ctx,
      defineProviderKind<ToolPolicy>({
        kind: 'tool-policy',
        validate(policy) {
          if (typeof policy.decide !== 'function') throw new Error('Invalid tool policy')
        },
        capabilities: () => ['allow', 'ask', 'deny'],
      }),
      (owner, source, provider) => owner.toolPolicies.register(source, provider),
    )
  }
  register(sourcePackage: string, policy: ToolPolicy) {
    const source = providerSource(this.ctx, this.origins, sourcePackage, true)
    this.registry.validate(source, policy)
    const lifetime = new ProviderLifetime('tool-policy', policy.id)
    lifetime.own(() => policy.dispose?.())
    return this.registry.register(
      source,
      {
        ...policy,
        ...(policy.settings
          ? {
              settings: (context: ToolPolicySettingsContext, signal: AbortSignal) =>
                lifetime.run((joined) => policy.settings!(context, joined), signal),
            }
          : {}),
        decide: async (input, signal, ports) =>
          lifetime.run((joined) => policy.decide(input, joined, ports), signal),
        dispose: () => lifetime.close(() => policy.cleanup?.()),
      },
      this.ctx,
      () => lifetime.close(() => policy.cleanup?.()),
    )
  }

  resolve(id: string) {
    return this.registry.resolve(id)
  }
  catalog() {
    return Object.freeze(
      this.registry
        .catalog()
        .map(({ id, version, sourcePackage }) => Object.freeze({ id, version, sourcePackage })),
    )
  }
}

export class LoopEventsService extends Service implements LoopEventRegistryPort {
  private readonly registry = new LoopEventRegistry()
  constructor(ctx: Context) {
    super(ctx, 'loopEvents')
  }
  on<E extends LoopEventName>(event: E, handler: LoopEventHandler<E>) {
    return this.ctx.effect(() => this.registry.on(event, handler))
  }
  dispatch<E extends LoopEventName>(
    event: E,
    payload: LoopEventPayloadMap[E],
    context: LoopEventContext,
  ): Promise<LoopEventReturnMap[E]> {
    return this.registry.dispatch(event, payload, context)
  }
}
export function installToolProviders(root: Context, origins?: RowOriginLookup): void {
  new ToolRuntimesService(root, origins)
  new ToolPoliciesService(root, origins)
  new LoopEventsService(root)
}

/** Legacy embeddings can supply Base's seam table without its new named plugin export. Supply
 * the same ordinary default row, so those Hosts retain their existing approval behavior. */
export function withBuiltinToolPolicies(
  modules: ReadonlyMap<string, PackageModule>,
): ReadonlyMap<string, PackageModule> {
  const base = modules.get('@agnes/base')
  if (!base || base.plugins?.some((row) => row.declaration.id === 'tool-policy:default')) return modules
  const result = new Map(modules)
  result.set('@agnes/base', {
    ...base,
    plugins: [
      ...(base.plugins ?? []),
      {
        declaration: {
          id: 'tool-policy:default',
          export: 'toolPolicyPlugin',
          apiRange: '^1.4.0',
          default: true,
          inject: ['toolPolicies'],
          provide: [],
          runtime: 'in-process',
        },
        entry: normalizePluginExport({
          inject: ['toolPolicies'],
          apply(ctx: Context) {
            ctx.toolPolicies.register('@agnes/base', defaultToolPolicy)
          },
        }),
      },
    ],
  })
  return result
}
