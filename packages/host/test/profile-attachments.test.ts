import { validateProfileFragment, validateProfileManifest, validateResolvedProfile } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { isHostError } from '../src/errors.js'
import { resolveProfile } from '../src/profile/resolve.js'
import type { ProfileFragment, ResolveEnv, RuntimeProfileManifest } from '../src/profile/types.js'

const env: ResolveEnv = {
  platform: { os: 'linux', arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-10-13T00:00:00Z',
}

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; detail: unknown }> {
  try {
    await run()
  } catch (error) {
    if (!isHostError(error)) throw error
    return { code: error.code, detail: error.detail }
  }
  throw new Error('expected a refusal')
}

describe('attachments profile', () => {
  it('stores by reference unless the user turns it off', async () => {
    const plain = await resolveProfile({ builtin: 'local-dev' }, env)
    expect(plain.attachments).toEqual({ storeByReference: true })
    expect(validateResolvedProfile(plain).ok).toBe(true)

    const off = await resolveProfile(
      { builtin: 'local-dev', user: { name: 'mine', attachments: { storeByReference: false } } },
      env,
    )
    expect(off.attachments).toEqual({ storeByReference: false })
    expect(off.hash).not.toBe(plain.hash)
    expect(validateResolvedProfile(off).ok).toBe(true)
    expect(Object.isFrozen(off.attachments)).toBe(true)

    const empty = await resolveProfile({ builtin: 'local-dev', user: { name: 'mine', attachments: {} } }, env)
    expect(empty.attachments).toEqual({ storeByReference: true })
    expect(validateProfileManifest({ name: 'mine', attachments: { storeByReference: false } }).ok).toBe(true)
  })

  it('refuses the key from a workspace fragment', async () => {
    expect(validateProfileFragment({ attachments: { storeByReference: false } }).ok).toBe(false)
    const workspaceOverlay = { attachments: { storeByReference: false } } as unknown as ProfileFragment
    expect(
      await refusal(() =>
        resolveProfile(
          {
            builtin: 'local-dev',
            workspaceOverlay,
            lock: { packages: {}, workspace: { path: '/w', hash: 'h', manifestId: 'm' } },
          },
          env,
        ),
      ),
    ).toMatchObject({ code: 'E_PROFILE_FRAGMENT_KEY', detail: { field: 'attachments' } })
  })

  it.each([[{ storeByReference: false, extra: true }], [{ storeByReference: 'no' }], [[]], ['off']])(
    'refuses an invalid attachments value %#',
    async (attachments) => {
      expect(validateProfileManifest({ name: 'bad', attachments }).ok).toBe(false)
      expect(
        await refusal(() =>
          resolveProfile(
            { builtin: 'local-dev', user: { name: 'bad', attachments } as unknown as RuntimeProfileManifest },
            env,
          ),
        ),
      ).toMatchObject({ code: 'E_PROFILE_FRAGMENT_KEY', detail: { field: 'attachments' } })
    },
  )
})
