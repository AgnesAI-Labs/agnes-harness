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
          const defs = original.defs.filter((tool) => allowed.has(tool.name))
          if (defs.length === original.defs.length) return original
          return Object.freeze({
            ...original,
            defs,
            byName: new Map([...original.byName].filter(([name]) => allowed.has(name))),
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
