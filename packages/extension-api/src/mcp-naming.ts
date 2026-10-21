import { sha256Hex } from '@agnes/protocol'

const NAME_MAX = 64
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

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

/** Stable backend extension identity, independent of a server's current definition revision. */
export function mcpServerExtensionId(serverId: string): string {
  const slug = serverId
    .toLocaleLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `agnes/mcp-${slug || 'server'}-${hash8(serverId)}`
}

/** Recognizes the row wire format produced by mcpServerExtensionId. */
export function isMcpServerRowId(id: string): boolean {
  return /^ext:agnes\/mcp-[a-z0-9-]+-[a-f0-9]{8}$/.test(id)
}
