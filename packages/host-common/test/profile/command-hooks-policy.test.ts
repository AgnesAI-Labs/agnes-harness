import { createHash } from 'node:crypto'
import { canonicalJson } from '@agnes/core'
import {
  validateCommandHooksPolicy,
  validateProfileFragment,
  validateProfileManifest,
  validateResolvedProfile,
} from '@agnes/protocol'
import { expect, it } from 'vitest'
import { resolveProfile } from '../../src/profile/resolve.js'
import type { ProfileInputs, ResolveEnv } from '../../src/profile/types.js'

const env: ResolveEnv = {
  platform: { os: 'win32', arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-14T00:00:00Z',
}
const grant = {
  source: 'workspace' as const,
  configDigest: `sha256-${'a'.repeat(64)}`,
  workspaceRoot: 'C:/work/中文 project',
}
const policy = { trustedUnconfined: [grant] }
const input: ProfileInputs = { builtin: 'local-dev', user: { name: 'local-dev', commandHooks: policy } }

it('carries the exact trusted grant in a frozen profile and its complete hash', async () => {
  expect(validateProfileManifest(input.user).ok).toBe(true)
  const resolved = await resolveProfile(input, env)
  expect(validateResolvedProfile(resolved).ok).toBe(true)
  expect(resolved.commandHooks).toEqual(policy)
  expect(Object.isFrozen(resolved.commandHooks?.trustedUnconfined[0])).toBe(true)
  expect(Object.isFrozen(grant)).toBe(false)
  const { hash, ...body } = resolved
  expect(hash).toBe(`sha256-${createHash('sha256').update(canonicalJson(body)).digest('hex')}`)
  const changed = await resolveProfile(
    {
      ...input,
      user: {
        name: 'local-dev',
        commandHooks: { trustedUnconfined: [{ ...grant, configDigest: `sha256-${'b'.repeat(64)}` }] },
      },
    },
    env,
  )
  expect(changed.hash).not.toBe(hash)
  const omitted = await resolveProfile({ builtin: 'local-dev' }, env)
  expect(omitted).not.toHaveProperty('commandHooks')
  const revoked = await resolveProfile(
    { ...input, user: { name: 'local-dev', commandHooks: { trustedUnconfined: [] } } },
    env,
  )
  expect(revoked.commandHooks?.trustedUnconfined).toEqual([])
  expect(revoked.hash).not.toBe(hash)
})

it.each([policy, { trustedUnconfined: [] }, undefined])(
  'rejects workspace declarations even when identical or empty',
  async (commandHooks) => {
    const fragment = { commandHooks }
    expect(validateProfileFragment(fragment).ok).toBe(false)
    await expect(
      resolveProfile(
        {
          ...input,
          lock: { packages: {}, workspace: { path: 'deploy', hash: 'sha256-test', manifestId: 'test' } },
          workspaceOverlay: fragment as never,
        },
        env,
      ),
    ).rejects.toMatchObject({ code: 'E_PROFILE_FRAGMENT_KEY', source: { layer: 'workspace' } })
  },
)

it.each([
  null,
  true,
  {},
  { trustedUnconfined: true },
  { ...policy, allow: true },
  { trustedUnconfined: [{ ...grant, allow: true }] },
  { trustedUnconfined: [{ ...grant, source: 'any' }] },
  { trustedUnconfined: [{ ...grant, workspaceRoot: 'relative' }] },
  { trustedUnconfined: [{ ...grant, workspaceRoot: 'C:relative' }] },
  { trustedUnconfined: [{ ...grant, workspaceRoot: `C:/bad${String.fromCharCode(0)}` }] },
  { trustedUnconfined: [{ ...grant, configDigest: `sha256-${'A'.repeat(64)}` }] },
  { trustedUnconfined: [grant, grant] },
  { trustedUnconfined: Array.from({ length: 129 }, (_, i) => ({ ...grant, workspaceRoot: `/work/${i}` })) },
])('fails closed on malformed or oversized grants', async (commandHooks) => {
  expect(validateCommandHooksPolicy(commandHooks).ok).toBe(false)
  await expect(
    resolveProfile({ builtin: 'local-dev', user: { name: 'local-dev', commandHooks } as never }, env),
  ).rejects.toMatchObject({ code: 'E_PROFILE_FRAGMENT_KEY' })
})

it.each([
  '/work/project',
  'C:/work/project',
  String.raw`C:\work\中文 project`,
  String.raw`\\server\share\workspace`,
])('accepts explicit cross-platform absolute path %s', (workspaceRoot) => {
  expect(validateCommandHooksPolicy({ trustedUnconfined: [{ ...grant, workspaceRoot }] }).ok).toBe(true)
})
