import type { EntryRow } from '@agnes/plugin-runtime/host'
import type { SkillRuntimeInput } from '@agnes/resource-control-runtime'
import { describe, expect, it } from 'vitest'
import { skillRowRevision, withSkillRow } from '../../src/assemble/skill-row.js'

const skill = (revision: string, workspaceId?: string) =>
  ({
    list: () => [
      {
        kind: 'skill',
        resourceId: 'skill:one',
        name: 'one',
        revision,
        sourceIdentity: { rootKey: 'workspace-agnes', scope: 'workspace' },
        priority: 500,
        resolution: 'active',
        trust: 'trusted',
        desired: 'enabled',
        actual: 'ready',
        stale: false,
        ...(workspaceId ? { workspaceId } : {}),
      },
    ],
  }) as unknown as SkillRuntimeInput

describe('Skills row target', () => {
  it('changes only with the effective Skills revision or workspace visibility', () => {
    expect(skillRowRevision(skill('one'))).toBe(skillRowRevision(skill('one')))
    expect(skillRowRevision(skill('one'))).not.toBe(skillRowRevision(skill('two')))
    expect(skillRowRevision(skill('one', 'workspace-a'))).not.toBe(
      skillRowRevision(skill('one', 'workspace-b')),
    )
    expect(skillRowRevision(undefined)).toBe(skillRowRevision(undefined))
    expect(skillRowRevision(undefined)).not.toBe(
      skillRowRevision({ list: () => [] } as unknown as SkillRuntimeInput),
    )
  })

  it('replaces only the Skills row and keeps MCP object identities', () => {
    const mcp = { id: 'ext:agnes/mcp-server', plugin: 'builtin:mcp' } as EntryRow
    const old = { id: 'ext:agnes/skills', plugin: 'builtin:skills', entryRevision: 'old' } as EntryRow
    const next = { ...old, entryRevision: 'next' }
    const target = withSkillRow([mcp, old], next)
    expect(target).toEqual([mcp, next])
    expect(target[0]).toBe(mcp)
    expect(() => withSkillRow([mcp], mcp)).toThrow(/wrong Skills row/)
  })
})
