import { type Context, Service } from '@agnes/cordis'
import { LoopEventRegistry, ToolPolicyRegistry, ToolRuntimeRegistry, defaultToolPolicy } from '@agnes/core'
import type {
  LoopEventRegistryPort,
  LoopEventName,
  LoopEventHandler,
  LoopEventPayloadMap,
  LoopEventReturnMap,
  LoopEventContext,
  ToolPolicy,
  ToolPolicyRegistryPort,
  ToolRuntimeProvider,
  ToolRuntimeRegistryPort,
} from '@agnes/extension-api'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import type { PackageModule } from './packages.js'

declare module '@agnes/cordis' {
  interface Context {
    toolRuntimes: ToolRuntimeRegistryPort
    toolPolicies: ToolPolicyRegistryPort
    loopEvents: LoopEventRegistryPort
  }
}

function sourceFor(ctx: Context, origins: RowOriginLookup | undefined, claimed: string): string {
  for (let fiber = ctx.fiber; fiber !== fiber.parent.fiber; fiber = fiber.parent.fiber) {
    const origin = origins?.lookup(fiber)
    if (origin) {
      // Host-built static claims use the sentinel package identity `builtin`.
      if (origin.trustTier === 'builtin' && origin.packageId === 'builtin') return claimed
      if (origin.packageId !== claimed)
        throw new Error('Tool provider source package does not match its plugin row')
      return origin.packageId
    }
  }
  return claimed
}

export class ToolRuntimesService extends Service implements ToolRuntimeRegistryPort {
  private readonly registry = new ToolRuntimeRegistry()
  constructor(
    ctx: Context,
    private readonly origins?: RowOriginLookup,
  ) {
    super(ctx, 'toolRuntimes')
  }
  register(sourcePackage: string, provider: ToolRuntimeProvider) {
    const source = sourceFor(this.ctx, this.origins, sourcePackage)
    const lifetime = new AbortController()
    const wrapped: ToolRuntimeProvider = {
      ...provider,
      create: (options) => {
        if (lifetime.signal.aborted) throw new Error('Tool runtime provider was unloaded')
        const runtime = provider.create(options)
        return {
          execute: (call, execution, signal) => {
            lifetime.signal.throwIfAborted()
            return runtime.execute(call, execution, AbortSignal.any([signal, lifetime.signal]))
          },
          batch: (calls, execution, signal) => {
            lifetime.signal.throwIfAborted()
            return runtime.batch(calls, execution, AbortSignal.any([signal, lifetime.signal]))
          },
          cancel: () => runtime.cancel(),
          dispose: () => runtime.dispose(),
        }
      },
    }
    return this.ctx.effect(() => {
      const dispose = this.registry.register(source, wrapped)
      return () => {
        lifetime.abort()
        dispose()
      }
    })
  }
  resolve(id: string) {
    return this.registry.resolve(id)
  }
  catalog() {
    return this.registry.catalog()
  }
}

export class ToolPoliciesService extends Service implements ToolPolicyRegistryPort {
  private readonly registry = new ToolPolicyRegistry(false)
  constructor(
    ctx: Context,
    private readonly origins?: RowOriginLookup,
  ) {
    super(ctx, 'toolPolicies')
  }
  register(sourcePackage: string, policy: ToolPolicy) {
    const source = sourceFor(this.ctx, this.origins, sourcePackage)
    const lifetime = new AbortController()
    return this.ctx.effect(() => {
      const dispose = this.registry.register(source, {
        ...policy,
        async decide(input, signal) {
          lifetime.signal.throwIfAborted()
          const result = await policy.decide(input, AbortSignal.any([signal, lifetime.signal]))
          lifetime.signal.throwIfAborted()
          return result
        },
      })
      return () => {
        lifetime.abort()
        dispose()
      }
    })
  }
  resolve(id: string) {
    return this.registry.resolve(id)
  }
  catalog() {
    return this.registry.catalog()
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
