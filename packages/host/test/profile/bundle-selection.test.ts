import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { afterEach, expect, it } from 'vitest'
import { createCompositionAdmin, readBundleSelection } from '../../src/runtime/profile/bundle-selection.js'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

it('uses inspection for display but freshly validates bundle writes', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'agh-bundle-selection-'))
  homes.push(profileDir)
  const admin = createCompositionAdmin({
    profileDir,
    inspectProfile: async () => ({ bundleCatalog: {} }) as ResolvedProfile,
    resolveProfile: async () => {
      throw new Error('current sources rejected')
    },
  })
  expect(await admin.bundles()).toMatchObject({ catalog: [], revision: 0 })
  await expect(admin.saveBundles({ revision: 0, bundles: [] })).rejects.toThrow('current sources rejected')
  expect(readBundleSelection(profileDir)).toEqual({ revision: 0, bundles: [] })
})

it('reads an absent selection as empty and a valid one as saved', () => {
  const profile = mkdtempSync(join(tmpdir(), 'agh-bundle-selection-'))
  homes.push(profile)
  expect(readBundleSelection(profile)).toEqual({ revision: 0, bundles: [] })
  writeFileSync(join(profile, 'bundle-selection.json'), JSON.stringify({ revision: 2, bundles: ['pkg#set'] }))
  expect(readBundleSelection(profile)).toEqual({ revision: 2, bundles: ['pkg#set'] })
})

it.each(['{', 'null', JSON.stringify({ revision: 1, bundles: ['not a bundle id'] })])(
  'fails closed on a damaged selection (%s), names the file and keeps it as found',
  (content) => {
    const profile = mkdtempSync(join(tmpdir(), 'agh-bundle-selection-'))
    homes.push(profile)
    const file = join(profile, 'bundle-selection.json')
    writeFileSync(file, content)
    let failure: unknown
    try {
      readBundleSelection(profile)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'CONFIG_INVALID_STATE', file })
    expect((failure as Error).message).toContain(file)
    expect(readFileSync(file, 'utf8')).toBe(content)
  },
)
