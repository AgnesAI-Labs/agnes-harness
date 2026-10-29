import { createApiKeyProviderConfigs, modelAdaptersPlugin } from '@agnes/ai'
import type { Context } from '@agnes/cordis'
import { CompactionRunner, inProcessChildAgentProvider } from '@agnes/core'
import type {
  CompactionEngine,
  CompactionPlan,
  HookPayloadMap,
  ModelAdapter,
  ModelAdapterCatalogEntry,
  ProviderPluginContext,
} from '@agnes/extension-api'
import {
  childAgentKind,
  compactionKind,
  defaultToolPolicy,
  modelAdapterKind,
  toolPolicyKind,
} from '@agnes/extension-api'
import { scriptedAdapter } from '@agnes/model-adapters'
import { type AgnesPluginManifestEntry, isReleasePackage, RELEASE_DEFAULTS } from '@agnes/package-manager'
import { normalizePluginExport, type VerifiedRowEntry } from '@agnes/plugin-runtime/host'
import type { ModelRecord, RouteDecl } from '@agnes/protocol'

type ReleaseCompactionContext = {
  providers: {
    registerHost(kind: typeof compactionKind, source: string, provider: CompactionEngine): unknown
  }
}

type Planner = (
  payload: HookPayloadMap['before_compact'],
  config: Readonly<{ keepRecentTokens: number }>,
) => CompactionPlan | null | Promise<CompactionPlan | null>
type ReleaseModule = {
  id: string
  plugins?: readonly Readonly<{ declaration: Readonly<AgnesPluginManifestEntry>; entry: VerifiedRowEntry }>[]
  buildCompactionPlan?: Planner
  createDefaultCompactionEngine?: (plan: Planner) => CompactionEngine
}

export const builtinModelAdaptersPlugin = {
  inject: ['providers'],
  apply(ctx: ProviderPluginContext) {
    modelAdaptersPlugin.apply(ctx)
    ctx.providers.register(modelAdapterKind, scriptedAdapter)
  },
}

/** Release assembly for source, executable and in-memory loaders. Package declarations win. */
export function assembleDistributionPackages<T extends ReleaseModule>(
  modules: ReadonlyMap<string, T>,
): ReadonlyMap<string, T> {
  const declarations = [
    {
      packageId: '@agnes/ai',
      id: 'model-adapters:pi',
      export: 'modelAdaptersPlugin',
      replace: true,
      factory: () =>
        modules.has('@agnes/model-adapters') ? modelAdaptersPlugin : builtinModelAdaptersPlugin,
    },
    {
      packageId: '@agnes/base',
      id: 'compaction-engine:default',
      export: 'compactionEnginePlugin',
      factory: (module: T) => {
        const plan = module.buildCompactionPlan
        if (!plan) return undefined
        const engine: CompactionEngine = module.createDefaultCompactionEngine?.(plan) ?? {
          id: 'default',
          version: '1.0.0',
          create: () =>
            new CompactionRunner({
              plan: async (payload, config) => plan(payload, config),
              onCompact: async () => undefined,
            }),
        }
        return {
          inject: ['providers'],
          apply(ctx: ReleaseCompactionContext) {
            ctx.providers.registerHost(compactionKind, '@agnes/host-providers', engine)
          },
        }
      },
    },
    {
      packageId: '@agnes/base',
      id: 'tool-policy:default',
      export: 'toolPolicyPlugin',
      apiRange: '^5.0.0',
      factory: () => ({
        inject: ['providers'],
        apply(ctx: ProviderPluginContext) {
          ctx.providers.register(toolPolicyKind, defaultToolPolicy)
        },
      }),
    },
    {
      packageId: '@agnes/base',
      id: 'child-agent:in-process',
      export: 'childAgentPlugin',
      factory: () => {
        const provider = inProcessChildAgentProvider()
        return {
          inject: ['providers'],
          apply(ctx: ProviderPluginContext) {
            ctx.providers.register(childAgentKind, provider)
          },
        }
      },
    },
  ]
  const result = new Map(modules)
  for (const declaration of declarations) {
    const module = result.get(declaration.packageId)
    if (
      !module ||
      (!declaration.replace && module.plugins?.some((row) => row.declaration.id === declaration.id))
    )
      continue
    const factory = declaration.factory(module)
    if (!factory) continue
    const { packageId: _packageId, factory: _factory, replace: _replace, ...row } = declaration
    result.set(declaration.packageId, {
      ...module,
      plugins: [
        ...(module.plugins ?? []).filter(
          (plugin) => !declaration.replace || plugin.declaration.id !== declaration.id,
        ),
        {
          declaration: {
            ...row,
            default: true,
            inject: ['providers'],
            provide: [],
            runtime: 'in-process' as const,
          },
          entry: normalizePluginExport({
            inject: ['providers'],
            apply(ctx: Context) {
              // Read through Cordis so registration keeps the calling row's provenance.
              const providers: ProviderPluginContext['providers'] & ReleaseCompactionContext['providers'] =
                Reflect.get(ctx, 'providers')
              factory.apply({ providers })
            },
          }),
        },
      ],
    })
  }
  return result
}

