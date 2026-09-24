import { validateProfileManifest, validateResolvedProfile } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { isHostError } from '../../src/errors.js'
import { resolveProfile } from '../../src/profile/resolve.js'
import type { ResolveEnv, RuntimeProfileManifest } from '../../src/profile/types.js'

const env: ResolveEnv = {
  platform: { os: 'linux', arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-20T00:00:00Z',
}

async function rejectedReconcile(reconcile: unknown): Promise<{ code: string; detail: unknown }> {
  try {
    await resolveProfile(
      {
        builtin: 'local-dev',
        user: { name: 'policy-test', reconcile } as RuntimeProfileManifest,
      },
      env,
    )
    expect.unreachable('invalid reconcile policy should be rejected')
  } catch (error) {
    if (!isHostError(error)) throw error
    return { code: error.code, detail: error.detail }
  }
  throw new Error('unreachable')
}

describe('Task 7 profile reconcile policy', () => {
  it('defaults to immediate without a max wait', async () => {
    const profile = await resolveProfile({ builtin: 'local-dev' }, env)
    expect(profile.reconcile).toEqual({ point: 'immediate' })
    expect(Object.isFrozen(profile.reconcile)).toBe(true)
    expect(validateResolvedProfile(profile).ok).toBe(true)
  })

  it('accepts turn or step and keeps maxWaitMs optional', async () => {
    const turn = await resolveProfile(
      { builtin: 'local-dev', user: { name: 'turn', reconcile: { point: 'turn', maxWaitMs: 250 } } },
      env,
    )
    const step = await resolveProfile(
      { builtin: 'local-dev', user: { name: 'step', reconcile: { point: 'step' } } },
      env,
    )

    expect(turn.reconcile).toEqual({ point: 'turn', maxWaitMs: 250 })
    expect(step.reconcile).toEqual({ point: 'step' })
    expect(turn.hash).not.toBe(step.hash)
    expect(validateProfileManifest({ name: 'turn', reconcile: turn.reconcile }).ok).toBe(true)
    expect(validateProfileManifest({ name: 'step', reconcile: step.reconcile }).ok).toBe(true)
    expect(
      validateProfileManifest({
        name: 'max-wait',
        reconcile: { point: 'turn', maxWaitMs: 2_147_483_647 },
      }).ok,
    ).toBe(true)
  })

  it('rejects maxWaitMs for immediate in both schema and resolver', async () => {
    const manifest = { name: 'bad', reconcile: { point: 'immediate', maxWaitMs: 1 } }
    expect(validateProfileManifest(manifest).ok).toBe(false)
    expect(await rejectedReconcile(manifest.reconcile)).toEqual({
      code: 'E_PROFILE_FRAGMENT_KEY',
      detail: { field: 'reconcile.maxWaitMs', point: 'immediate' },
    })
  })

  it.each([
    [{ point: 'turn', maxWaitMs: -1 }, 'reconcile.maxWaitMs'],
    [{ point: 'step', maxWaitMs: 1.5 }, 'reconcile.maxWaitMs'],
    [{ point: 'turn', maxWaitMs: 2_147_483_648 }, 'reconcile.maxWaitMs'],
    [{ point: 'later' }, 'reconcile.point'],
    [{ point: 'turn', extra: true }, 'reconcile'],
  ])('rejects an invalid policy %#', async (reconcile, field) => {
    expect(validateProfileManifest({ name: 'bad', reconcile }).ok).toBe(false)
    expect(await rejectedReconcile(reconcile)).toEqual({
      code: 'E_PROFILE_FRAGMENT_KEY',
      detail: { field },
    })
  })
})
