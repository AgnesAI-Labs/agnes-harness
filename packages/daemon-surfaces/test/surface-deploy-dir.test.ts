import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashWorkspace } from '@agnes/package-manager'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resolveDeployDir } from '../src/surfaces/deploy-dir.js'

let root: string, profile: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-deploydir-'))
  profile = join(root, 'profiles/local-dev')
  mkdirSync(profile, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function lockWithWorkspace(deployDir: string, relative: string): string {
  return JSON.stringify({
    version: 1,
    profile: 'local-dev',
    agnesVersion: '0.1.0',
    packages: {},
    workspace: { path: relative, hash: hashWorkspace(deployDir), manifestId: 'customer' },
  })
}

it('returns undefined when the profile has no lockfile at all', () => {
  expect(resolveDeployDir(profile)).toBeUndefined()
})

it('returns undefined when the lockfile has no signed workspace', () => {
  writeFileSync(join(profile, 'agnes.lock'), JSON.stringify({ version: 1, packages: {} }))
  expect(resolveDeployDir(profile)).toBeUndefined()
})

it('resolves a signed workspace path against the profile directory', () => {
  const deploy = join(profile, 'deploy')
  mkdirSync(join(deploy, 'surfaces'), { recursive: true })
  writeFileSync(
    join(deploy, 'manifest.json'),
    JSON.stringify({
      id: 'customer',
      version: '1.0.0',
      harnessRange: '^0.1',
      extensions: [],
      profileFragment: 'profile/main.yaml',
      presets: [],
      fixtures: 'fixtures/data',
      surfaces: ['surfaces/main.json'],
    }),
  )
  writeFileSync(join(profile, 'agnes.lock'), lockWithWorkspace(deploy, 'deploy'))
  expect(resolveDeployDir(profile)).toBe(deploy)
})

it('refuses a workspace whose tree hash no longer matches', () => {
  const deploy = join(profile, 'deploy')
  mkdirSync(join(deploy, 'surfaces'), { recursive: true })
  writeFileSync(join(deploy, 'manifest.json'), '{}')
  writeFileSync(
    join(profile, 'agnes.lock'),
    JSON.stringify({
      version: 1,
      profile: 'local-dev',
      agnesVersion: '0.1.0',
      packages: {},
      workspace: { path: 'deploy', hash: `sha256-${'0'.repeat(64)}`, manifestId: 'customer' },
    }),
  )
  expect(resolveDeployDir(profile)).toBeUndefined()
})
