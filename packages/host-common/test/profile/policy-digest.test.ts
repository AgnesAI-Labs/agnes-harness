import { describe, expect, it } from 'vitest'
import { policyDigest } from '../../src/profile/policy-digest.js'
import { resolveProfile } from '../../src/profile/resolve.js'
import type { LockState, ResolveEnv } from '../../src/profile/types.js'

const env: ResolveEnv = {
  platform: { os: 'darwin', arch: 'arm64', capabilities: { 'sandbox.l1': 'full' } },
  agnesVersion: '0.1.0',
  now: '2026-09-07T00:00:00Z',
}
const builtin = (_id: string) => ({
  version: '0.1.0',
  source: { type: 'builtin' as const, ref: 'builtin' },
  integrity: 'builtin:0.1.0',
  trust: 'builtin' as const,
  enabled: true,
})
const lock: LockState = {
  packages: {
    '@agnes/base': {
      ...builtin('b'),
      provides: [
        'approval',
        'checkpoint',
        'billing',
        'sandbox',
        'verifier',
        'repair',
        'artifacts',
        'principals',
      ],
    },
    '@agnes/code': builtin('c'),
    '@agnes/ai': builtin('a'),
  },
}
const resolve = (user: Record<string, unknown>) =>
  resolveProfile({ builtin: 'local-dev', lock, user: { name: 'x', ...user } }, env)

describe('grant binding across model changes', () => {
  it('the whole-profile hash moves with the model route while the policy digest does not', async () => {
    const before = await resolve({
      provider: { package: '@agnes/ai', routes: [{ route: 'a', api: 'openai', baseUrl: 'https://a/' }] },
    })
    const after = await resolve({
      provider: { package: '@agnes/ai', routes: [{ route: 'b', api: 'openai', baseUrl: 'https://b/' }] },
    })
    // A grant keyed on `hash` is orphaned by this switch.
    expect(after.hash).not.toBe(before.hash)
    expect(policyDigest(after)).toBe(policyDigest(before))
  })

  it('an approval or policy change moves the digest', async () => {
    const base = await resolve({})
    expect(policyDigest(await resolve({ approvals: { mode: 'off' } }))).not.toBe(policyDigest(base))
    expect(policyDigest(await resolve({ policy: { capabilityCeiling: ['fs.read'] } }))).not.toBe(
      policyDigest(base),
    )
  })
})
