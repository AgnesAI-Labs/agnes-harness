import type { ChildAgentToolFilter } from '@agnes/extension-api'
import { sessionIdentity } from '../loop/scope.js'
import { ToolRegistryView } from '../registry/tool-allow.js'
import type { ToolRegistry } from '../registry/tools.js'
import type { CurrentRuntimeLookup } from '../runtime/current.js'

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

/**
 * The registry one session sees: its child filter, less the tools it must never be offered
 * (`hidden`), as a live view. One view per source registry, so repeated lookups share it. Undefined
 * when nothing narrows the session's tools.
 */
export function sessionToolView(
  filter: ChildAgentToolFilter | undefined,
  hidden: readonly string[],
): ((tools: ToolRegistry) => ToolRegistry) | undefined {
  if (!filter && hidden.length === 0) return undefined
  const narrowed: ChildAgentToolFilter = { ...filter, deny: [...(filter?.deny ?? []), ...hidden] }
  const views = new WeakMap<ToolRegistry, ToolRegistry>()
  return (tools) => {
    const known = views.get(tools)
    if (known) return known
    const view = new ChildToolRegistry(tools, narrowed)
    views.set(tools, view)
    return view
  }
}

/** A published runtime lookup whose tools are seen through `view`. */
export function narrowedRuntime(
  lookup: CurrentRuntimeLookup,
  view: (tools: ToolRegistry) => ToolRegistry,
): CurrentRuntimeLookup {
  return {
    current: (key) => {
      const current = lookup.current(key)
      return current && { ...current, tools: view(current.tools) }
    },
  }
}

const sessionFilters = new WeakMap<object, ChildAgentToolFilter>()
export function childSessionToolFilter(session: object): ChildAgentToolFilter | undefined {
  return sessionFilters.get(sessionIdentity(session))
}
export function bindChildSessionToolFilter(session: object, filter: ChildAgentToolFilter): void {
  sessionFilters.set(sessionIdentity(session), filter)
}