type ModelProfile = {
  packages: readonly {
    id: string
    enabled: boolean
    trust: string
    source: string
    version: string
    integrity: string
  }[]
  provider: { routes?: RouteDecl[]; catalog?: { include: readonly string[] } }
  composition?: { providers?: { 'model-adapter'?: { provider: string | string[] } } }
}

/** Release metadata only: no community imports, session assembly or credentials. */
export function builtinModelAdapterCatalog(
  profile?: Pick<ModelProfile, 'packages'>,
): readonly ModelAdapterCatalogEntry[] {
  if (
    profile &&
    !profile.packages.some((pkg) => pkg.id === RELEASE_DEFAULTS.modelAdapterPackage && isReleasePackage(pkg))
  )
    return []
  const found: ModelAdapterCatalogEntry[] = []
  const plugin = profile?.packages.some(
    (pkg) => pkg.id === RELEASE_DEFAULTS.modelAdapterCompanion && pkg.enabled,
  )
    ? modelAdaptersPlugin
    : builtinModelAdaptersPlugin
  plugin.apply({
    providers: {
      register: (_kind: unknown, adapter: ModelAdapter) =>
        void found.push({
          id: adapter.id,
          version: adapter.version,
          sourcePackage: RELEASE_DEFAULTS.modelAdapterPackage,
          wireApi: adapter.wireApi,
          capabilities: adapter.capabilities,
        }),
    },
  } as never)
  return [...new Map(found.map((entry) => [entry.id, entry])).values()]
}

export async function builtinModelSelectionData(profile: ModelProfile): Promise<{
  adapters: readonly ModelAdapterCatalogEntry[]
  routes: readonly Pick<RouteDecl, 'route' | 'api'>[]
  models: readonly Pick<ModelRecord, 'id' | 'route' | 'api'>[]
}> {
  const adapters = builtinModelAdapterCatalog(profile)
  const declared = profile.provider.routes ?? []
  if (!declared.length) return { adapters, routes: [], models: [] }
  const choice = profile.composition?.providers?.['model-adapter']?.provider
  const selected = typeof choice === 'string' ? [choice] : choice
  const claimed = new Set(declared.map((r) => r.route))
  const configs = (await createApiKeyProviderConfigs()).filter((config) =>
    config.routes.every(
      (r) =>
        (!selected?.length || selected.includes(r.api)) &&
        !claimed.has(r.route) &&
        (profile.provider.catalog === undefined || profile.provider.catalog.include.includes(r.route)),
    ),
  )
  const routes = [...declared, ...configs.flatMap((c) => c.routes)]
  return { adapters, routes, models: routes.flatMap((r) => r.models ?? []) }
}
