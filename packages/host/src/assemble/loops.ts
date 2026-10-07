import { type Context, Service } from '@agnes/cordis'
import { LoopRegistry } from '@agnes/core'
import type { LoopFactory, LoopRegistryPort, LoopSelection } from '@agnes/extension-api'
import type { RowOrigin, RowOriginLookup } from '@agnes/plugin-runtime/host'
import { HostError } from '../errors.js'

declare module '@agnes/cordis' {
  interface Context {
    loops: LoopRegistryPort
  }
}

/** Each plugin tree owns its catalog; registration follows the verified package fiber. */
export class LoopsService extends Service implements LoopRegistryPort {
  private readonly registry = new LoopRegistry()
  constructor(
    ctx: Context,
    private readonly origins?: RowOriginLookup,
  ) {
    super(ctx, 'loops')
  }
  register(sourcePackage: string, factory: LoopFactory): () => void {
    let origin: Readonly<RowOrigin> | undefined
    for (let fiber = this.ctx.fiber; fiber !== fiber.parent.fiber; fiber = fiber.parent.fiber) {
      origin = this.origins?.lookup(fiber)
      if (origin) break
    }
    if (this.origins && !origin && this.ctx !== this.ctx.root)
      throw new HostError('E_EXT_LOAD', 'loop requires a verified plugin row')
    if (origin && origin.packageId !== sourcePackage)
      throw new HostError('E_EXT_LOAD', 'loop source package does not match its plugin row')
    return this.ctx.effect(
      () => this.registry.register(origin?.packageId ?? sourcePackage, factory),
      `loops.register(${factory.id}@${factory.version})`,
    )
  }
  resolve(selection: LoopSelection) {
    return this.registry.resolve(selection)
  }
  catalog() {
    return this.registry.catalog()
  }
}

export function installLoops(root: Context, origins?: RowOriginLookup): LoopRegistryPort {
  return new LoopsService(root, origins)
}
