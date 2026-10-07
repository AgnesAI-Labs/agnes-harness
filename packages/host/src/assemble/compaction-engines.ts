import { type Context, Service } from '@agnes/cordis'
import { CompactionRunner } from '@agnes/core'
import type {
  CompactionEngine,
  CompactionEngineCatalogEntry,
  CompactionEngineInstance,
  CompactionEngineRegistration,
} from '@agnes/extension-api'
import { defineProviderKind } from '@agnes/extension-api'
import { normalizePluginExport, type RowOriginLookup } from '@agnes/plugin-runtime/host'
import { HostError } from '../errors.js'
import type { PackageModule } from './packages.js'
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
      lifetime: AbortController
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
        restartRequired: true,
        validate(engine) {
          if (
            typeof engine?.id !== 'string' ||
            !engine.id.trim() ||
            typeof engine.version !== 'string' ||
            !engine.version.trim() ||
            typeof engine.create !== 'function'
          )
            throw new HostError('E_API_RANGE', 'invalid compaction engine registration')
        },
        capabilities: () => ['budget', 'summarize'],
      }),
      (owner, source, provider) => owner.compactionEngines.register(provider, source),
    )
  }

  register(engine: CompactionEngine, sourcePackage?: string): () => void {
    this.registry.definition.validate(engine)
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
      lifetime: new AbortController(),
    }
    const unregister = this.registry.register(record.entry.sourcePackage, engine, this.ctx, () => {
      record.lifetime.abort()
    })
    this.records.set(engine, record)
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

  create(id: string): CompactionEngineInstance {
    const record = this.records.get(this.registry.select('host', id))!
    const instance = record.engine.create()
    if (!instance || typeof instance.shouldCompact !== 'function' || typeof instance.compact !== 'function')
      throw new HostError('E_API_RANGE', `invalid compaction engine instance: ${id}`)
    const active = () => {
      if (record.lifetime.signal.aborted)
        throw new HostError('E_DEP_MISSING', `compaction engine was unloaded: ${id}`)
    }
    return {
      shouldCompact(budget) {
        active()
        return instance.shouldCompact(budget)
      },
      async compact(input, ports) {
        active()
        const signal = AbortSignal.any([ports.signal, record.lifetime.signal])
        const output = await instance.compact(input, {
          signal,
          model: {
            summarize: (request, callSignal) =>
              ports.model.summarize(request, callSignal ? AbortSignal.any([signal, callSignal]) : signal),
          },
        })
        signal.throwIfAborted()
        return output
      },
    }
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
