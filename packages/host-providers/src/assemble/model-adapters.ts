import { WireAdapter } from '@agnes/ai'
import { type Context, Service } from '@agnes/cordis'
import type {
  ModelAdapter,
  ModelAdapterCatalogEntry,
  ModelAdapterConfig,
  ModelAdapterInstance,
} from '@agnes/extension-api'
import { modelAdapterKind, ProviderError } from '@agnes/extension-api'
import { ProviderLifetime } from '@agnes/host-common/assemble/provider-lifetime'
import {
  installProviderRegistry,
  type ProviderRegistry,
  providerSource,
} from '@agnes/host-common/assemble/provider-registry'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'

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
    // Taken from the registration's declared capabilities rather than from the instance: an instance
    // can claim anything, and the declaration is what the catalog reports for this adapter.
    override readonly acceptsPayload: boolean,
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
export class ModelAdapterRegistry extends Service {
  private readonly registrations: ProviderRegistry<ModelAdapter>
  private readonly records = new Map<string, Registration>()

  constructor(
    ctx: Context,
    private readonly origins?: RowOriginLookup,
  ) {
    super(ctx, 'modelAdapters')
    this.registrations = installProviderRegistry(ctx, modelAdapterKind, (owner, source, provider) =>
      this.registerOwned(owner, provider, source),
    )
  }

  private registerOwned(owner: Context, adapter: ModelAdapter, sourcePackage?: string): () => Promise<void> {
    const record: Registration = {
      id: adapter.id,
      version: adapter.version,
      adapter,
      entry: Object.freeze({
        id: adapter.id,
        wireApi: adapter.wireApi,
        version: adapter.version,
        sourcePackage: providerSource(owner, this.origins, sourcePackage),
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
      owner,
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
        adapter: new CommunityWireAdapter(
          instance,
          record.version,
          lifecycle,
          record.lifetime.signal,
          record.entry.capabilities.payload === true,
        ),
        dispose,
      }
    }, creationSignal)
  }
}

/** Builtins use exactly the same registration contract as community plugin rows. */
export function installModelAdapters(root: Context, origins?: RowOriginLookup): ModelAdapterRegistry {
  return new ModelAdapterRegistry(root, origins)
}

/** Read-only admin metadata, without config, credentials or factories. */
export function modelAdapterCatalog(root: Context): readonly ModelAdapterCatalogEntry[] {
  return root.modelAdapters.catalog()
}

export {
  builtinModelAdapterCatalog,
  builtinModelAdaptersPlugin,
  builtinModelSelectionData,
} from '@agnes/distribution'
