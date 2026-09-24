import { type Disposer, defineExtension, type ExtensionFactory } from '@agnes/extension-api'
import type { McpCatalogHub } from '../../mcp-server/src/catalog-hub.js'
import type { SkillRuntimeDiscovery } from '../../skills/src/runtime.js'
import { toolDescribeTool, toolSearchTool } from './search-tools.js'

export type McpSearchExtensionDeps = Readonly<{
  /** The same Host-private hub every MCP server row writes its catalog into (stage 2b, D110'). */
  catalogHub: McpCatalogHub
  skillDiscovery?: SkillRuntimeDiscovery
}>

/**
 * `tool_search`/`tool_describe`, reading the cross-server deferred-tool index through `McpCatalogHub`
 * (stage 2b, D110'/D123). It took over from `agnes/mcp-client` in step 4 and is loaded from
 * `package.json`'s `agnes.extensions` the way mcp-client was.
 *
 * `skillDiscovery` lists ready Skills for a Skill query. Host hands it a live view of the Skills
 * generation `agnes/skills` currently serves (design §3.9, D123), so a resource reload never has to
 * reload this extension: Skills registered through the Cordis root service land in the same registry
 * and are listed on the next call.
 */
export function mcpSearchExtension(deps: McpSearchExtensionDeps): ExtensionFactory {
  return defineExtension((agnes) => {
    const disposers: Disposer[] = [
      agnes.registerTool(toolSearchTool(deps.catalogHub, deps.skillDiscovery)),
      agnes.registerTool(toolDescribeTool(deps.catalogHub)),
    ]
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      for (const dispose of disposers.reverse()) dispose()
    }
  })
}
