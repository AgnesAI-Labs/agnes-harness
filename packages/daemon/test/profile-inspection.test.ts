import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedProfile } from '@agnes/host'
import { expect, it } from 'vitest'
import { createProfileInspection } from '../src/supervisor/profile-inspection.js'

it('reuses static views, invalidates changed inputs, and never keeps a failed resolution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-profile-view-'))
  let name = 'one',
    fail = false
  const inspect = createProfileInspection({
    profileDir: root,
    workspace: root,
    configuration: { profileInput: async () => ({ name }) },
    resolve: async (bundles) => {
      if (fail) throw new Error('invalid profile')
      return { name, adminBundles: bundles, marker: {} } as unknown as ResolvedProfile
    },
  })
  try {
    const first = await inspect()
    expect(await inspect()).toBe(first)
    expect(await inspect([])).not.toBe(first)
    name = 'two'
    expect(await inspect()).toMatchObject({ name: 'two' })
    const second = await inspect()
    // Missing and present files must remain distinct, including sentinel-shaped content.
    await writeFile(join(root, 'agnes-lock.json'), 'absent')
    expect(await inspect()).not.toBe(second)
    name = 'three'
    fail = true
    await expect(inspect()).rejects.toThrow('invalid profile')
    fail = false
    expect(await inspect()).toMatchObject({ name: 'three' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
