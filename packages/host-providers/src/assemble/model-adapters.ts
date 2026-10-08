import { modelAdaptersPlugin, WireAdapter } from '@agnes/ai'
import { type Context, Service } from '@agnes/cordis'
import type {
  ModelAdapter,
  ModelAdapterCatalogEntry,
  ModelAdapterConfig,
  ModelAdapterInstance,
  ModelAdapterRegistration,
} from '@agnes/extension-api'
import { defineProviderKind, ProviderError } from '@agnes/extension-api'
import { ProviderLifetime } from '@agnes/host-common/assemble/provider-lifetime'
import {
  installProviderRegistry,
  type ProviderRegistry,
  providerSource,
} from '@agnes/host-common/assemble/provider-registry'
import type { PackageModule } from '@agnes/host-extensions/assemble/packages'
import { scriptedAdapter } from '@agnes/model-adapters'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'

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
  lifetime: ProviderLifetime
}

/** Community adapters receive the existing facade's credential and wire path. */
class CommunityWireAdapter extends WireAdapter {
  readonly id: string
  complete?: NonNullable<ModelAdapterInstance['complete']>
  constructor(
    private readonly instance: ModelAdapterInstance,
    override readonly version: string,
    private readonly lifecycle: ProviderLifetime,
    private readonly registration: AbortSignal,
  ) {
    super()
    this.id = instance.id
    const complete = instance.complete?.bind(instance)
    if (complete)
      this.complete = (route, request, options) => {
        this.assertActive()
        return lifecycle.run(
          (signal) => complete(route, request, { ...options, signal }),
          AbortSignal.any([options.signal, registration]),
        )
      }
    const count = instance.count?.bind(instance)
    if (count)
      this.count = (route, request, options) => {
        this.assertActive()
        return lifecycle.run(
          (signal) => count(route, request, { signal }),
          AbortSignal.any([options.signal, registration]),
        )
      }
    const refresh = instance.refresh?.bind(instance)
    if (refresh)
      this.refresh = (route, signal) => {
        this.assertActive()
        return lifecycle.run((joined) => refresh(route, joined), AbortSignal.any([signal, registration]))
      }
    const probe = instance.probe?.bind(instance)
    if (probe)
      this.probe = (route, signal) => {
        this.assertActive()
        return lifecycle.run((joined) => probe(route, joined), AbortSignal.any([signal, registration]))
      }
  }
  routes() {
    this.assertActive()
    return this.instance.routes()
  }
  models(route: string) {
    this.assertActive()
    return this.instance.models(route)
  }
  private assertActive(): void {
    if (this.lifecycle.signal.aborted || this.registration.aborted)
      throw new ProviderError('E_PROVIDER_UNAVAILABLE', 'model adapter instance is disposed', {
        kind: 'model-adapter',
        provider: this.id,
        operation: 'invoke',
      })
  }
  stream(
    route: string,
    request: Parameters<ModelAdapterInstance['stream']>[1],
    options: Parameters<ModelAdapterInstance['stream']>[2],
  ) {
    this.assertActive()
    const instance = this.instance,
      lifecycle = this.lifecycle
    const signal = AbortSignal.any([options.signal, lifecycle.signal, this.registration])
    return {
      [Symbol.asyncIterator]() {
        lifecycle.assertActive()
        signal.throwIfAborted()
        const iterator = instance.stream(route, request, { ...options, signal })[Symbol.asyncIterator]()
        const close = lifecycle.own(async () => {
          await iterator.return?.()
        })
        return {
          next: () =>
            lifecycle.run(async () => {
              const result = await iterator.next()
              if (result.done) await close()
              return result
            }, signal),
          return: async () => {
            await close()
            return { done: true as const, value: undefined }
          },
        }
      },
    }
  }

  override bindCredential(route: string, value: string | undefined): void {
    this.assertActive()
    super.bindCredential(route, value)
    if (!this.instance.bindCredential)
      throw new ProviderError(
        'E_PROVIDER_INVALID',
        'credentialed model adapter must implement bindCredential',
        { kind: 'model-adapter', provider: this.id, operation: 'bindCredential' },
      )
    this.instance.bindCredential(route, this.credentialFor(route))
  }
}

