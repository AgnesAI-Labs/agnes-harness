import { describe, expect, it } from 'vitest'
import { mcpLocalToolPrefix } from '../../src/mcp/naming.js'

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
