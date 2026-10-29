import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { buildDeploymentPolicy } from '../src/surfaces/deployment-policy.js'

let root: string, profile: string, deploy: string
const base = () => ({
  deployDir: deploy,
  profileDir: profile,
  harnessVersion: '0.1.0',
  surfaceApiVersion: '1.0.0',
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-policy-'))
  profile = join(root, 'profiles/local-dev')
  deploy = join(profile, 'deploy')
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
  writeFileSync(
    join(deploy, 'surfaces/main.json'),
    JSON.stringify({
      package: 'agnes/demo-surface',
      surfaceId: 'demo',
      mount: '/demo',
      sourceId: 'customer',
      config: {},
      secrets: {},
      grants: [],
    }),
  )
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('grants nothing by default, one empty ceiling per sourceId', () => {
  const policy = buildDeploymentPolicy(base())
  expect(policy.harnessVersion).toBe('0.1.0')
  expect(policy.surfaceApiVersion).toBe('1.0.0')
  expect(Object.keys(policy.grants)).toEqual(['customer'])
  expect(policy.grants.customer).toEqual([])
})

it('has exactly the three keys resolveDeployment demands', () => {
  expect(Object.keys(buildDeploymentPolicy(base())).sort().join()).toBe(
    'grants,harnessVersion,surfaceApiVersion',
  )
})

it('applies an operator override file from the profile directory', () => {
  const grant = { extension: 'agnes/demo-backend', name: 'data.read', range: '^1.0' }
  writeFileSync(join(profile, 'deployment-policy.json'), JSON.stringify({ grants: { customer: [grant] } }))
  expect(buildDeploymentPolicy(base()).grants.customer).toEqual([grant])
})

it('still yields an empty ceiling for a sourceId the override file does not mention', () => {
  writeFileSync(join(profile, 'deployment-policy.json'), JSON.stringify({ grants: {} }))
  expect(buildDeploymentPolicy(base()).grants.customer).toEqual([])
})

it('M7: ignores a policy file that would fall inside the customer deploy directory', () => {
  // RC5's security argument is that deployment-policy.json lives OUTSIDE the customer-authored
  // deploy directory (see the module doc on buildDeploymentPolicy). Simulates an operator who ran
  // `agnes profile trust <profileDir>` pointing straight at the profile root instead of a
  // subdirectory of it, so `deployDir === profileDir` -- writing `deployment-policy.json` there
  // means it is now physically inside `deployDir` too. Without the fix this file would be honored,
  // letting the customer-authored tree hand itself a grant. Rebuilds `manifest.json`/`surfaces/
  // main.json` directly under `profile` (rather than `profile/deploy`) since deployDir now equals
  // profileDir.
  const selfDeploy = mkdtempSync(join(tmpdir(), 'agnes-policy-self-'))
  mkdirSync(join(selfDeploy, 'surfaces'), { recursive: true })
  writeFileSync(
    join(selfDeploy, 'manifest.json'),
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
  writeFileSync(
    join(selfDeploy, 'surfaces/main.json'),
    JSON.stringify({
      package: 'agnes/demo-surface',
      surfaceId: 'demo',
      mount: '/demo',
      sourceId: 'customer',
      config: {},
      secrets: {},
      grants: [],
    }),
  )
  const grant = { extension: 'agnes/demo-backend', name: 'data.read', range: '^1.0' }
  writeFileSync(join(selfDeploy, 'deployment-policy.json'), JSON.stringify({ grants: { customer: [grant] } }))
  try {
    const policy = buildDeploymentPolicy({
      deployDir: selfDeploy,
      profileDir: selfDeploy,
      harnessVersion: '0.1.0',
      surfaceApiVersion: '1.0.0',
    })
    expect(policy.grants.customer).toEqual([])
  } finally {
    rmSync(selfDeploy, { recursive: true, force: true })
  }
})

it('M6: never backfills the ceiling from the instance own grants', () => {
  writeFileSync(
    join(deploy, 'surfaces/main.json'),
    JSON.stringify({
      package: 'agnes/demo-surface',
      surfaceId: 'demo',
      mount: '/demo',
      sourceId: 'customer',
      config: {},
      secrets: {},
      grants: [{ extension: 'acme/backend', name: 'data.read', range: '^1.0' }],
    }),
  )
  expect(buildDeploymentPolicy(base()).grants.customer).toEqual([])
})
