import { BASE_SEAM_PROVIDERS, defaultLoopPlugin, planModePlugin, toolPolicyPlugin } from '@agnes/base'
import type { ProviderPluginContext } from '@agnes/extension-api'
import { SEAM_KIND_TOKENS, SEAM_KINDS } from '@agnes/extension-api/seams'
import type { PackageModule, SeamInitContext } from '@agnes/host-extensions/assemble/packages'
import type {} from '@agnes/host-providers/assemble/loops'
import type {} from '@agnes/host-providers/assemble/tool-providers'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'

export type TestSeamFactory = (init: SeamInitContext) => Promise<object>
/** Factories for the seam kinds a fixture module "provides"; registered as providers at apply. */
export type TestSeamFactories = Partial<Record<(typeof SEAM_KINDS)[number], TestSeamFactory>>

const TEST_SEAMS = Symbol('test seam factories')
const tables = new WeakMap<PackageModule, TestSeamFactories>()

/** Spread into a module literal to give the fixture seam factories without a `seams` table. */
export function seamFactories(table: TestSeamFactories): { [TEST_SEAMS]: TestSeamFactories } {
  return { [TEST_SEAMS]: table }
}

/** The fixture's seam factory table; mutate it to swap an implementation before the host assembles. */
export function testSeams(module: PackageModule): TestSeamFactories {
  const carried = (module as { [TEST_SEAMS]?: TestSeamFactories })[TEST_SEAMS]
  if (carried) return carried
  const existing = tables.get(module)
  if (existing) return existing
  const table: TestSeamFactories = {}
  tables.set(module, table)
  return table
}

/** Base's own implementations as init-taking factories, for fixtures that reuse one of them. */
export const baseSeamFactories = Object.freeze(
  Object.fromEntries(
    SEAM_KINDS.map((kind) => [
      kind,
      (init: SeamInitContext) =>
        Promise.resolve(BASE_SEAM_PROVIDERS[kind].create(init, new AbortController().signal)),
    ]),
  ),
) as Readonly<Record<(typeof SEAM_KINDS)[number], TestSeamFactory>>

/**
 * A legacy fixture's `seams` factory table, registered as the providers the built-in templates
 * select. The table is read at apply time, so a test that swaps a factory after attaching sees it.
 */
function seamProvidersRow(module: PackageModule) {
  return Object.freeze({
    declaration: Object.freeze({
      export: 'seamProvidersPlugin',
      apiRange: '^5.0.0',
      id: 'seam-providers:test',
      inject: ['providers'],
      runtime: 'in-process' as const,
      default: true,
    }),
    entry: normalizePluginExport({
      inject: ['providers'],
      apply(ctx: ProviderPluginContext) {
        const table = testSeams(module) as Record<string, TestSeamFactory | undefined>
        for (const kind of SEAM_KINDS) {
          const factory = table[kind]
          if (!factory) continue
          ctx.providers.register(
            SEAM_KIND_TOKENS[kind] as never,
            {
              id: BASE_SEAM_PROVIDERS[kind].id,
              version: BASE_SEAM_PROVIDERS[kind].version,
              create: (init: unknown) => factory(init as SeamInitContext),
            } as never,
          )
        }
      },
    }),
  })
}

/** Give mutable legacy seam fixtures the same ordinary-row shape as real package exports. */
export function attachTestSeamPlugins(module: PackageModule): PackageModule {
  const ordinary = [...(module.plugins ?? [])]
  // Synthetic Base modules must declare the same loop and permission policies as shipped Base.
  if (module.id === '@agnes/base')
    for (const [id, exportName, service, plugin] of [
      ['loop:agnes.default', 'defaultLoopPlugin', 'loops', defaultLoopPlugin],
      ['tool-policy:default', 'toolPolicyPlugin', 'providers', toolPolicyPlugin],
    ] as const) {
      if (ordinary.some((row) => row.declaration.id === id)) continue
      ordinary.push({
        declaration: {
          id,
          export: exportName,
          apiRange: '^5.0.0',
          default: true,
          inject: [service],
          runtime: 'in-process',
        },
        entry: normalizePluginExport(plugin),
      })
    }
  if (module.id === '@agnes/base' && !ordinary.some((row) => row.declaration.id === 'service:plan-mode'))
    ordinary.push({
      declaration: {
        id: 'service:plan-mode',
        export: 'planModePlugin',
        apiRange: '^5.0.0',
        default: true,
        inject: ['providers', 'services'],
        provide: ['planMode'],
        runtime: 'in-process',
      },
      entry: normalizePluginExport(planModePlugin),
    })
  Object.defineProperty(module, 'plugins', {
    configurable: true,
    enumerable: true,
    get() {
      return [
        ...ordinary,
        ...(SEAM_KINDS.some((kind) => testSeams(module)[kind]) ? [seamProvidersRow(module)] : []),
      ]
    },
  })
  return module
}
