import { createHash } from 'node:crypto'
import { jcs } from '@agnes/protocol'
import type { McpRemoteTool, McpSkippedTool } from './register.js'

/** One tool as the catalog reports it: real remote name, not the local `mcp_<server>_<name>` form. */
export type McpCatalogTool = Readonly<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
}>

export type McpCatalogInfo = Readonly<{
  toolCount: number
  catalogRevision: string
  /** Sorted by name; the same list `toolCount`/`catalogRevision` were computed from. */
  tools: readonly McpCatalogTool[]
  /** Remote tools left out of `tools`; the list is sorted by name and holds at most 32 of them. */
  skippedToolCount: number
  skippedTools: readonly McpSkippedTool[]
}>

/** The protocol's cap on `McpStatus.skippedTools`. */
const MAX_REPORTED_SKIPPED_TOOLS = 32

/**
 * The accepted (`allowedTools`-filtered) tool catalog, sorted by name so tool order never perturbs
 * its content hash. This is the one place a row's live status and the catalog `resourceMcpTools`
 * later serves for pagination both derive their numbers from - the same accepted list, the same
 * algorithm - so a status event's `catalogRevision` always matches what a paginated read of that
 * revision actually contains.
 */
export function catalogInfoOf(
  remote: readonly McpRemoteTool[],
  skipped: readonly McpSkippedTool[] = [],
): McpCatalogInfo {
  const tools = Object.freeze(
    [...remote]
      .map((tool) =>
        Object.freeze({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }),
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
  )
  return Object.freeze({
    toolCount: tools.length,
    catalogRevision: createHash('sha256').update(jcs(tools), 'utf8').digest('hex'),
    tools,
    skippedToolCount: skipped.length,
    skippedTools: Object.freeze(
      [...skipped]
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.code.localeCompare(b.code))
        .slice(0, MAX_REPORTED_SKIPPED_TOOLS),
    ),
  })
}
