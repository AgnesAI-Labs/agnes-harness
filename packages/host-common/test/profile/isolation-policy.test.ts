import { createHash } from 'node:crypto'
import { canonicalJson } from '@agnes/core'
import { expect, it } from 'vitest'
import { mergeIsolation, withAssemblyIsolation } from '../../src/profile/isolation.js'
import { resolveProfile } from '../../src/profile/resolve.js'
import type { ProfileInputs, ResolveEnv } from '../../src/profile/types.js'

const env: ResolveEnv = {
  platform: { os: 'darwin', arch: 'arm64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-13T00:00:00Z',
}
const modes = ['off', 'preferred', 'required'] as const,
  id = 'acme/plugin'
const policy = (mode: (typeof modes)[number]) => ({ extensions: { [id]: mode } })
it('applies all 81 user/local/flags/managed mode combinations monotonically in actual resolver', async () => {
  for (const user of modes)
    for (const local of modes)
      for (const flags of modes)
        for (const managed of modes) {
          const result = await resolveProfile(
            {
              builtin: 'local-dev',
              user: { name: 'local-dev', extensionIsolation: policy(user) },
              local: { extensionIsolation: policy(local) },
              flags: { extensionIsolation: policy(flags) },
              managed: { version: 1, policy: {}, extensionIsolation: policy(managed) },
            },
            env,
          )
          expect(result.extensionIsolation?.extensions[id]).toBe(
            modes[Math.max(...[user, local, flags, managed].map((m) => modes.indexOf(m)))],
          )
          expect(Object.isFrozen(result.extensionIsolation?.extensions)).toBe(true)
        }
})
it('keeps workspace requests and includes backend/effective modes in the entire resolved hash', async () => {
  const input: ProfileInputs = {
    builtin: 'local-dev',
    lock: { packages: {}, workspace: { path: 'deploy', hash: 'sha256-test', manifestId: 'customer' } },
    workspaceOverlay: { extensionIsolation: { extensions: { [id]: 'required' } } },
    local: { extensionIsolation: policy('off') },
  }
  const result = await resolveProfile(input, env)
  expect(result.extensionIsolation).toEqual({ backend: 'auto', extensions: { [id]: 'required' } })
  const { hash, ...body } = result
  expect(hash).toBe(`sha256-${createHash('sha256').update(canonicalJson(body)).digest('hex')}`)
  const changed = await resolveProfile(
    { ...input, flags: { extensionIsolation: { ...policy('off'), backend: 'bwrap' } } },
    env,
  )
  expect(changed.hash).not.toBe(hash)
  expect(changed.extensionIsolation?.extensions[id]).toBe('required')
})
it('canonicalizes ID order and keeps the old structure when policy is omitted', async () => {
  const a = { extensions: { 'acme/a': 'required' as const, 'acme/b': 'preferred' as const } },
    b = { extensions: { 'acme/b': 'preferred' as const, 'acme/a': 'required' as const } }
  const one = await resolveProfile(
    { builtin: 'local-dev', user: { name: 'local-dev', extensionIsolation: a } },
    env,
  )
  const two = await resolveProfile(
    { builtin: 'local-dev', user: { name: 'local-dev', extensionIsolation: b } },
    env,
  )
  expect(one).toEqual(two)
  expect(await resolveProfile({ builtin: 'local-dev' }, env)).not.toHaveProperty('extensionIsolation')
  expect(Object.isFrozen(a.extensions)).toBe(false)
})
it('rehashes trusted legacy assembly tightening without allowing a downgrade', async () => {
  const base = await resolveProfile(
    { builtin: 'local-dev', user: { name: 'local-dev', extensionIsolation: policy('required') } },
    env,
  )
  expect(withAssemblyIsolation(base, policy('off'))).toBe(base)
  const changed = withAssemblyIsolation(base, { ...policy('off'), backend: 'seatbelt' })
  expect(changed.extensionIsolation).toEqual({ backend: 'seatbelt', extensions: { [id]: 'required' } })
  expect(changed.hash).not.toBe(base.hash)
  expect(withAssemblyIsolation(changed, { ...policy('off'), backend: 'seatbelt' })).toBe(changed)
})
it('refuses malformed policies and mixed unimplemented layers without dropping their fields', async () => {
  await expect(
    resolveProfile(
      { builtin: 'local-dev', local: { ...{ name: 'other' }, extensionIsolation: policy('required') } },
      env,
    ),
  ).rejects.toMatchObject({ detail: { reason: 'unimplemented' } })
  await expect(
    resolveProfile(
      {
        builtin: 'local-dev',
        managed: {
          version: 1,
          policy: { capabilityCeiling: ['tools'] },
          extensionIsolation: policy('required'),
        },
      },
      env,
    ),
  ).rejects.toMatchObject({ detail: { reason: 'unimplemented' } })
  await expect(
    resolveProfile(
      {
        builtin: 'local-dev',
        workspaceOverlay: { extensionIsolation: { extensions: { [id]: 'required' } } },
      },
      env,
    ),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_UNTRUSTED' })
  expect(() => mergeIsolation(undefined, { extensions: { '*': 'required' } })).toThrow()
  expect(() => mergeIsolation({ extensions: { '*': 'required' } }, undefined)).toThrow()
})
it('does not let omitted backend in later isolation-only layers reset an explicit choice', async () => {
  const result = await resolveProfile(
    {
      builtin: 'local-dev',
      user: { name: 'local-dev', extensionIsolation: { ...policy('preferred'), backend: 'seatbelt' } },
      local: { extensionIsolation: policy('required') },
      flags: { extensionIsolation: policy('off') },
      managed: { version: 1, policy: {}, extensionIsolation: policy('off') },
    },
    env,
  )
  expect(result.extensionIsolation).toEqual({ backend: 'seatbelt', extensions: { [id]: 'required' } })
})
it('refuses an oversized effective union in resolver and legacy assembly merging', async () => {
  const extensionIsolation = {
    extensions: Object.fromEntries(
      Array.from({ length: 128 }, (_, i) => [`acme/p${i}`, 'required' as const]),
    ),
  }
  const base = await resolveProfile(
    { builtin: 'local-dev', user: { name: 'local-dev', extensionIsolation } },
    env,
  )
  expect(Object.keys(base.extensionIsolation?.extensions ?? {})).toHaveLength(128)
  await expect(
    resolveProfile(
      {
        builtin: 'local-dev',
        user: { name: 'local-dev', extensionIsolation },
        local: { extensionIsolation: policy('required') },
      },
      env,
    ),
  ).rejects.toMatchObject({ code: 'E_PROFILE_FRAGMENT_KEY' })
  expect(() => withAssemblyIsolation(base, policy('required'))).toThrow('exceeds limits')
})
