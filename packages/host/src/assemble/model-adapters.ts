import { modelAdaptersPlugin, WireAdapter } from '@agnes/ai'
import { type Context, Service } from '@agnes/cordis'
import type {
  ModelAdapter,
  ModelAdapterCatalogEntry,
  ModelAdapterConfig,
  ModelAdapterInstance,
  ModelAdapterRegistration,
} from '@agnes/extension-api'
import type { RowOrigin, RowOriginLookup } from '@agnes/plugin-runtime/host'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { HostError } from '../errors.js'
import type { PackageModule } from './packages.js'

declare module '@agnes/cordis' {
  interface Context {
    modelAdapters: ModelAdapterRegistry
  }
}

type Registration = {
  adapter: ModelAdapter
  entry: ModelAdapterCatalogEntry
  active: boolean
  instances: Set<() => Promise<void>>
}

/** Community adapters receive the existing facade's credential and wire path. */
class CommunityWireAdapter extends WireAdapter {
  readonly id: string
  constructor(
    private readonly instance: ModelAdapterInstance,
    private readonly lifecycle: AbortSignal,
  ) {
    super()
    this.id = instance.id
    const count = instance.count?.bind(instance)
    if (count)
      this.count = (route, request, options) => {
        this.assertActive()
        return count(route, request, { signal: AbortSignal.any([options.signal, lifecycle]) })
      }
    const refresh = instance.refresh?.bind(instance)
    if (refresh)
      this.refresh = (route, signal) => {
        this.assertActive()
        return refresh(route, AbortSignal.any([signal, lifecycle]))
      }
    const probe = instance.probe?.bind(instance)
    if (probe)
      this.probe = (route, signal) => {
        this.assertActive()
        return probe(route, AbortSignal.any([signal, lifecycle]))
      }
  }
  routes() {
    return this.instance.routes()
  }
  models(route: string) {
    return this.instance.models(route)
  }
  private assertActive(): void {
    if (this.lifecycle.aborted) throw new HostError('E_DEP_MISSING', 'model adapter instance is disposed')
  }
  stream(
    route: string,
    request: Parameters<ModelAdapterInstance['stream']>[1],
    options: Parameters<ModelAdapterInstance['stream']>[2],
  ) {
    this.assertActive()
    return this.instance.stream(route, request, {
      ...options,
      signal: AbortSignal.any([options.signal, this.lifecycle]),
    })
  }
  override bindCredential(route: string, value: string | undefined): void {
    super.bindCredential(route, value)
    if (!this.instance.bindCredential)
      throw new HostError('E_API_RANGE', 'credentialed model adapter must implement bindCredential')
    this.instance.bindCredential(route, this.credentialFor(route))
  }
}

/** Per-Cordis-root catalog; registrations and instances follow the owning plugin fiber. */
export class ModelAdapterRegistry extends Service implements ModelAdapterRegistration {
  private readonly registrations = new Map<string, Registration>()

  constructor(
    ctx: Context,
    private readonly origins?: RowOriginLookup,
  ) {
    super(ctx, 'modelAdapters')
  }

