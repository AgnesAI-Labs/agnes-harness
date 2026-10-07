import type { ChildAgentToolFilter } from '@agnes/extension-api'
import { type RegistrySnapshot, ToolRegistry } from '../registry/tools.js'
import { canonicalJson, sha256Hex } from '../request/hash.js'

export function narrowChildToolFilter(
  parent?: ChildAgentToolFilter,
  child?: ChildAgentToolFilter,
): ChildAgentToolFilter | undefined {
  if (!parent && !child) return undefined
  const allow =
    parent?.allow === undefined
      ? child?.allow
      : child?.allow === undefined
        ? parent.allow
        : parent.allow.filter((name) => child.allow?.includes(name))
  const deny = [...new Set([...(parent?.deny ?? []), ...(child?.deny ?? [])])]
  return Object.freeze({
    ...(allow === undefined ? {} : { allow: Object.freeze([...allow]) }),
    deny: Object.freeze(deny),
  })
}

/** A live view: filters also cover late registrations and direct tool execution. */
export class ChildToolRegistry extends ToolRegistry {
  constructor(
    private readonly source: ToolRegistry,
    private readonly filter: ChildAgentToolFilter,
  ) {
    super()
  }
  private allows(name: string): boolean {
    return (
      (this.filter.allow === undefined || this.filter.allow.includes(name)) &&
      !this.filter.deny?.includes(name)
    )
  }
  override get size(): number {
    return this.list().length
  }
  override resolve(name: string) {
    return this.allows(name) ? this.source.resolve(name) : undefined
  }
  override list(filter: Parameters<ToolRegistry['list']>[0] = {}) {
    return this.source.list(filter).filter((tool) => this.allows(tool.name))
  }
  override snapshot(seq: number): RegistrySnapshot {
    const source = this.source.snapshot(seq)
    const defs = Object.freeze(source.defs.filter((tool) => this.allows(tool.name)))
    const byName = new Map([...source.byName].filter(([name]) => this.allows(name)))
    const hash = sha256Hex(
      canonicalJson(defs.map((tool) => ({ name: tool.name, parameters: tool.parameters }))),
    )
    return Object.freeze({ defs, byName, hash, takenAtSeq: seq })
  }
}

const sessionFilters = new WeakMap<object, ChildAgentToolFilter>()
export function childSessionToolFilter(session: object): ChildAgentToolFilter | undefined {
  return sessionFilters.get(session)
}
export function bindChildSessionToolFilter(session: object, filter: ChildAgentToolFilter): void {
  sessionFilters.set(session, filter)
}
