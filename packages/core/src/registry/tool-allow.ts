import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { type RegistrySnapshot, ToolRegistry } from './tools.js'

/** A live catalog view. Tool policy still decides what each visible tool may do. */
export class ToolRegistryView extends ToolRegistry {
  private readonly allowed: () => ReadonlySet<string>
  constructor(source: ToolRegistry, names: readonly string[] | (() => readonly string[])) {
    super()
    this.source = source
    const fixed = typeof names === 'function' ? undefined : new Set(names)
    this.allowed = () => fixed ?? new Set(typeof names === 'function' ? names() : names)
  }
  private readonly source: ToolRegistry
  override add(...args: Parameters<ToolRegistry['add']>) {
    return this.source.add(...args)
  }
  override registrations(owner: string) {
    return this.source.registrations(owner)
  }
  override prepareOwnerReplacement(...args: Parameters<ToolRegistry['prepareOwnerReplacement']>) {
    return this.source.prepareOwnerReplacement(...args)
  }
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