  register(adapter: ModelAdapter): () => Promise<void> {
    if (
      !adapter.id ||
      !adapter.api ||
      !adapter.version ||
      typeof adapter.create !== 'function' ||
      !adapter.capabilities ||
      ['imageInput', 'tools', 'streaming'].some(
        (key) => typeof adapter.capabilities[key as keyof typeof adapter.capabilities] !== 'boolean',
      )
    )
      throw new HostError('E_API_RANGE', 'invalid model adapter registration')
    if (this.registrations.has(adapter.id))
      throw new HostError('E_API_RANGE', `duplicate model adapter: ${adapter.id}`)
    let origin: Readonly<RowOrigin> | undefined
    for (let fiber = this.ctx.fiber; fiber !== fiber.parent.fiber; fiber = fiber.parent.fiber) {
      origin = this.origins?.lookup(fiber)
      if (origin) break
    }
    if (this.origins && !origin && this.ctx !== this.ctx.root)
      throw new HostError('E_EXT_LOAD', 'model adapter requires a verified plugin row')
    const record: Registration = {
      adapter,
      entry: Object.freeze({
        id: adapter.id,
        api: adapter.api,
        version: adapter.version,
        sourcePackage:
          origin?.trustTier === 'builtin' && origin.rowId === 'model-adapters:pi'
            ? '@agnes/ai'
            : (origin?.packageId ?? '@agnes/ai'),
        capabilities: Object.freeze({ ...adapter.capabilities }),
      }),
      active: true,
      instances: new Set(),
    }
    return this.ctx.effect(() => {
      this.registrations.set(record.entry.id, record)
      return async () => {
        record.active = false
        this.registrations.delete(record.entry.id)
        const results = await Promise.allSettled([...record.instances].map((dispose) => dispose()))
        await adapter.cleanup?.()
        const failures = results.filter((result) => result.status === 'rejected')
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            'adapter cleanup failed',
          )
      }
    }, `modelAdapters.register(${adapter.id})`)
  }

  catalog(): readonly ModelAdapterCatalogEntry[] {
    return Object.freeze(
      [...this.registrations.values()].map((r) => r.entry).sort((a, b) => a.id.localeCompare(b.id)),
    )
  }

  async create(
    id: string,
    config: ModelAdapterConfig,
    builtin?: () => ModelAdapterInstance,
  ): Promise<{
    adapter: WireAdapter
    dispose(): Promise<void>
  }> {
    const record = this.registrations.get(id)
    if (!record?.active)
      throw new HostError('E_DEP_MISSING', `model adapter is not registered: ${id}`, {
        detail: { reason: 'adapter-missing', id },
      })
    // Only Host's reviewed API-key/OAuth factories supply a prepared builtin instance.
    const instance =
      builtin && record.entry.sourcePackage === '@agnes/ai' ? builtin() : await record.adapter.create(config)
    const lifecycle = new AbortController()
    let disposal: Promise<void> | undefined
    const dispose = () => {
      lifecycle.abort()
      disposal ??= Promise.resolve()
        .then(() => instance?.dispose?.())
        .then(() => undefined)
      record.instances.delete(dispose)
      return disposal
    }
    if (!record.active) {
      await dispose()
      throw new HostError('E_DEP_MISSING', `model adapter was unloaded: ${id}`)
    }
    record.instances.add(dispose)
    if (
      !instance ||
      typeof instance.id !== 'string' ||
      ['routes', 'models', 'stream'].some(
        (key) => typeof instance[key as 'routes' | 'models' | 'stream'] !== 'function',
      )
    ) {
      await dispose()
      throw new HostError('E_API_RANGE', `model adapter returned an invalid wire adapter: ${id}`)
    }
    return {
      adapter: new CommunityWireAdapter(instance, lifecycle.signal),
      dispose,
    }
  }
}

/** Builtins use exactly the same registration contract as community plugin rows. */
export function installModelAdapters(root: Context, origins?: RowOriginLookup): ModelAdapterRegistry {
  return new ModelAdapterRegistry(root, origins)
}

/** Build the builtin supplier as an ordinary package-owned plugin row. */
export function withBuiltinModelAdapters(
  modules: ReadonlyMap<string, PackageModule>,
): ReadonlyMap<string, PackageModule> {
  const builtin = modules.get('@agnes/ai')
  if (!builtin || builtin.plugins?.some((plugin) => plugin.declaration.id === 'model-adapters:pi'))
    return modules
  const result = new Map(modules)
  result.set('@agnes/ai', {
    ...builtin,
    plugins: [
      ...(builtin.plugins ?? []),
      {
        declaration: {
          id: 'model-adapters:pi',
          export: 'modelAdaptersPlugin',
          default: true,
          inject: ['modelAdapters'],
          provide: [],
          runtime: 'in-process',
        },
        entry: normalizePluginExport(modelAdaptersPlugin),
      },
    ],
  })
  return result
}

/** Read-only admin metadata, without config, credentials or factories. */
export function modelAdapterCatalog(root: Context): readonly ModelAdapterCatalogEntry[] {
  return root.modelAdapters.catalog()
}
