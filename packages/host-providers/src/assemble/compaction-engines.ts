import { type Context, Service } from '@agnes/cordis'
import type {
  CompactionEngine,
  CompactionEngineCatalogEntry,
  CompactionEngineInstance,
} from '@agnes/extension-api'
import { compactionKind, ProviderError } from '@agnes/extension-api'
import { ProviderLifetime } from '@agnes/host-common/assemble/provider-lifetime'
import {
  installProviderRegistry,
  type ProviderRegistry,
  providerSource,
} from '@agnes/host-common/assemble/provider-registry'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'

declare module '@agnes/cordis' {
  interface Context {
    compactionEngines: CompactionEngineRegistry
  }
}

export class CompactionEngineRegistry extends Service {
  private readonly registry: ProviderRegistry<CompactionEngine>
  private readonly records = new WeakMap<
    CompactionEngine,
    {
      engine: CompactionEngine
      entry: CompactionEngineCatalogEntry
      lifetime: ProviderLifetime
    }
  >()

  constructor(
    ctx: Context,
    private readonly origins?: RowOriginLookup,
  ) {
    super(ctx, 'compactionEngines')
    this.registry = installProviderRegistry(ctx, compactionKind, (owner, source, provider) =>
      this.registerOwned(owner, provider, source),
    )
  }

  private registerOwned(
    owner: Context,
    engine: CompactionEngine,
    sourcePackage?: string,
  ): () => Promise<void> {
    const record = {
      id: engine.id,
      version: engine.version,
      engine,
      entry: Object.freeze({
        id: engine.id,
        version: engine.version,
        sourcePackage: providerSource(owner, this.origins, sourcePackage),
      }),
      lifetime: new ProviderLifetime('compaction', engine.id),
    }
    this.registry.validate(record.entry.sourcePackage, engine)
    const wrapped: CompactionEngine = { ...engine, create: (signal) => this.createOwned(record, signal) }
    const unregister = this.registry.register(record.entry.sourcePackage, wrapped, owner, () =>
      record.lifetime.close(() => engine.cleanup?.()),
    )
    this.records.set(wrapped, record)
    return unregister
  }

  catalog(): readonly CompactionEngineCatalogEntry[] {
    return Object.freeze(
      this.registry
        .catalog()
        .map((record) => this.records.get(this.registry.resolve(record.id))!.entry)
        .sort((a, b) => a.id.localeCompare(b.id)),
    )
  }

  async create(id: string): Promise<CompactionEngineInstance> {
    const record = this.records.get(this.registry.select('host', id))!
    return this.createOwned(record)
  }
  private createOwned(
    record: { engine: CompactionEngine; lifetime: ProviderLifetime },
    signal?: AbortSignal,
  ): Promise<CompactionEngineInstance> {
    const id = record.engine.id
    return record.lifetime.run(async (creationSignal) => {
      const engine = await record.engine.create(creationSignal)
      const instance = new ProviderLifetime('compaction', id)
      const dispose = record.lifetime.own(() => instance.close(() => engine?.dispose?.()))
      if (creationSignal.aborted) {
        await dispose()
        creationSignal.throwIfAborted()
      }
      if (!engine || typeof engine.shouldCompact !== 'function' || typeof engine.compact !== 'function') {
        await dispose()
        throw new ProviderError('E_PROVIDER_INVALID', `invalid compaction engine instance: ${id}`, {
          kind: 'compaction',
          provider: id,
          operation: 'create',
        })
      }
      return {
        shouldCompact(budget) {
          record.lifetime.assertActive()
          instance.assertActive()
          return engine.shouldCompact(budget)
        },
        compact(input, ports) {
          record.lifetime.assertActive()
          return instance.run(
            (signal) =>
              engine.compact(input, {
                signal,
                model: {
                  summarize: (request, callSignal) =>
                    ports.model.summarize(
                      request,
                      callSignal ? AbortSignal.any([signal, callSignal]) : signal,
                    ),
                },
              }),
            AbortSignal.any([ports.signal, record.lifetime.signal]),
          )
        },
        dispose,
      }
    }, signal)
  }
}

export function installCompactionEngines(root: Context, origins?: RowOriginLookup): CompactionEngineRegistry {
  return new CompactionEngineRegistry(root, origins)
}

export function compactionEngineCatalog(root: Context): readonly CompactionEngineCatalogEntry[] {
  return root.compactionEngines.catalog()
}