/** Per-Cordis-root catalog; registrations and instances follow the owning plugin fiber. */
export class ModelAdapterRegistry extends Service implements ModelAdapterRegistration {
  private readonly registrations: ProviderRegistry<ModelAdapter>
  private readonly records = new Map<string, Registration>()

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
            typeof (adapter.wireApi ?? adapter.api) !== 'string' ||
            !(adapter.wireApi ?? adapter.api)?.trim() ||
            (adapter.wireApi !== undefined && adapter.api !== undefined && adapter.wireApi !== adapter.api) ||
            !adapter.version ||
            typeof adapter.create !== 'function' ||
            !adapter.capabilities ||
            ['imageInput', 'tools', 'streaming'].some(
              (key) => typeof adapter.capabilities[key as keyof typeof adapter.capabilities] !== 'boolean',
            )
          )
            throw new Error('invalid model adapter registration')
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
    const record: Registration = {
      id: adapter.id,
      version: adapter.version,
      adapter,
      entry: Object.freeze({
        id: adapter.id,
        wireApi: adapter.wireApi ?? adapter.api!,
        api: adapter.wireApi ?? adapter.api!,
        version: adapter.version,
        sourcePackage: providerSource(
          this.ctx,
          this.origins,
          sourcePackage ?? '@agnes/ai',
          sourcePackage !== undefined,
        ),
        capabilities: Object.freeze({ ...adapter.capabilities }),
      }),
      lifetime: new ProviderLifetime('model-adapter', adapter.id),
    }
    this.registrations.validate(record.entry.sourcePackage, adapter)
    const unregister = this.registrations.register(
      record.entry.sourcePackage,
      {
        ...adapter,
        create: async (config, signal) => {
          const managed = await this.createOwned(record, config, signal)
          const wire = managed.adapter
          return {
            id: wire.id,
            routes: () => wire.routes(),
            models: (route) => wire.models(route),
            stream: (route, request, options) => wire.stream(route, request, options),
            bindCredential: (route, value) => wire.bindCredential(route, value),
            ...(wire.complete ? { complete: wire.complete.bind(wire) } : {}),
            ...(wire.count ? { count: wire.count.bind(wire) } : {}),
            ...(wire.refresh ? { refresh: wire.refresh.bind(wire) } : {}),
            ...(wire.probe ? { probe: wire.probe.bind(wire) } : {}),
            dispose: managed.dispose,
          }
        },
      },
      this.ctx,
      () =>
        record.lifetime
          .close(() => adapter.cleanup?.())
          .finally(() => {
            if (this.records.get(adapter.id) === record) this.records.delete(adapter.id)
          }),
    )
    this.records.set(adapter.id, record)
    return unregister
  }

  catalog(): readonly ModelAdapterCatalogEntry[] {
    return Object.freeze(
      this.registrations
        .catalog()
        .map((r) => this.records.get(r.id)!.entry)
        .sort((a, b) => a.id.localeCompare(b.id)),
    )
  }

  async create(
    id: string,
    config: ModelAdapterConfig,
    creationSignal?: AbortSignal,
  ): Promise<{
    adapter: WireAdapter
    dispose(): Promise<void>
  }> {
    const record = this.records.get(this.registrations.resolve(id).id)!
    return this.createOwned(record, config, creationSignal)
  }
  private createOwned(
    record: Registration,
    config: ModelAdapterConfig,
    creationSignal?: AbortSignal,
  ): Promise<{ adapter: CommunityWireAdapter; dispose(): Promise<void> }> {
    const id = record.id
    return record.lifetime.run(async (signal) => {
      const instance = await record.adapter.create(config, signal)
      const lifecycle = new ProviderLifetime('model-adapter', id)
      const dispose = record.lifetime.own(() => lifecycle.close(() => instance?.dispose?.()))
      if (signal.aborted) {
        await dispose()
        signal.throwIfAborted()
      }
      if (
        !instance ||
        typeof instance.id !== 'string' ||
        ['routes', 'models', 'stream'].some(
          (key) => typeof instance[key as 'routes' | 'models' | 'stream'] !== 'function',
        )
      ) {
        await dispose()
        throw new ProviderError(
          'E_PROVIDER_INVALID',
          `model adapter returned an invalid wire adapter: ${id}`,
          { kind: 'model-adapter', provider: id, operation: 'create' },
        )
      }
      this.registrations.select(`adapter:${id}`, id)
      return {
        adapter: new CommunityWireAdapter(instance, record.version, lifecycle, record.lifetime.signal),
        dispose,
      }
    }, creationSignal)
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
