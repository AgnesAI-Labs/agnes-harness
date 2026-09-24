import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BUNDLED_SKILL_HELPER_REF, bundledPluginSourceRoot } from '../src/bundled-plugin-source.js'
import { emptyLock, readLock, writeLock } from '../src/lockfile.js'
import { createPackageManager } from '../src/manager.js'
import { fetchSource, hashDirectory, parseSource } from '../src/sources.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-bundled-helper-'))
  roots.push(root)
  return root
}
it('uses runtime payload instead of workspace impostor and never runs network commands', async () => {
  const cwd = fixture()
  const impostor = join(cwd, 'bundled-plugins', 'skill-helper')
  mkdirSync(impostor, { recursive: true })
  writeFileSync(join(impostor, 'package.json'), JSON.stringify({ name: 'impostor', version: '9.9.9' }))
  const exec = vi.fn(async () => {
    throw new Error('Network/command forbidden')
  })
  const into = join(cwd, 'stage')
  const fetched = await fetchSource(parseSource(BUNDLED_SKILL_HELPER_REF), into, { cwd, exec })
  expect(JSON.parse(readFileSync(join(into, 'package.json'), 'utf8')).name).toBe('@agnes/skill-helper')
  expect(fetched.integrity).toBe(
    hashDirectory(
      join(bundledPluginSourceRoot(BUNDLED_SKILL_HELPER_REF) ?? '', 'bundled-plugins', 'skill-helper'),
    ),
  )
  expect(exec).not.toHaveBeenCalled()
  expect(bundledPluginSourceRoot('file:./ordinary')).toBeUndefined()
  expect(existsSync(join(into, 'src', 'sources.mjs'))).toBe(true)
})
it('inspects and installs offline without automatic trust or activation', async () => {
  const root = fixture(),
    profile = join(root, 'profiles', 'local-dev')
  mkdirSync(profile, { recursive: true })
  writeLock(profile, {
    ...emptyLock('local-dev', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(
      [
        'approval',
        'checkpoint',
        'ledger',
        'sandbox',
        'verifier',
        'repair',
        'artifacts',
        'principals',
        'platform',
        'harness',
      ].map((name) => [name, '@agnes/base']),
    ),
    policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
  })
  const exec = vi.fn(async () => {
    throw new Error('Network forbidden')
  })
  const manager = createPackageManager({ dataDir: root, cwd: root, agnesVersion: '0.1.0', exec })
  const preview = await manager.inspect(profile, parseSource(BUNDLED_SKILL_HELPER_REF))
  expect(preview).toMatchObject({ id: '@agnes/skill-helper', blockers: [] })
  const installed = await manager.add(profile, BUNDLED_SKILL_HELPER_REF)
  expect(installed.state).toMatchObject({ trusted: null, enabled: false })
  expect(
    readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages['@agnes/skill-helper'],
  ).toBeDefined()
  expect(exec).not.toHaveBeenCalled()
})
