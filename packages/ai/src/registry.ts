import type { ModelRecord, RouteDecl } from '@agnes/protocol'
import type { WireAdapter } from './adapter.js'
import { AiSetupError } from './errors.js'
import { canonicalJson, sha256Hex } from './hash.js'

export interface Registry {
  lookup(route: string): { adapter: WireAdapter; decl: RouteDecl } | undefined
  routes(): RouteDecl[]
  models(): ModelRecord[]
  /**
   * Ends assembly: the catalogues are read once, here, and every later projection answers from that
   * reading. Assembly calls it — `createProvider` does, after credentials are bound — and calling it
   * again keeps the first snapshot rather than recording a newer one under the same identity.
   */
  seal(): void
  fingerprint(): string
}

type Snapshot = { routes: RouteDecl[]; models: ModelRecord[]; fingerprint: string }

/**
 * A frozen deep copy. The seal has to publish records the adapters still own and keep mutating, so
 * it takes its own copy and freezes it: a caller that writes to what a projection handed back fails
 * loudly rather than changing what the next reader sees while the fingerprint — computed from the
 * same reading — stays where it was.
 */
function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (v: unknown): void => {
    if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return
    Object.freeze(v)
    for (const inner of Object.values(v)) freeze(inner)
  }
  freeze(copy)
  return copy
}

/**
 * Resolves route names to the adapter that serves them, once, at assembly time. Two adapters
 * claiming the same route is a configuration mistake with no safe reading — whichever one won would
 * be arbitrary — so the whole batch is rejected rather than partially accepted.
 *
 * The route table is fixed here. Model catalogues stay live until the registry is sealed, because a
 * catalogue route is empty until its adapter has refreshed it and assembly has to see that refresh.
 */
export function buildRegistry(adapters: WireAdapter[]): Registry {
  const table = new Map<string, { adapter: WireAdapter; decl: RouteDecl }>()
  for (const adapter of adapters) {
    for (const decl of adapter.routes()) {
      const existing = table.get(decl.route)
      if (existing)
        throw new AiSetupError('DUPLICATE_ROUTE', {
          route: decl.route,
          adapters: [existing.adapter.id, adapter.id],
        })
      table.set(decl.route, { adapter, decl })
    }
  }
  const sorted = () => [...table.values()].sort((x, y) => (x.decl.route < y.decl.route ? -1 : 1))
  let snapshot: Snapshot | undefined
  return {
    lookup: (route) => table.get(route),
    // Both projections hand back a fresh array, and after the seal the records inside it are frozen
    // copies, so a caller cannot change what the next reader sees through either. Before the seal
    // the records are still the adapters' own objects, which is what makes a refresh visible.
    routes: () => (snapshot ? [...snapshot.routes] : sorted().map((e) => e.decl)),
    models: () => (snapshot ? [...snapshot.models] : sorted().flatMap((e) => e.adapter.models(e.decl.route))),
    seal() {
      if (snapshot) return
      const entries = sorted().map((e) => ({ decl: e.decl, models: e.adapter.models(e.decl.route) }))
      snapshot = {
        routes: entries.map((e) => frozenCopy(e.decl)),
        models: entries.flatMap((e) => e.models.map((m) => frozenCopy(m))),
        // The hash a host records for an assembled session: what was resolved — the route names,
        // where each points, and which models each offers — and nothing about the order the
        // adapters were supplied in. It is computed from the same reading the projections above
        // answer from, so a fingerprint and a model list taken from a sealed registry always agree.
        fingerprint: sha256Hex(
          canonicalJson(
            entries.map((e) => ({
              route: e.decl.route,
              api: e.decl.api,
              baseUrl: e.decl.baseUrl,
              models: e.models.map((m) => m.id).sort(),
            })),
          ),
        ),
      }
    },
    fingerprint() {
      // Refusing before the seal is the point of sealing. Reading catalogues live would make this
      // digest depend on the moment it was read, and "read it only after the last refresh" is an
      // obligation on a caller in another package that nothing here could enforce.
      if (!snapshot) throw new AiSetupError('UNSEALED', { at: 'fingerprint' })
      return snapshot.fingerprint
    },
  }
}
