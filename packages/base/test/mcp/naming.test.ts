import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { mcpPublicToolName, mcpStablePrefix } from '../../src/mcp/naming.js'

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

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

  it.each(['gh', 'café — 中文', '😀', '\ud800', '\udc00', 'x'.repeat(55), 'x'.repeat(64)])(
    'preserves SHA-256 collision identities for %j',
    (id) => {
      const rewritten = mcpPublicToolName('gh', `${id}-tool`)
      const digest = createHash('sha256').update(`gh\0${id}-tool`, 'utf8').digest('hex').slice(0, 8)
      expect(rewritten.endsWith(`_${digest}`)).toBe(true)
      expect(rewritten).toMatch(TOOL_NAME)
      expect(mcpStablePrefix(id)).toBe(mcpStablePrefix(id))
      expect(mcpStablePrefix(id).length).toBeLessThanOrEqual(48)
    },
  )

  it('stays inside the 64-character tool name contract for a long server id', () => {
    const name = mcpPublicToolName(`server-${'x'.repeat(80)}`, 'list_prs')
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name).toMatch(TOOL_NAME)
  })
})
