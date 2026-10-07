import { describe, expect, it } from 'vitest'
import { mcpLegacyToolName, mcpLocalToolPrefix, mcpPublicToolName, mcpStablePrefix } from '../../src/mcp/naming.js'

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

describe('mcpLocalToolPrefix', () => {
  it('gives two server ids that sanitize to the same string distinct prefixes', () => {
    // The reported bug: "a.b" and "a_b" both collapse to "a_b" under a plain
    // /[^A-Za-z0-9_]/g -> '_' sanitizer, so `mcp_a_b_read` collided for both servers.
    expect(mcpLocalToolPrefix('a.b')).not.toBe(mcpLocalToolPrefix('a_b'))
  })

  it('is a pure function of the server id: same id always yields the same prefix', () => {
    expect(mcpLocalToolPrefix('gh')).toBe(mcpLocalToolPrefix('gh'))
  })

  it('caps the slug at 40 characters regardless of server id length', () => {
    const longId = `server-${'x'.repeat(80)}`
    const prefix = mcpLocalToolPrefix(longId)
    // mcp_ (4) + slug (<=40) + _ (1) + hash8 (8) + _ (1) = <=54.
    expect(prefix.length).toBeLessThanOrEqual(54)
    expect(prefix.startsWith('mcp_')).toBe(true)
    expect(prefix.endsWith('_')).toBe(true)
  })

  it('falls back to "server" when the id has no slug-eligible characters', () => {
    expect(mcpLocalToolPrefix('...')).toMatch(/^mcp_server_[0-9a-f]{8}_$/)
  })

  it('lowercases and collapses runs of non-alphanumeric characters in the slug', () => {
    expect(mcpLocalToolPrefix('My.Server--2')).toMatch(/^mcp_my_server_2_[0-9a-f]{8}_$/)
  })
})

describe('mcpPublicToolName', () => {
  it('uses mcp__server__tool when neither ident is rewritten and the name fits', () => {
    expect(mcpStablePrefix('gh')).toBe('mcp__gh__')
    expect(mcpPublicToolName('gh', 'list_prs')).toBe('mcp__gh__list_prs')
    expect(mcpPublicToolName('gh', 'list_prs')).toMatch(TOOL_NAME)
  })

  it('hashes a rewritten tool or server ident and keeps the clean twin stable', () => {
    const rewritten = mcpPublicToolName('gh', 'a-b')
    const clean = mcpPublicToolName('gh', 'a_b')
    expect(clean).toBe('mcp__gh__a_b')
    expect(rewritten).not.toBe(clean)
    expect(rewritten).toMatch(TOOL_NAME)
    expect(mcpPublicToolName('a.b', 'read')).not.toBe(mcpPublicToolName('a_b', 'read'))
    expect(mcpStablePrefix('a.b')).not.toBe('mcp__a_b__')
    expect(mcpStablePrefix('a_b')).toBe('mcp__a_b__')
  })

  it('adds a hash only when the clean name is already taken, and stops at that hash when the alternate is taken too', () => {
    const stable = mcpPublicToolName('gh', 'list_prs')
    const hashed = mcpPublicToolName('gh', 'list_prs', new Set([stable]))
    const alt = mcpPublicToolName('gh', 'list_prs', new Set([stable, hashed]))
    expect(hashed).not.toBe(stable)
    expect(alt).not.toBe(stable)
    expect(alt).not.toBe(hashed)
    expect(hashed).toMatch(TOOL_NAME)
    expect(mcpPublicToolName('gh', 'list_prs', new Set([stable, hashed, alt]))).toBe(hashed)
  })

  it('keeps the legacy alias on the old hashed prefix', () => {
    expect(mcpLegacyToolName('gh', 'list_prs')).toBe(`${mcpLocalToolPrefix('gh')}list_prs`)
    expect(mcpLegacyToolName('gh', 'list_prs')).not.toBe(mcpPublicToolName('gh', 'list_prs'))
  })

  it('stays inside the 64-character tool name contract for a long server id', () => {
    const name = mcpPublicToolName(`server-${'x'.repeat(80)}`, 'list_prs')
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name).toMatch(TOOL_NAME)
  })
})
