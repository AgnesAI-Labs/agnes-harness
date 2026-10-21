import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import type { RegistrySnapshot, ToolRegistry } from './tools.js'

/**
 * A view of a tool registry that lists, resolves and snapshots only the named tools. A turn takes its
 * snapshot from this view, so a tool outside the list is neither offered to the model nor found when
 * the model calls it. This is visibility, not authorization: the tool policy still decides what a
 * visible tool may do.
 */
export function onlyTools(tools: ToolRegistry, names: readonly string[]): ToolRegistry {
  const allowed = new Set(names)
  return new Proxy(tools, {
    get(target, property) {
      if (property === 'list')
        return (filter?: Parameters<ToolRegistry['list']>[0]) =>
          target.list(filter).filter((tool) => allowed.has(tool.name))
      if (property === 'resolve')
        return (name: string) => (allowed.has(name) ? target.resolve(name) : undefined)
      if (property === 'size') return target.list().filter((tool) => allowed.has(tool.name)).length
      if (property === 'snapshot')
        return (seq: Parameters<ToolRegistry['snapshot']>[0]): RegistrySnapshot => {
          const original = target.snapshot(seq)
          // A session's explicit names are its requested working set, not discovery hints.
          // Offer that set even when the global catalog deferred the same tools. Visibility,
          // model capability, custom Loop selection and execution policy still apply later.
          const defs = Object.freeze(
            [...original.byName.values()]
              .filter((tool) => allowed.has(tool.name))
              .map((tool) =>
                tool.meta.deferLoading === true
                  ? Object.freeze({ ...tool, meta: Object.freeze({ ...tool.meta, deferLoading: false }) })
                  : tool,
              ),
          )
          return Object.freeze({
            ...original,
            defs,
            byName: new Map(defs.map((tool) => [tool.name, tool])),
            hash: sha256Hex(
              canonicalJson(defs.map((tool) => ({ name: tool.name, parameters: tool.parameters }))),
            ),
          })
        }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
