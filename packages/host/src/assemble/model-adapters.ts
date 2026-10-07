import { modelAdaptersPlugin, WireAdapter } from '@agnes/ai'
import { type Context, Service } from '@agnes/cordis'
import { defineProviderKind } from '@agnes/extension-api'
import type {
  ModelAdapter,
  ModelAdapterCatalogEntry,
  ModelAdapterConfig,
  ModelAdapterInstance,
  ModelAdapterRegistration,
} from '@agnes/extension-api'
import { scriptedAdapter } from '@agnes/model-adapters'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { HostError } from '../errors.js'
import type { PackageModule } from './packages.js'
import { installProviderRegistry, providerSource, type ProviderRegistry } from './provider-registry.js'

declare module '@agnes/cordis' {
  interface Context {
    modelAdapters: ModelAdapterRegistry
  }
}

type Registration = {
  id: string
  version: string
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
  private readonly registrations: ProviderRegistry<ModelAdapter>
  private readonly records = new WeakMap<ModelAdapter, Registration>()

  constructor(
    ctx: Context,
    private readonly origins?: RowOriginLookup,
  ) {
    super(ctx, 'modelAdapters')
    this.registrations = installProviderRegistry(
      ctx,
      defineProviderKind<ModelAdapter>({
        kind: 'model-adapter',
        validate(adapter) {
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
        },
        capabilities: (record) =>
          Object.entries(record.capabilities)
            .filter(([, enabled]) => enabled)
            .map(([name]) => name),
      }),
      (owner, source, provider) => owner.modelAdapters.register(provider, source),
    )
  }

  register(adapter: ModelAdapter, sourcePackage?: string): () => Promise<void> {
    this.registrations.definition.validate(adapter)
    const record: Registration = {
      id: adapter.id,
      version: adapter.version,
      adapter,
      entry: Object.freeze({
        id: adapter.id,
        api: adapter.api,
        version: adapter.version,
        sourcePackage: providerSource(
          this.ctx,
          this.origins,
          sourcePackage ?? '@agnes/ai',
          sourcePackage !== undefined,
        ),
        capabilities: Object.freeze({ ...adapter.capabilities }),
      }),
      active: true,
      instances: new Set(),
    }
    const unregister = this.registrations.register(
      record.entry.sourcePackage,
      adapter,
      this.ctx,
      async () => {
        record.active = false
        const results = await Promise.allSettled([...record.instances].map((dispose) => dispose()))
        await adapter.cleanup?.()
        const failures = results.filter((result) => result.status === 'rejected')
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            'adapter cleanup failed',
          )
      },
    )
    this.records.set(adapter, record)
    return unregister
  }

  catalog(): readonly ModelAdapterCatalogEntry[] {
    return Object.freeze(
      this.registrations
        .catalog()
        .map((r) => this.records.get(this.registrations.resolve(r.id))!.entry)
        .sort((a, b) => a.id.localeCompare(b.id)),
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
    const record = this.records.get(this.registrations.resolve(id))!
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
      if (!record.instances.size) this.registrations.clearSelection(`adapter:${id}`)
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
    this.registrations.select(`adapter:${id}`, id)
    return {
      adapter: new CommunityWireAdapter(instance, lifecycle.signal),
      dispose,
    }
  }
}

export const builtinModelAdaptersPlugin = {
  inject: ['modelAdapters'],
  apply(ctx: { modelAdapters: ModelAdapterRegistration }) {
    modelAdaptersPlugin.apply(ctx)
    ctx.modelAdapters.register(scriptedAdapter)
  },
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
  if (!builtin) return modules
  const result = new Map(modules)
  result.set('@agnes/ai', {
    ...builtin,
    plugins: [
      ...(builtin.plugins ?? []).filter((plugin) => plugin.declaration.id !== 'model-adapters:pi'),
      {
        declaration: {
          id: 'model-adapters:pi',
          export: 'modelAdaptersPlugin',
          default: true,
          inject: ['modelAdapters'],
          provide: [],
          runtime: 'in-process',
        },
        entry: normalizePluginExport(
          modules.has('@agnes/model-adapters') ? modelAdaptersPlugin : builtinModelAdaptersPlugin,
        ),
      },
    ],
  })
  return result
}

/** Read-only admin metadata, without config, credentials or factories. */
export function modelAdapterCatalog(root: Context): readonly ModelAdapterCatalogEntry[] {
  return root.modelAdapters.catalog()
}
