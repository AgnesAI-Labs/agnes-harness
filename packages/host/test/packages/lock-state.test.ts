import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostError } from '../../src/errors.js'
import {
  defaultVerifyIntegrity,
  lockState,
  snapshotPolicy,
  verifyLockIntegrity,
} from '../../src/packages/lock-state.js'
import { emptyLock, type LockEntry, type Lockfile, lockPath, readLock } from '../../src/packages/lockfile.js'
import { hashDirectory, packageDir } from '../../src/packages/sources.js'
import { hashWorkspace } from '../../src/packages/workspace.js'
import { resolveProfile } from '../../src/profile/resolve.js'
import type { LockState, ResolveEnv } from '../../src/profile/types.js'

const env: ResolveEnv = {
  platform: { os: 'darwin', arch: 'arm64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-07T00:00:00Z',
}
type NpmEntry = Extract<LockEntry, { releasedAt: string }>
const npmEntry = (id: string, over: Partial<NpmEntry> = {}): LockEntry => ({
  version: '0.1.0',
  source: { type: 'npm', ref: `npm:${id}@0.1.0` },
  integrity: 'sha512-x',
  trust: 'trusted',
  license: 'MIT',
  state: { installed: '2026-09-07T00:00:00Z', trusted: '2026-09-07T00:00:00Z', enabled: true },
  releasedAt: '2026-09-07T00:00:00Z',
  dependencies: {},
  previous: null,
  ...over,
})

describe('lockState', () => {
  let profileDir: string
  beforeEach(() => {
    profileDir = mkdtempSync(join(tmpdir(), 'agnes-ls-'))
  })
  afterEach(() => rmSync(profileDir, { recursive: true, force: true }))

  it('projects each locked package into LockState, passing provides/capabilities/releasedAt through', () => {
    const lock: Lockfile = emptyLock('local-dev', '0.1.0')
    lock.packages['@agnes/connector-kb'] = npmEntry('@agnes/connector-kb', {
      provides: ['artifacts'],
      capabilities: { tools: { prefix: 'kb_' } },
    })
    lock.packages['@agnes/connector-db'] = npmEntry('@agnes/connector-db')
    const st = lockState(lock, { profileDir })
    expect(st.audit).toEqual([])
    expect(st.lock.workspace).toBeUndefined()
    const kb = st.lock.packages['@agnes/connector-kb']
    expect(kb).toMatchObject({
      version: '0.1.0',
      integrity: 'sha512-x',
      trust: 'trusted',
      enabled: true,
      provides: ['artifacts'],
      capabilities: { tools: { prefix: 'kb_' } },
      releasedAt: '2026-09-07T00:00:00Z',
    })
    const db = st.lock.packages['@agnes/connector-db']
    expect(db).toBeDefined()
    expect(db && 'provides' in db).toBe(false)
    expect(db && 'capabilities' in db).toBe(false)
  })

  // `enabled` is the lock's own verdict, not the manifest's: a package whose trust was revoked
  // (trusted: null) or which the lock disabled projects as disabled regardless of the other field.
  it('a package is enabled only when the lock both enables and trusts it', () => {
    const lock: Lockfile = emptyLock('local-dev', '0.1.0')
    lock.packages.a = npmEntry('a')
    lock.packages.b = npmEntry('b', {
      state: { installed: '2026-09-07T00:00:00Z', trusted: null, enabled: true },
    })
    lock.packages.c = npmEntry('c', {
      state: { installed: '2026-09-07T00:00:00Z', trusted: '2026-09-07T00:00:00Z', enabled: false },
    })
    const st = lockState(lock, { profileDir })
    expect(st.lock.packages.a?.enabled).toBe(true)
    expect(st.lock.packages.b?.enabled).toBe(false)
    expect(st.lock.packages.c?.enabled).toBe(false)
  })

  it('runs the injected integrity check per package and propagates its refusal unchanged', () => {
    const lock: Lockfile = emptyLock('local-dev', '0.1.0')
    lock.packages.a = npmEntry('a')
    lock.packages.b = npmEntry('b')
    const seen: string[] = []
    const refusal = new HostError('E_LOCK_MISMATCH', 'b directory hash changed', { detail: { id: 'b' } })
    expect(() =>
      lockState(lock, {
        profileDir,
        verifyIntegrity: (id) => {
          seen.push(id)
          if (id === 'b') throw refusal
        },
      }),
    ).toThrow(refusal)
    expect(seen.sort()).toEqual(['a', 'b'])
  })

  it('verifies a signed workspace and projects its profile fragment at startup', async () => {
    const deployDir = join(profileDir, 'deploy', 'xinwei')
    mkdirSync(join(deployDir, 'profile'), { recursive: true })
    mkdirSync(join(deployDir, 'preset'), { recursive: true })
    mkdirSync(join(deployDir, 'fixtures', 'in'), { recursive: true })
    writeFileSync(
      join(deployDir, 'manifest.json'),
      JSON.stringify({
        id: 'xinwei',
        version: '1.0.0',
        harnessRange: '^0.1.0',
        extensions: [],
        profileFragment: 'profile/profile.yaml',
        presets: ['preset/enterprise.yaml'],
        fixtures: 'fixtures/in',
      }),
    )
    writeFileSync(join(deployDir, 'profile', 'profile.yaml'), 'policy:\n  capabilityCeiling: [tools]\n')
    writeFileSync(join(deployDir, 'preset', 'enterprise.yaml'), 'name: enterprise\n')
    const lock: Lockfile = emptyLock('local-dev', '0.1.0')
    lock.workspace = {
      path: 'deploy/xinwei',
      hash: hashWorkspace(deployDir),
      manifestId: 'xinwei',
      trustedAt: '2026-09-07T00:00:00Z',
    }
    const state = lockState(lock, { profileDir })
    expect(state.lock.workspace).toEqual({
      path: 'deploy/xinwei',
      hash: lock.workspace.hash,
      manifestId: 'xinwei',
    })
    const overlay = state.workspaceOverlay
    expect(overlay).toEqual({ policy: { capabilityCeiling: ['tools'] } })
    if (overlay === undefined) throw new Error('verified workspace overlay missing')
    expect(state.audit).toEqual([
      { kind: 'workspace.verified', detail: { manifestId: 'xinwei', hash: lock.workspace.hash } },
    ])
    const resolved = await resolveProfile(
      { builtin: 'local-dev', lock: state.lock, workspaceOverlay: overlay },
      env,
    )
    expect(resolved.chain).toContain('workspace:xinwei')
    expect(resolved.policy.capabilityCeiling).toEqual(['tools'])

    writeFileSync(join(deployDir, 'profile', 'profile.yaml'), 'policy: {}\n')
    expect(() => lockState(lock, { profileDir })).toThrow(/E_LOCK_MISMATCH/)
  })
})

describe('default boot integrity', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('accepts a pinned file tree and refuses it after mutation', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-integrity-'))
    roots.push(dataDir)
    const dir = packageDir(dataDir, 'local-dev', 'acme/file')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'acme/file', version: '1.0.0' }))
    const entry: LockEntry = {
      version: '1.0.0',
      source: { type: 'file', ref: 'file:./file' },
      integrity: hashDirectory(dir),
      trust: 'trusted',
      license: 'MIT',
      state: { installed: env.now, trusted: env.now, enabled: true },
      dependencies: {},
      previous: null,
    }
    expect(() => defaultVerifyIntegrity(dataDir, 'local-dev')('acme/file', entry)).not.toThrow()
    writeFileSync(join(dir, 'changed.ts'), 'export {}\n')
    expect(() =>
      verifyLockIntegrity(
        { ...emptyLock('local-dev', '0.1.0'), packages: { 'acme/file': entry } },
        { dataDir, profile: 'local-dev' },
      ),
    ).toThrow(/E_LOCK_MISMATCH/)
  })
})

