import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { type RegistrySnapshot, ToolRegistry } from './tools.js'

/** A live catalog view. Tool policy still decides what each visible tool may do. */
export class ToolRegistryView extends ToolRegistry {
  private readonly allowed: () => ReadonlySet<string>
  private readonly explicit: boolean
  constructor(source: ToolRegistry, names: readonly string[] | (() => readonly string[])) {
    super()
    this.source = source
    this.explicit = typeof names !== 'function'
    this.add = source.add.bind(source)
    this.registrations = source.registrations.bind(source)
    this.prepareOwnerReplacement = source.prepareOwnerReplacement.bind(source)
    const fixed = typeof names === 'function' ? undefined : new Set(names)
    this.allowed = () => fixed ?? new Set(typeof names === 'function' ? names() : names)
  }
  private readonly source: ToolRegistry
  override readonly add: ToolRegistry['add']
  override readonly registrations: ToolRegistry['registrations']
  override readonly prepareOwnerReplacement: ToolRegistry['prepareOwnerReplacement']
  override resolve(name: string) {
    return this.allowed().has(name) ? this.source.resolve(name) : undefined
  }
  override get size(): number {
    return this.list().length
  }
  override list(filter: Parameters<ToolRegistry['list']>[0] = {}) {
    const allowed = this.allowed()
    return this.source.list(filter).filter((tool) => allowed.has(tool.name))
  }
  override snapshot(seq: number): RegistrySnapshot {
    const original = this.source.snapshot(seq)
    const allowed = this.allowed()
    if (this.explicit) {
      // An explicit working set offers deferred tools; a live visibility filter does not.
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
        hash: sha256Hex(canonicalJson(defs.map(({ name, parameters }) => ({ name, parameters })))),
      })
    }
    const defs = Object.freeze(original.defs.filter((tool) => allowed.has(tool.name)))
    if (defs.length === original.defs.length) return original
    return Object.freeze({
      ...original,
      defs,
      byName: new Map([...original.byName].filter(([name]) => allowed.has(name))),
      hash: sha256Hex(canonicalJson(defs.map(({ name, parameters }) => ({ name, parameters })))),
    })
  }
}
