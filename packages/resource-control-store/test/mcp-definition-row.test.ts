import type { McpServerDefinitionInput, McpStatus } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import type { McpRow } from '../src/mcp.js'
import { definedRow } from '../src/mcp-definition-row.js'

const none: McpServerDefinitionInput = {
  serverId: 'docs',
  displayName: 'Docs',
  transport: { kind: 'http', url: 'https://docs.example.com/mcp' },
  secretBinding: { kind: 'none' },
}
const status = (connectionState: McpStatus['connectionState']): McpStatus => ({
  serverId: 'docs',
  connectionState,
  observedRevision: 'a'.repeat(64),
  catalogRevision: null,
  toolCount: 0,
  observedAt: '2026-01-01T00:00:00.000Z',
})
const prior: McpRow = {
  definition: none,
  revision: 'a'.repeat(64),
  trust: 'trusted',
  desired: 'enabled',
  status: status('ready'),
  localStartApproval: 'a'.repeat(64),
}

describe('an update of an MCP definition', () => {
  it('keeps trust and enablement when the only change is from no credential to OAuth sign-in', () => {
    const oauth = { ...none, secretBinding: { kind: 'oauth' as const } }
    expect(definedRow(prior, oauth, 'b'.repeat(64), status('unavailable'))).toMatchObject({
      definition: oauth,
      revision: 'b'.repeat(64),
      trust: 'trusted',
      desired: 'enabled',
      localStartApproval: 'b'.repeat(64),
    })
  })

  it('needs review again when anything else changes with it', () => {
    for (const next of [
      { ...none, displayName: 'Renamed', secretBinding: { kind: 'oauth' as const } },
      { ...none, secretBinding: { kind: 'oauth' as const, staticClientId: 'client' } },
    ])
      expect(definedRow(prior, next, 'b'.repeat(64), status('unavailable'))).toMatchObject({
        trust: 'untrusted',
        desired: 'disabled',
      })
  })
})
