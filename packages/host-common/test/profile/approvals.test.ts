import { describe, expect, it } from 'vitest'
import { isHostError } from '../../src/errors.js'
import { resolveProfile } from '../../src/profile/resolve.js'
import type { LockState, ProfileInputs, ResolveEnv } from '../../src/profile/types.js'

const env: ResolveEnv = {
  platform: { os: 'linux', arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-17T00:00:00Z',
}
const lock: LockState = { packages: {} }
const workspace = { path: '/work', hash: 'sha256-workspace', manifestId: 'fixture' }
const workspaceOff = { approvals: { mode: 'off' } } as unknown as NonNullable<
  ProfileInputs['workspaceOverlay']
>

async function refused(input: ProfileInputs) {
  try {
    await resolveProfile(input, env)
    expect.unreachable('profile should be refused')
  } catch (error) {
    if (!isHostError(error)) throw error
    return error
  }
  throw new Error('unreachable')
}

describe('resolved approval mode', () => {
  it('defaults to manual and includes the default in the resolved hash', async () => {
    const implicit = await resolveProfile({ builtin: 'local-dev', lock, user: { name: 'local-dev' } }, env)
    const explicit = await resolveProfile(
      { builtin: 'local-dev', lock, user: { name: 'local-dev', approvals: { mode: 'manual' } } },
      env,
    )
    expect(implicit.approvals).toEqual({ mode: 'manual' })
    expect(explicit.approvals).toEqual({ mode: 'manual' })
    expect(implicit.hash).toBe(explicit.hash)
  })

  it.each(['smart', 'off'] as const)('accepts %s only from the trusted profile layer', async (mode) => {
    const manual = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const resolved = await resolveProfile(
      { builtin: 'local-dev', lock, user: { name: 'local-dev', approvals: { mode } } },
      env,
    )
    expect(resolved.approvals.mode).toBe(mode)
    expect(resolved.hash).not.toBe(manual.hash)
  })

  it('rejects workspace off instead of treating a verified repository as an admin layer', async () => {
    const error = await refused({
      builtin: 'local-dev',
      lock: { ...lock, workspace },
      workspaceOverlay: workspaceOff,
    })
    expect(error).toMatchObject({
      code: 'E_PROFILE_FRAGMENT_KEY',
      source: { layer: 'workspace' },
      detail: { field: 'approvals.mode', mode: 'off' },
    })
  })

  it('rejects malformed approval objects instead of hashing only the recognized subset', async () => {
    const error = await refused({
      builtin: 'local-dev',
      lock,
      user: {
        name: 'local-dev',
        approvals: { mode: 'manual', ignored: true } as unknown as { mode: 'manual' },
      },
    })
    expect(error).toMatchObject({
      code: 'E_PROFILE_FRAGMENT_KEY',
      source: { layer: 'user' },
      detail: { field: 'approvals.mode' },
    })
  })

  it('lets a workspace tighten off to smart/manual but never manual to smart', async () => {
    for (const mode of ['smart', 'manual'] as const) {
      const resolved = await resolveProfile(
        {
          builtin: 'local-dev',
          lock: { ...lock, workspace },
          user: { name: 'trusted', approvals: { mode: 'off' } },
          workspaceOverlay: { approvals: { mode } },
        },
        env,
      )
      expect(resolved.approvals.mode).toBe(mode)
    }

    const error = await refused({
      builtin: 'local-dev',
      lock: { ...lock, workspace },
      workspaceOverlay: { approvals: { mode: 'smart' } },
    })
    expect(error).toMatchObject({
      code: 'E_PROFILE_FRAGMENT_KEY',
      detail: { field: 'approvals.mode', from: 'manual', to: 'smart' },
    })
  })
})
