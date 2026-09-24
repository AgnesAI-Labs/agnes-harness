import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPackageManager, parseSource, readLock, writeLock } from '@agnes/package-manager'
import { afterEach, expect, it, vi } from 'vitest'
import { activateDefaultHelpers, initializeDefaultHelpers } from '../src/packages/default-helpers.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agh-default-helpers-'))
  roots.push(root)
  const profileDir = join(root, 'profiles', 'local-dev')
  mkdirSync(profileDir, { recursive: true })
  const exec = vi.fn(async () => {
    throw new Error('Network forbidden')
  })
  const manager = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.0.0',
    exec,
    references: async () => [],
  })
  const initializePolicy = async () => {
    const current = readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.0.0' })
    writeLock(profileDir, {
      ...current,
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
        ].map((n) => [n, '@agnes/base']),
      ),
      policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
    })
  }
  return { root, profileDir, manager, exec, initializePolicy }
}
it('installs three release packages offline once and preserves disable/remove on subsequent starts', async () => {
  const s = setup()
  await initializeDefaultHelpers(s)
  expect(
    (await s.manager.inventory(s.profileDir)).packages.map((p) => [
      p.id,
      p.entry.state.enabled,
      !!p.entry.state.trusted,
    ]),
  ).toEqual([
    ['@agnes/mcp-helper', true, true],
    ['@agnes/plugin-helper', true, true],
    ['@agnes/skill-helper', true, true],
  ])
  const publish = vi.fn(async () => {})
  await activateDefaultHelpers({
    profileDir: s.profileDir,
    inventory: await s.manager.inventory(s.profileDir),
    previous: undefined,
    publish,
  })
  expect(publish).toHaveBeenCalledOnce()
  await s.manager.setEnabled(s.profileDir, '@agnes/mcp-helper', false)
  await s.manager.setEnabled(s.profileDir, '@agnes/skill-helper', false)
  await s.manager.remove(s.profileDir, '@agnes/skill-helper')
  await initializeDefaultHelpers(s)
  expect(
    (await s.manager.inventory(s.profileDir)).packages.map((p) => [p.id, p.entry.state.enabled]),
  ).toEqual([
    ['@agnes/mcp-helper', false],
    ['@agnes/plugin-helper', true],
  ])
  expect(s.exec).not.toHaveBeenCalled()
})
it('provisions old profiles and rejects damaged initialization records', async () => {
  const s = setup()
  await s.initializePolicy()
  await initializeDefaultHelpers(s)
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(3)
  writeFileSync(join(s.profileDir, 'default-helpers', 'state.json'), '{}')
  await expect(initializeDefaultHelpers(s)).rejects.toThrow('Invalid helper initialization')
})
it('resumes interrupted first initialization without replacing already installed packages', async () => {
  const s = setup()
  const trust = s.manager.trust.bind(s.manager)
  const spy = vi
    .spyOn(s.manager, 'trust')
    .mockRejectedValueOnce(new Error('interrupted'))
    .mockImplementation(trust)
  await expect(initializeDefaultHelpers(s)).rejects.toThrow('interrupted')
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(1)
  await initializeDefaultHelpers(s)
  expect((await s.manager.inventory(s.profileDir)).packages.every((p) => p.entry.state.enabled)).toBe(true)
  expect(JSON.parse(readFileSync(join(s.profileDir, 'default-helpers', 'state.json'), 'utf8')).phase).toBe(
    'installed',
  )
  spy.mockRestore()
})
it('does not trust an interrupted initialization with changed release hashes', async () => {
  const s = setup()
  const spy = vi.spyOn(s.manager, 'trust').mockRejectedValueOnce(new Error('interrupted'))
  await expect(initializeDefaultHelpers(s)).rejects.toThrow('interrupted')
  spy.mockRestore()
  const file = join(s.profileDir, 'default-helpers', 'state.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  state.integrity['@agnes/skill-helper'] = `sha256-${'0'.repeat(64)}`
  writeFileSync(file, JSON.stringify(state))
  await expect(initializeDefaultHelpers(s)).rejects.toThrow('verification failed')
  expect((await s.manager.inventory(s.profileDir)).packages.every((p) => !p.entry.state.trusted)).toBe(true)
})

it('retries target publication after failure and never reactivates completed defaults', async () => {
  const s = setup()
  await initializeDefaultHelpers(s)
  const publish = vi.fn().mockRejectedValueOnce(new Error('probe failed')).mockResolvedValue(undefined)
  const options = {
    profileDir: s.profileDir,
    inventory: await s.manager.inventory(s.profileDir),
    previous: undefined,
    publish,
  }
  await expect(activateDefaultHelpers(options)).rejects.toThrow('probe failed')
  await initializeDefaultHelpers(s)
  await activateDefaultHelpers(options)
  await activateDefaultHelpers(options)
  expect(publish).toHaveBeenCalledTimes(2)
})

it('migrates the earlier existing marker without enabling or replacing an installed helper', async () => {
  const s = setup()
  await s.initializePolicy()
  const source = parseSource('file:./bundled-plugins/skill-helper')
  const preview = await s.manager.inspect(s.profileDir, source)
  await s.manager.install(s.profileDir, source, { expectedIntegrity: preview.integrity })
  const before = (await s.manager.inventory(s.profileDir)).packages.find(
    (p) => p.id === '@agnes/skill-helper',
  )
  mkdirSync(join(s.profileDir, 'default-helpers'))
  writeFileSync(
    join(s.profileDir, 'default-helpers', 'state.json'),
    JSON.stringify({ version: 1, phase: 'existing', integrity: {} }),
  )
  await initializeDefaultHelpers(s)
  const inventory = await s.manager.inventory(s.profileDir)
  expect(inventory.packages.find((p) => p.id === '@agnes/skill-helper')).toEqual(before)
  expect(inventory.packages.find((p) => p.id === '@agnes/mcp-helper')?.entry.state).toMatchObject({
    enabled: true,
  })
  const publish = vi.fn(async () => {})
  await activateDefaultHelpers({ profileDir: s.profileDir, inventory, previous: undefined, publish })
  expect(publish).toHaveBeenCalledOnce()
  await s.manager.setEnabled(s.profileDir, '@agnes/mcp-helper', false)
  await s.manager.remove(s.profileDir, '@agnes/mcp-helper')
  await initializeDefaultHelpers(s)
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(2)
})
it('records completion without activation when all helpers are already installed', async () => {
  const s = setup()
  await s.initializePolicy()
  for (const name of ['skill-helper', 'mcp-helper', 'plugin-helper']) {
    const source = parseSource(`file:./bundled-plugins/${name}`)
    const preview = await s.manager.inspect(s.profileDir, source)
    await s.manager.install(s.profileDir, source, { expectedIntegrity: preview.integrity })
  }
  const before = await s.manager.inventory(s.profileDir)
  await initializeDefaultHelpers(s)
  expect(await s.manager.inventory(s.profileDir)).toEqual(before)
  const publish = vi.fn(async () => {})
  await activateDefaultHelpers({ profileDir: s.profileDir, inventory: before, previous: undefined, publish })
  expect(publish).not.toHaveBeenCalled()
  await initializeDefaultHelpers(s)
  expect(JSON.parse(readFileSync(join(s.profileDir, 'default-helpers', 'state.json'), 'utf8')).phase).toBe(
    'complete',
  )
})

it('migrates a completed v1 profile by adding only plugin-helper, preserving prior removals', async () => {
  const s = setup()
  await s.initializePolicy()
  mkdirSync(join(s.profileDir, 'default-helpers'))
  writeFileSync(
    join(s.profileDir, 'default-helpers', 'state.json'),
    JSON.stringify({ version: 1, phase: 'complete', integrity: {} }),
  )
  await initializeDefaultHelpers(s)
  expect((await s.manager.inventory(s.profileDir)).packages.map((p) => p.id)).toEqual([
    '@agnes/plugin-helper',
  ])
  await activateDefaultHelpers({
    profileDir: s.profileDir,
    inventory: await s.manager.inventory(s.profileDir),
    previous: undefined,
    publish: async () => {},
  })
  expect(JSON.parse(readFileSync(join(s.profileDir, 'default-helpers', 'state.json'), 'utf8')).version).toBe(
    2,
  )
  await s.manager.setEnabled(s.profileDir, '@agnes/plugin-helper', false)
  await s.manager.remove(s.profileDir, '@agnes/plugin-helper')
  await initializeDefaultHelpers(s)
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
})
