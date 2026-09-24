import { createHash } from 'node:crypto'

const SLUG_MAX = 40

/**
 * The local tool-name prefix for one MCP server: `mcp_<slug>_<hash8>_`. `slug` is cosmetic (a human
 * can recognize which server a tool came from); `hash8` is what actually disambiguates -- two server
 * ids that collide only after slugging (e.g. "a.b" and "a_b" both slug to "a_b") still get distinct
 * prefixes, because slugging alone is lossy (case, most punctuation, and -- unlike this function --
 * had no length cap of its own before this fix).
 *
 * This mirrors `mcp-server-rows.ts`'s `slugOf`/`hash8` pair (used there for the Host-owned `ext:`
 * row's extension id, `agnes/mcp-<slug>-<hash8>`), which already solved the identical collision for
 * row ids -- see that file's own doc comment. This function gives the *tool name* the same
 * protection: `register.ts`'s `localName()` and the row's own declared manifest
 * `capabilities.tools.prefix` both call this one function, so they can never drift apart the way
 * the two independently-hand-rolled sanitizing regexes used to (design
 * 2026-09-23-mcp-tool-name-collision-design.md §0.4).
 */
export function mcpLocalToolPrefix(serverId: string): string {
  const slug =
    serverId
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, SLUG_MAX) || 'server'
  const hash = createHash('sha256').update(serverId, 'utf8').digest('hex').slice(0, 8)
  return `mcp_${slug}_${hash}_`
}
