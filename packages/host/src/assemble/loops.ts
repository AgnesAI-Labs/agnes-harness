import { type Context, Service } from '@agnes/cordis'
import { CoreError } from '@agnes/core'
import {
  defineProviderKind,
  type LoopDriver,
  type LoopFactory,
  type LoopRegistryPort,
  type LoopSelection,
} from '@agnes/extension-api'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import { ProviderLifetime } from './provider-lifetime.js'
import { installProviderRegistry, type ProviderRegistry, providerSource } from './provider-registry.js'

declare module '@agnes/cordis' {
  interface Context {
    loops: LoopRegistryPort
  }
}

/** Each plugin tree owns its catalog; registration follows the verified package fiber. */
export class LoopsService extends Service implements LoopRegistryPort {
  private readonly registry: ProviderRegistry<LoopFactory>
  constructor(
    ctx: Context,
    private readonly origins?: RowOriginLookup,
  ) {
    super(ctx, 'loops')
    this.registry = installProviderRegistry(
      ctx,
      defineProviderKind<LoopFactory>({
        kind: 'loop',
        versioned: true,
        validate(factory) {
          if (
            !Array.isArray(factory.capabilities) ||
            typeof factory.create !== 'function' ||
            typeof factory.resume !== 'function' ||
            !factory.codec
          )
            throw new Error('Invalid loop factory')
        },
        capabilities: (factory) => factory.capabilities,
      }),
      (owner, source, provider) => owner.loops.register(source, provider),
    )
  }
  register(sourcePackage: string, factory: LoopFactory): () => Promise<void> {
    const lifetime = new ProviderLifetime('loop', factory.id)
    const drivers = new Set<LoopDriver>()
    const own = (driver: LoopDriver): LoopDriver => {
      const instance = new ProviderLifetime('loop', factory.id)
      drivers.add(driver)
      const dispose = lifetime.own(() =>
        instance.close(
          async () => {
            await driver.dispose()
            drivers.delete(driver)
          },
          () => driver.cancel(),
        ),
      )
      return {
        step(signal) {
          lifetime.assertActive()
          instance.assertActive()
          const joined = AbortSignal.any([signal, lifetime.signal, instance.signal])
          return instance.track(Promise.resolve().then(() => driver.step(joined)))
        },
        cancel: () => driver.cancel(),
        dispose,
        checkpoint: () => driver.checkpoint(),
      }
    }
    return this.registry.register(
      providerSource(this.ctx, this.origins, sourcePackage, true),
      {
        ...factory,
        create(ctx) {
          lifetime.assertActive()
          return own(factory.create(ctx))
        },
        resume(ctx, checkpoint) {
          lifetime.assertActive()
          return own(factory.resume(ctx, checkpoint))
        },
      },
      this.ctx,
      () =>
        lifetime.close(undefined, async () => {
          const results = await Promise.allSettled([...drivers].map((driver) => driver.cancel()))
          const failures = results.filter((result) => result.status === 'rejected')
          if (failures.length)
            throw new AggregateError(
              failures.map((result) => result.reason),
              'Loop cancellation failed',
            )
        }),
    )
  }
  resolve(selection: LoopSelection) {
    try {
      return this.registry.resolve({ provider: selection.id, version: selection.version })
    } catch (error) {
      throw new CoreError(
        'E_LOOP_MISSING',
        `Loop ${selection.id}@${selection.version} is not installed; install and enable that id and version before opening the session`,
        { loop: selection },
      )
    }
  }
  catalog() {
    return Object.freeze(
      this.registry
        .catalog()
        .map(({ id, version, sourcePackage, capabilities }) =>
          Object.freeze({ id, version, sourcePackage, capabilities }),
        ),
    )
  }
}

export function installLoops(root: Context, origins?: RowOriginLookup): LoopRegistryPort {
  return new LoopsService(root, origins)
}
