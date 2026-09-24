import { describe, expect, it } from 'vitest'
import { ApprovalGrant } from '../gen/ts/session-v1.js'
import { fromAcpOptionKind, OFFERED_OPTION_KINDS } from '../src/codec/permission.js'
import { validateProfileFragment } from '../src/configs.js'
import { validateAgainst, validateEvent } from '../src/validate.js'

const event = (type: string, data: unknown) => ({
  v: 1,
  id: '01K5C4A0000000000000000000',
  seq: 1,
  ts: '2026-09-17T00:00:00.000Z',
  type,
  lane: 'main',
  origin: 'system',
  trust: 'trusted',
  actor: { id: 'u', org: 'o', role: 'owner', deptPath: [], attrs: {} },
  data,
})

describe('v3 approval protocol', () => {
  it('accepts allowed-permanent with explicit scope and grant id', () => {
    expect(
      validateEvent(
        event('approval/decided', {
          requestId: 'r1',
          verdict: 'allowed-permanent',
          via: 'sync',
          scope: 'cua:click:background',
          grantId: 'grant-r1',
        }),
      ).ok,
    ).toBe(true)
  })

  it('validates a durable grant with actor org and policy version bindings', () => {
    expect(
      validateAgainst(ApprovalGrant, {
        grantId: 'g1',
        profileHash: `sha256-${'a'.repeat(64)}`,
        actorId: 'u',
        actorOrg: 'o',
        toolId: 'computer_use',
        scope: 'cua:click:background',
        policyVersion: 'cua-v1',
        createdAt: '2026-09-17T00:00:00.000Z',
      }).ok,
    ).toBe(true)
  })

  it('keeps ACP allow_always session-scoped instead of promoting it to permanent', () => {
    expect(OFFERED_OPTION_KINDS).toEqual(['allow_once', 'allow_always', 'reject_once'])
    expect(fromAcpOptionKind('allow_always')).toBe('allowed-session')
  })

  it('allows fragments to select manual/smart but never to escalate themselves to off', () => {
    expect(validateProfileFragment({ approvals: { mode: 'manual' } }).ok).toBe(true)
    expect(validateProfileFragment({ approvals: { mode: 'smart' } }).ok).toBe(true)
    expect(validateProfileFragment({ approvals: { mode: 'off' } }).ok).toBe(false)
  })
})
