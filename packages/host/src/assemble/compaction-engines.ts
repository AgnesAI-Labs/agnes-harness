import { CompactionRunner } from '@agnes/core'
import { type Context, Service } from '@agnes/cordis'
import type {
  CompactionEngine,
  CompactionEngineCatalogEntry,
  CompactionEngineInstance,
  CompactionEngineRegistration,
} from '@agnes/extension-api'
import { normalizePluginExport, type RowOrigin, type RowOriginLookup } from '@agnes/plugin-runtime/host'
import { HostError } from '../errors.js'
import type { PackageModule } from './packages.js'

declare module '@agnes/cordis' {
  interface Context {
    compactionEngines: CompactionEngineRegistry
  }
}

export class CompactionEngineRegistry extends Service implements CompactionEngineRegistration {
  private readonly records = new Map<
    string,
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
  }

  register(engine: CompactionEngine): () => void {
    if (
      typeof engine?.id !== 'string' ||
      !engine.id.trim() ||
      typeof engine.version !== 'string' ||
      !engine.version.trim() ||
      typeof engine.create !== 'function'
    )
      throw new HostError('E_API_RANGE', 'invalid compaction engine registration')
    if (this.records.has(engine.id))
      throw new HostError('E_API_RANGE', `duplicate compaction engine: ${engine.id}`)
    let origin: Readonly<RowOrigin> | undefined
    for (let fiber = this.ctx.fiber; fiber !== fiber.parent.fiber; fiber = fiber.parent.fiber) {
      origin = this.origins?.lookup(fiber)
      if (origin) break
    }
    if (this.origins && !origin && this.ctx !== this.ctx.root)
      throw new HostError('E_EXT_LOAD', 'compaction engine requires a verified plugin row')
    const record = {
      engine,
      entry: Object.freeze({
        id: engine.id,
        version: engine.version,
        sourcePackage:
          origin?.trustTier === 'builtin' && origin.rowId === 'compaction-engine:default'
            ? '@agnes/base'
            : (origin?.packageId ?? '@agnes/base'),
      }),
      lifetime: new AbortController(),
    }
    return this.ctx.effect(() => {
      this.records.set(engine.id, record)
      return () => {
        record.lifetime.abort()
        this.records.delete(engine.id)
      }
    }, `compactionEngines.register(${engine.id})`)
  }

  catalog(): readonly CompactionEngineCatalogEntry[] {
    return Object.freeze(
      [...this.records.values()].map((record) => record.entry).sort((a, b) => a.id.localeCompare(b.id)),
    )
  }

  create(id: string): CompactionEngineInstance {
    const record = this.records.get(id)
    if (!record)
      throw new HostError('E_DEP_MISSING', `compaction engine is not registered: ${id}`, {
        detail: { reason: 'compaction-engine-missing', id },
      })
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
