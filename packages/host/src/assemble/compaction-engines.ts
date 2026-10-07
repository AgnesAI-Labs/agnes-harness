import { type Context, Service } from '@agnes/cordis'
import { CompactionRunner } from '@agnes/core'
import type {
  CompactionEngine,
  CompactionEngineCatalogEntry,
  CompactionEngineInstance,
  CompactionEngineRegistration,
} from '@agnes/extension-api'
import { defineProviderKind, ProviderError } from '@agnes/extension-api'
import { normalizePluginExport, type RowOriginLookup } from '@agnes/plugin-runtime/host'
import type { PackageModule } from './packages.js'
import { ProviderLifetime } from './provider-lifetime.js'
import { installProviderRegistry, type ProviderRegistry, providerSource } from './provider-registry.js'

declare module '@agnes/cordis' {
  interface Context {
    compactionEngines: CompactionEngineRegistry
  }
}

export class CompactionEngineRegistry extends Service implements CompactionEngineRegistration {
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
    this.registry = installProviderRegistry(
      ctx,
      defineProviderKind<CompactionEngine>({
        kind: 'compaction',
        validate(engine) {
          if (
            typeof engine?.id !== 'string' ||
            !engine.id.trim() ||
            typeof engine.version !== 'string' ||
            !engine.version.trim() ||
            typeof engine.create !== 'function'
          )
            throw new Error('invalid compaction engine registration')
        },
        capabilities: () => ['budget', 'summarize'],
      }),
      (owner, source, provider) => owner.compactionEngines.register(provider, source),
    )
  }

  register(engine: CompactionEngine, sourcePackage?: string): () => Promise<void> {
    const record = {
      id: engine.id,
      version: engine.version,
      engine,
      entry: Object.freeze({
        id: engine.id,
        version: engine.version,
        sourcePackage: providerSource(
          this.ctx,
          this.origins,
          sourcePackage ?? '@agnes/base',
          sourcePackage !== undefined,
        ),
      }),
      lifetime: new ProviderLifetime('compaction', engine.id),
    }
    this.registry.validate(record.entry.sourcePackage, engine)
    const wrapped: CompactionEngine = { ...engine, create: (signal) => this.createOwned(record, signal) }
    const unregister = this.registry.register(record.entry.sourcePackage, wrapped, this.ctx, () =>
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

/** Supply Base's default through the same ordinary row and registry as community engines. */
export function withBuiltinCompactionEngines(
  modules: ReadonlyMap<string, PackageModule>,
): ReadonlyMap<string, PackageModule> {
  const builtin = modules.get('@agnes/base')
  if (
    !builtin?.buildCompactionPlan ||
    builtin.plugins?.some((row) => row.declaration.id === 'compaction-engine:default')
  )
    return modules
  const plan = builtin.buildCompactionPlan
  const defaultEngine: CompactionEngine = builtin.createDefaultCompactionEngine?.(plan) ?? {
    id: 'default',
    version: '1.0.0',
    create: () =>
      new CompactionRunner({
        plan: async (payload, config) => plan(payload, config),
        onCompact: async () => undefined,
      }),
  }
  const result = new Map(modules)
  result.set('@agnes/base', {
    ...builtin,
    plugins: [
      ...(builtin.plugins ?? []),
      {
        declaration: {
          id: 'compaction-engine:default',
          export: 'compactionEnginePlugin',
          default: true,
          inject: ['compactionEngines'],
          provide: [],
          runtime: 'in-process',
        },
        entry: normalizePluginExport({
          inject: ['compactionEngines'],
          apply(ctx: Context) {
            ctx.compactionEngines.register(defaultEngine)
          },
        }),
      },
    ],
  })
  return result
}

export function compactionEngineCatalog(root: Context): readonly CompactionEngineCatalogEntry[] {
  return root.compactionEngines.catalog()
}
