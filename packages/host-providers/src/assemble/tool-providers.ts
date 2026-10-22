import { type Context, Service } from '@agnes/cordis'
import { defaultToolRuntimeProvider, LoopEventRegistry } from '@agnes/core'
import type {
  LoopEventContext,
  LoopEventHandler,
  LoopEventName,
  LoopEventPayloadMap,
  LoopEventRegistryPort,
  LoopEventReturnMap,
  ToolPolicy,
  ToolPolicySettingsContext,
  ToolRuntimeProvider,
} from '@agnes/extension-api'
import { ProviderError, toolPolicyKind, toolRuntimeKind } from '@agnes/extension-api'
import { ProviderLifetime } from '@agnes/host-common/assemble/provider-lifetime'
import {
  installProviderRegistry,
  type ProviderRegistry,
  providerSource,
} from '@agnes/host-common/assemble/provider-registry'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'

declare module '@agnes/cordis' {
  interface Context {
    loopEvents: LoopEventRegistryPort
  }
}

function installToolRuntimes(ctx: Context, origins?: RowOriginLookup): void {
  const register = (ownerContext: Context, sourcePackage: string, provider: ToolRuntimeProvider) => {
    const source = providerSource(ownerContext, origins, sourcePackage)
    registry.validate(source, provider)
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
    return registry.register(source, wrapped, ownerContext, () => owner.close(() => provider.cleanup?.()))
  }
  const registry: ProviderRegistry<ToolRuntimeProvider> = installProviderRegistry(
    ctx,
    toolRuntimeKind,
    register,
  )
  ctx.providers.registerHost(toolRuntimeKind, '@agnes/core', defaultToolRuntimeProvider)
}

function installToolPolicies(ctx: Context, origins?: RowOriginLookup): void {
  const register = (ownerContext: Context, sourcePackage: string, policy: ToolPolicy) => {
    const source = providerSource(ownerContext, origins, sourcePackage)
    registry.validate(source, policy)
    const lifetime = new ProviderLifetime('tool-policy', policy.id)
    lifetime.own(() => policy.dispose?.())
    return registry.register(
      source,
      {
        ...policy,
        ...(policy.settings
          ? {
              settings: async (context: ToolPolicySettingsContext, signal: AbortSignal) =>
                lifetime.run((joined) => policy.settings!(context, joined), signal),
            }
          : {}),
        decide: async (input, signal, ports) =>
          lifetime.run((joined) => policy.decide(input, joined, ports), signal),
        dispose: () => lifetime.close(() => policy.cleanup?.()),
      },
      ownerContext,
      () => lifetime.close(() => policy.cleanup?.()),
    )
  }
  const registry: ProviderRegistry<ToolPolicy> = installProviderRegistry(ctx, toolPolicyKind, register)
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
  installToolRuntimes(root, origins)
  installToolPolicies(root, origins)
  new LoopEventsService(root)
}
