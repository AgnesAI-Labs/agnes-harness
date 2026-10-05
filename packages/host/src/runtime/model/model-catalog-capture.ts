import type { ManualRoute, Registry } from '@agnes/ai'
import type { ModelRecord } from '@agnes/protocol'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'

export type CatalogRegistry = Pick<Registry, 'routes' | 'models' | 'seal'>

export type SelectedModelCatalog = Readonly<{
  /** Digest of every captured route with its whole models; `Registry.fingerprint()` covers neither cost nor model fields. */
  digest: string
  routes(): readonly string[]
  select(route: string, model: string): Readonly<{ route: ManualRoute; model: ModelRecord }> | undefined
}>

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const inner of Object.values(value)) deepFreeze(inner)
  return value
}

function build(captured: readonly ManualRoute[]): SelectedModelCatalog {
  const digest = canonicalJsonDigest(captured as unknown as Parameters<typeof canonicalJsonDigest>[0])
  return Object.freeze({
    digest,
    routes: () => captured.map((route) => route.route),
    select(route: string, model: string) {
      const picked = captured.find((candidate) => candidate.route === route)
      const record = picked?.models.find((candidate) => candidate.id === model)
      return picked && record ? { route: picked, model: record } : undefined
    },
  })
}

/**
 * Reads the routes and models once, after the registry is sealed, into a frozen copy. Later changes to the
 * live catalog reach only the next capture, never a request already prepared from this one.
 */
export function captureModelCatalog(
  registry: CatalogRegistry,
  options: { keyless?: ReadonlySet<string> } = {},
): SelectedModelCatalog {
  registry.seal()
  const routes = structuredClone(registry.routes())
  const models = structuredClone(registry.models())
  return build(
    routes.map((decl) =>
      deepFreeze({
        ...decl,
        models: models.filter((model) => model.route === decl.route),
        ...(options.keyless?.has(decl.route) ? { keyless: true } : {}),
      } as ManualRoute),
    ),
  )
}
