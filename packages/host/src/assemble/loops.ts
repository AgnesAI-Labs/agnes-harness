import { type Context, Service } from '@agnes/cordis'
import { CoreError, defaultLoopFactory } from '@agnes/core'
import {
  defineProviderKind,
  type LoopFactory,
  type LoopRegistryPort,
  type LoopSelection,
} from '@agnes/extension-api'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
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
    this.registry.register('@agnes/core', defaultLoopFactory, ctx)
  }
  register(sourcePackage: string, factory: LoopFactory): () => void {
    return this.registry.register(
      providerSource(this.ctx, this.origins, sourcePackage, true),
      factory,
      this.ctx,
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
