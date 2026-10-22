import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { type RegistrySnapshot, ToolRegistry } from './tools.js'

/** A live catalog view. Tool policy still decides what each visible tool may do. */
export class ToolRegistryView extends ToolRegistry {
  private readonly allowed: () => ReadonlySet<string>
  private readonly eager: ReadonlySet<string>
  constructor(
    source: ToolRegistry,
    names: readonly string[] | (() => readonly string[]),
    eager: readonly string[] = [],
  ) {
    super()
    this.source = source
    this.eager = new Set(eager)
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
    // Eager names affect disclosure only after the authoritative visibility filter.
    const defs = Object.freeze(
      original.defs.flatMap(({ name }) => {
        // Keep the registered execution identity and binding in the lookup projection.
        const tool = original.byName.get(name)
        if (!tool || !allowed.has(name)) return []
        return [
          this.eager.has(name) && tool.meta.deferLoading === true
            ? Object.freeze({ ...tool, meta: Object.freeze({ ...tool.meta, deferLoading: false }) })
            : tool,
        ]
      }),
    )
    if (defs.length === original.defs.length && defs.every((tool, i) => tool === original.defs[i]))
      return original
    return Object.freeze({
      ...original,
      defs,
      byName: new Map(defs.map((tool) => [tool.name, tool])),
      hash: sha256Hex(canonicalJson(defs.map(({ name, parameters }) => ({ name, parameters })))),
    })
  }
}
