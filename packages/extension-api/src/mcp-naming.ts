import { sha256Hex } from '@agnes/protocol'

const SLUG_MAX = 40
const NAME_MAX = 64
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/**
 * Compatibility grant for the alias period. Stable names (`mcp__server__tool`) and the previous
 * hashed names (`mcp_<slug>_<hash8>_tool`) both start with this prefix, so one row can admit both.
 * It is wider than a single server's hashed prefix: the registrar still emits only that server's
 * stable name and its own legacy alias.
 */
export const MCP_COMPAT_PREFIX = 'mcp_'

/**
 * The local tool-name prefix for one MCP server: `mcp_<slug>_<hash8>_`. `slug` is cosmetic (a human
 * can recognize which server a tool came from); `hash8` is what actually disambiguates -- two server
 * ids that collide only after slugging (e.g. "a.b" and "a_b" both slug to "a_b") still get distinct
 * prefixes, because slugging alone is lossy (case, most punctuation, and -- unlike this function --
 * had no length cap of its own before this fix).
 *
 * This mirrors `mcp-server-rows.ts`'s `slugOf`/`hash8` pair (used there for the Host-owned `ext:`
 * row's extension id, `agnes/mcp-<slug>-<hash8>`), which already solved the identical collision for
 * row ids -- see that file's own doc comment. Kept byte-for-byte as the compatibility alias. New
 * model-facing names come from `mcpPublicToolName`.
 */
export function mcpLocalToolPrefix(serverId: string): string {
  const slug =
    serverId
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, SLUG_MAX) || 'server'
  const hash = sha256Hex(serverId).slice(0, 8)
  return `mcp_${slug}_${hash}_`
}

function hash8(material: string): string {
  return sha256Hex(material).slice(0, 8)
}

function ident(raw: string): { text: string; rewritten: boolean } {
  const text = raw.replace(/[^A-Za-z0-9_]/g, '_')
  if (!text) return { text: 'x', rewritten: true }
  return { text, rewritten: text !== raw }
}

/** Prefix of the stable model-facing name. A rewritten or over-long server id carries a hash. */
export function mcpStablePrefix(serverId: string): string {
  const server = ident(serverId)
  const clean = `mcp__${server.text}__`
  if (!server.rewritten && clean.length <= 48 && TOOL_NAME.test(`${clean}t`)) return clean
  const marker = `_${hash8(serverId)}__`
  const room = 48 - 'mcp__'.length - marker.length
  return `mcp__${server.text.slice(0, Math.max(1, room))}${marker}`
}

/**
 * Model-facing MCP tool name: `mcp__<server>__<tool>` when that spelling fits the 64-character
 * contract and is not already taken. A hash is added only when sanitizing changed the id, the
 * clean spelling does not fit, or `taken` already holds it.
 */
export function mcpPublicToolName(serverId: string, remoteName: string, taken?: ReadonlySet<string>): string {
  const prefix = mcpStablePrefix(serverId)
  const tool = ident(remoteName)
  const stable = `${prefix}${tool.text}`
  if (!tool.rewritten && stable.length <= NAME_MAX && TOOL_NAME.test(stable) && !taken?.has(stable))
    return stable
  const suffix = `_${hash8(`${serverId}\0${remoteName}`)}`
  const room = NAME_MAX - prefix.length - suffix.length
  let name = `${prefix}${room > 0 ? tool.text.slice(0, room) : ''}${suffix}`
  if (name.length > NAME_MAX || !TOOL_NAME.test(name))
    name = `mcp_${hash8(serverId)}_${suffix.slice(1)}`.slice(0, NAME_MAX)
  if (taken?.has(name)) {
    const alt = `${name.slice(0, NAME_MAX - 9)}_${hash8(`${name}\0${remoteName}`)}`
    if (TOOL_NAME.test(alt) && !taken.has(alt)) return alt
  }
  return name
}

/** Previous model-facing name, kept registered during the compatibility period. */
export function mcpLegacyToolName(serverId: string, remoteName: string): string {
  const remote = remoteName.replace(/[^A-Za-z0-9_]/g, '_')
  const prefix = mcpLocalToolPrefix(serverId)
  if (!remote || prefix.length >= NAME_MAX) throw new Error(`invalid remote tool name: ${remoteName}`)
  return `${prefix}${remote.slice(0, NAME_MAX - prefix.length)}`
}
