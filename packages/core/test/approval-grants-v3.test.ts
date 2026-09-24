import type { ApprovalGrant } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  approvalBindingHash,
  approvalScopesForCall,
  permanentGrantMatches,
  sessionGrantKey,
} from '../src/step/approval-grants.js'
import { actor } from './helpers/open-session.js'

const grant: ApprovalGrant = {
  grantId: 'grant-1',
  profileHash: `sha256-${'a'.repeat(64)}`,
  actorId: actor.id,
  actorOrg: actor.org,
  toolId: 'computer_use',
  scope: 'cua:click:background',
  policyVersion: 'cua-v1',
  createdAt: '2026-09-17T00:00:00.000Z',
}

describe('v3 approval grants', () => {
  it('binds session grants to owner, session, tool and scope instead of argv', () => {
    const base = { actor, sessionKey: 's1', toolId: 'computer_use', scope: grant.scope }
    expect(sessionGrantKey(base)).toBe(sessionGrantKey({ ...base }))
    expect(sessionGrantKey(base)).not.toBe(sessionGrantKey({ ...base, scope: 'cua:click:foreground' }))
    expect(sessionGrantKey(base)).not.toBe(
      sessionGrantKey({ ...base, actor: { ...actor, id: 'someone-else' } }),
    )
  })

  it('matches permanent grants on every security binding and rejects revoked grants', () => {
    const binding = {
      actor,
      profileHash: grant.profileHash,
      toolId: grant.toolId,
      scope: grant.scope,
      policyVersion: grant.policyVersion,
    }
    expect(permanentGrantMatches(grant, binding)).toBe(true)
    expect(permanentGrantMatches({ ...grant, revokedAt: grant.createdAt }, binding)).toBe(false)
    expect(permanentGrantMatches(grant, { ...binding, actor: { ...actor, id: 'other' } })).toBe(false)
    expect(permanentGrantMatches(grant, { ...binding, actor: { ...actor, org: 'other' } })).toBe(false)
    expect(permanentGrantMatches(grant, { ...binding, profileHash: `sha256-${'b'.repeat(64)}` })).toBe(false)
    expect(permanentGrantMatches(grant, { ...binding, toolId: 'other' })).toBe(false)
    expect(permanentGrantMatches(grant, { ...binding, scope: 'cua:click:foreground' })).toBe(false)
    expect(permanentGrantMatches(grant, { ...binding, policyVersion: 'cua-v2' })).toBe(false)
  })

  it('preserves ordered action/front scopes and supplies a stable fallback for legacy tools', () => {
    expect(
      approvalScopesForCall('computer_use', [
        'cua:click:foreground',
        'cua:bring_to_front:foreground',
        'cua:click:foreground',
      ]),
    ).toEqual(['cua:click:foreground', 'cua:bring_to_front:foreground'])
    expect(approvalScopesForCall('shell', [])).toEqual(['tool:shell:execute'])
  })

  it('binds a one-call approval to the exact tool use id', () => {
    const input = {
      sessionKey: 's1',
      stepId: '1/1',
      toolUseId: 'call-1',
      args: { x: 1 },
      policyHash: `sha256-${'b'.repeat(64)}`,
      scope: grant.scope,
    }
    expect(approvalBindingHash(input)).toBe(approvalBindingHash({ ...input }))
    expect(approvalBindingHash(input)).not.toBe(approvalBindingHash({ ...input, toolUseId: 'call-2' }))
  })
})
