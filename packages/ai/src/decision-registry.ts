import type { DecisionModelRecord, RouteDecl } from '@agnes/protocol'
import { DecisionAdapter } from './adapter.js'
import { AiSetupError } from './errors.js'
import { frozenCopy } from './registry.js'

export type DecisionRegistry = Readonly<{
  routes(): { route: string }[]
  models(): DecisionModelRecord[]
  lookup(route: string): { adapter: DecisionAdapter } | undefined
}>

export function isDecisionModelRecord(value: unknown): value is DecisionModelRecord {
  return value !== null && typeof value === 'object' && (value as { kind?: unknown }).kind === 'decision'
}

/**
 * The decision counterpart of buildRegistry, kept apart on purpose: nothing that lists chat models
 * reads this table, so a decision model cannot be switched onto a chat slot, probed by the doctor,
 * bound to a prompt contract or offered in a picker by accident.
 *
 * Only declared routes are served. The catalogue is read once, here, and published as frozen copies:
 * a decision catalogue is configuration and has no refresh step to wait for.
 */
export function buildDecisionRegistry(
  adapters: readonly DecisionAdapter[],
  decls: readonly RouteDecl[],
): DecisionRegistry {
  const served = new Map<string, DecisionAdapter>()
  for (const adapter of adapters) {
    if (!(adapter instanceof DecisionAdapter))
      throw new AiSetupError('ADAPTER_KIND', {
        adapter: String((adapter as { id?: unknown }).id),
        expected: 'decision',
      })
    for (const route of adapter.routes()) {
      const existing = served.get(route)
      if (existing) throw new AiSetupError('DUPLICATE_ROUTE', { route, adapters: [existing.id, adapter.id] })
      served.set(route, adapter)
    }
  }
  const table = new Map<string, { adapter: DecisionAdapter; models: DecisionModelRecord[] }>()
  for (const decl of decls) {
    if (table.has(decl.route)) throw new AiSetupError('DUPLICATE_ROUTE', { route: decl.route })
    const adapter = served.get(decl.route)
    if (!adapter) throw new AiSetupError('NO_ADAPTER', { route: decl.route })
    const models = adapter.models(decl.route).map((m) => {
      if (!isDecisionModelRecord(m) || m.route !== decl.route)
        throw new AiSetupError('ADAPTER_KIND', {
          route: decl.route,
          model: String((m as { id?: unknown }).id),
        })
      return frozenCopy(m)
    })
    table.set(decl.route, { adapter, models })
  }
  const order = [...table.keys()].sort()
  return Object.freeze({
    routes: () => order.map((route) => ({ route })),
    models: () => order.flatMap((route) => table.get(route)?.models ?? []),
    lookup: (route: string) => {
      const hit = table.get(route)
      return hit ? { adapter: hit.adapter } : undefined
    },
  })
}
