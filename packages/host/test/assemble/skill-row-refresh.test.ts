import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ecosystem as baseEcosystem } from '@agnes/base'
import type { SkillRuntimeInput } from '@agnes/resource-control-runtime'
import { expect, it } from 'vitest'
import type { AssemblyContext } from '../../src/runtime/assemble/context.js'
import type { ProcessServices } from '../../src/runtime/assemble/process-services.js'
import { createSkillState } from '../../src/runtime/assemble/skills.js'
import { createTestHost } from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base', import.meta.url))
const emptySkills: SkillRuntimeInput = {
  list: () => [],
  read: () => ({ ok: false, code: 'NOT_FOUND' }),
  readFile: () => ({ ok: false, code: 'NOT_FOUND' }),
}

it('preserves invocation flags through live and discovery views across publication and rollback', () => {
  const flags = { disabled: false, modelInvocable: false, userInvocable: true }
  const source = { ...emptySkills, invocation: () => flags }
  const state = createSkillState(
    {
      deps: { skillResources: source, profileDir: '/profile', homeDir: '/home' },
      dataDir: '/data',
      profile: {},
      gates: {},
    } as unknown as AssemblyContext,
    { skillReadRoots: {} } as ProcessServices,
  )
  expect(state.liveInput.invocation?.('skill')).toEqual(flags)
  expect(state.discovery.invocation?.('skill')).toEqual(flags)
  const disabled = {
    ...emptySkills,
    invocation: () => ({ disabled: true, modelInvocable: false, userInvocable: false }),
  }
  state.active = disabled
  expect(state.liveInput.invocation?.('skill')?.disabled).toBe(true)
  expect(state.discovery.invocation?.('skill')).toEqual(flags)
  state.preload = disabled
  expect(state.discovery.invocation?.('skill')?.disabled).toBe(true)
  state.active = state.preload = source
  expect(state.liveInput.invocation?.('skill')).toEqual(flags)
  expect(state.discovery.invocation?.('skill')).toEqual(flags)
  state.active = state.preload = emptySkills
  expect(state.liveInput.invocation?.('skill')).toBeUndefined()
  expect(state.discovery.invocation?.('skill')).toBeUndefined()
})

it('retries an unloaded Skills row even when its effective revision is unchanged', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agnes-skill-row-'))
  let attempts = 0
  try {
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      skillResources: emptySkills,
      packages: {
        '@agnes/base': {
          ecosystem: {
            ...baseEcosystem,
            'agnes/skills': (init) => {
              attempts++
              if (attempts === 1) throw new Error('synthetic first load failure')
              return baseEcosystem['agnes/skills'](init)
            },
          },
        },
      },
    })
    try {
      expect(host.extensions().find((status) => status.id === 'agnes/skills')?.loaded).toBe(false)
      await host.refreshSkillRow(emptySkills)
      expect(attempts).toBe(2)
      expect(host.extensions().find((status) => status.id === 'agnes/skills')?.loaded).toBe(true)
      await host.refreshSkillRow(emptySkills)
      expect(attempts).toBe(2)
    } finally {
      await host.close()
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
