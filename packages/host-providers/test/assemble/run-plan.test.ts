import { resolveProfile } from '@agnes/host-common/profile/resolve'
import { loadTemplate } from '@agnes/host-common/profile/templates'
import { expect, it } from 'vitest'
import { compileRunPlan, seamSelectionsOf } from '../../src/assemble/run-plan.js'

const env = {
  platform: { os: 'linux' as const, arch: 'x64', capabilities: {} },
  agnesVersion: '1.4.0',
  now: '2026-10-13',
}

it('plans the seven seam kinds from the providers table and says which layer chose each', async () => {
  const profile = await resolveProfile(
    {
      builtin: 'local-dev',
      user: { name: 'local-dev', providers: { checkpoint: { provider: 'object-store', version: '2.0.0' } } },
    },
    env,
  )
  const templateSeams = loadTemplate('local-dev').providers
  const plan = compileRunPlan({ profile, ...(templateSeams ? { templateSeams } : {}) })

  expect(plan.seams.map(({ kind, pinned }) => [kind, pinned])).toEqual([
    ['approval', true],
    ['principals', true],
    ['billing', true],
    ['checkpoint', true],
    ['artifacts', true],
    ['verifier', false],
    ['repair', false],
  ])
  // The key is where the selection is written, so a reader of `explain` knows what to edit.
  expect(plan.explain).toContainEqual({
    key: 'providers.checkpoint',
    value: { provider: 'object-store', version: '2.0.0' },
    source: 'user',
  })
  expect(plan.explain).toContainEqual({
    key: 'providers.approval',
    value: { provider: 'local-prompt' },
    source: 'template',
  })
  expect(plan.explain.map(({ key }) => key)).toEqual(plan.seams.map(({ kind }) => `providers.${kind}`))

  // A rebuilt container keeps what its generation recorded, whatever the profile says now.
  const recorded = seamSelectionsOf(plan)
  const later = await resolveProfile({ builtin: 'local-dev', user: { name: 'local-dev' } }, env)
  const rebuilt = compileRunPlan({ profile: later, snapshotSeams: recorded })
  expect(rebuilt.seams.find(({ kind }) => kind === 'checkpoint')?.selection).toEqual({
    provider: 'object-store',
    version: '2.0.0',
  })
  expect(rebuilt.explain.every(({ source }) => source === 'generation')).toBe(true)
})
