import { type Context, Service } from '@agnes/cordis'
import {
  defineProviderKind,
  type LoopDriver,
  type LoopFactory,
  type LoopRegistryPort,
  type LoopSelection,
  ProviderError,
  withDeferredToolInvocations,
} from '@agnes/extension-api'
import './deferred-invocations.js'
import { ProviderLifetime } from '@agnes/host-common/assemble/provider-lifetime'
import {
  installProviderRegistry,
  type ProviderRegistry,
  providerSource,
} from '@agnes/host-common/assemble/provider-registry'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'

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
    const own = async (driver: LoopDriver, signal: AbortSignal): Promise<LoopDriver> => {
      const valid =
        driver &&
        ['step', 'cancel', 'dispose', 'checkpoint'].every(
          (key) => typeof driver[key as keyof LoopDriver] === 'function',
        )
      const instance = new ProviderLifetime('loop', factory.id)
      if (valid) drivers.add(driver)
      const dispose = lifetime.own(() =>
        instance.close(
          async () => {
            if (typeof driver?.dispose === 'function') await driver.dispose()
            drivers.delete(driver)
          },
          () => {
            if (typeof driver?.cancel === 'function') return driver.cancel()
          },
        ),
      )
      if (!valid || signal.aborted) {
        await dispose()
        signal.throwIfAborted()
        throw new ProviderError('E_PROVIDER_INVALID', 'Loop factory returned an invalid driver', {
          kind: 'loop',
          provider: factory.id,
          operation: 'create',
        })
      }
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
        create: (ctx, signal) =>
          lifetime.run(async (joined) => own(await factory.create(ctx, joined), joined), signal),
        resume: (ctx, checkpoint, signal) =>
          lifetime.run(async (joined) => own(await factory.resume(ctx, checkpoint, joined), joined), signal),
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
    const factory = this.registry.resolve({ provider: selection.id, version: selection.version })
    return withDeferredToolInvocations(factory, (key, lane) =>
      this.ctx.deferredInvocations?.forSession(key, lane),
    )
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