describe('snapshotPolicy', () => {
  let profileDir: string
  beforeEach(() => {
    profileDir = mkdtempSync(join(tmpdir(), 'agnes-sp-'))
  })
  afterEach(() => rmSync(profileDir, { recursive: true, force: true }))

  const resolvedLock: LockState = {
    packages: {
      '@agnes/base': { version: '0.1.0', integrity: 'sha512-b', trust: 'builtin', enabled: true },
      '@agnes/code': { version: '0.1.0', integrity: 'sha512-c', trust: 'builtin', enabled: true },
      '@agnes/ai': { version: '0.1.0', integrity: 'sha512-a', trust: 'builtin', enabled: true },
    },
  }

  it('writes policy, hash, seams and provider back into a lockfile that reads back', async () => {
    const profile = await resolveProfile({ builtin: 'local-dev', lock: resolvedLock }, env)
    await snapshotPolicy(profileDir, profile, '0.1.0')
    const back = readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.1.0' })
    expect(back.resolvedProfileHash).toBe(profile.hash)
    expect(back.policySnapshot).toEqual({
      capabilityCeiling: [...profile.policy.capabilityCeiling],
      workspacePackages: profile.policy.workspacePackages,
    })
    expect(back.seams).toEqual(profile.seams)
    expect(back.provider).toEqual({
      package: profile.provider.package,
      adapters: [...profile.provider.adapters],
    })
    expect(back.generatedBy).toEqual({ agnesVersion: '0.1.0' })
    expect(existsSync(join(profileDir, '.agnes-lock.lock'))).toBe(false)
    expect(existsSync(`${lockPath(profileDir)}.tmp`)).toBe(false)
  })

  it('preserves package entries already on disk while refreshing the snapshot', async () => {
    const first = await resolveProfile({ builtin: 'local-dev', lock: resolvedLock }, env)
    await snapshotPolicy(profileDir, first, '0.1.0')
    const onDisk = readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.1.0' })
    onDisk.packages['@agnes/base'] = npmEntry('@agnes/base', { trust: 'builtin' })
    const { writeLock } = await import('../../src/packages/lockfile.js')
    writeLock(profileDir, onDisk)

    const second = await resolveProfile({ builtin: 'local-dev', lock: resolvedLock }, env)
    await snapshotPolicy(profileDir, second, '0.1.0')
    const back = readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.1.0' })
    expect(back.packages['@agnes/base']?.integrity).toBe('sha512-x')
    expect(back.resolvedProfileHash).toBe(second.hash)
  })
})
