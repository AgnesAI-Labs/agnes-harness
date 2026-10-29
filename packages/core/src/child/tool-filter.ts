import type { ChildAgentToolFilter } from '@agnes/extension-api'
import { sessionIdentity } from '../loop/scope.js'
import { ToolRegistryView } from '../registry/tool-allow.js'
import type { ToolRegistry } from '../registry/tools.js'

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
export class ChildToolRegistry extends ToolRegistryView {
  constructor(source: ToolRegistry, filter: ChildAgentToolFilter) {
    super(source, () =>
      source
        .list()
        .filter(
          (tool) =>
            (filter.allow === undefined || filter.allow.includes(tool.name)) &&
            !filter.deny?.includes(tool.name),
        )
        .map((tool) => tool.name),
    )
  }
}

const sessionFilters = new WeakMap<object, ChildAgentToolFilter>()
export function childSessionToolFilter(session: object): ChildAgentToolFilter | undefined {
  return sessionFilters.get(sessionIdentity(session))
}
export function bindChildSessionToolFilter(session: object, filter: ChildAgentToolFilter): void {
  sessionFilters.set(sessionIdentity(session), filter)
}
