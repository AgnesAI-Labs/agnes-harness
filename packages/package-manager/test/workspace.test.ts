import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyLock } from '../src/lockfile.js'
import { hashWorkspace, readDeployManifest, readProfileFragment, verifyWorkspace } from '../src/workspace.js'

const HASH_PATTERN = /^sha256-[a-f0-9]{64}$/

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'xinwei',
    version: '1.0.0',
    harnessRange: '^0.1.0',
    extensions: [{ path: 'extensions/sales-analysis', id: 'xinwei/sales-analysis' }],
    profileFragment: 'profile/profile.yaml',
    presets: ['preset/enterprise.yaml'],
    fixtures: 'fixtures/in',
    ...over,
  }
}

describe('workspace trust primitives', () => {
  let profileDir: string
  let deployDir: string

  beforeEach(() => {
    profileDir = mkdtempSync(join(tmpdir(), 'agnes-workspace-'))
    deployDir = join(profileDir, 'deploy', 'xinwei')
    mkdirSync(join(deployDir, 'extensions', 'sales-analysis'), { recursive: true })
    mkdirSync(join(deployDir, 'profile'), { recursive: true })
    mkdirSync(join(deployDir, 'preset'), { recursive: true })
    mkdirSync(join(deployDir, 'fixtures', 'in'), { recursive: true })
    writeFileSync(join(deployDir, 'manifest.json'), JSON.stringify(manifest()))
    writeFileSync(join(deployDir, 'profile', 'profile.yaml'), 'policy:\n  capabilityCeiling: [tools]\n')
    writeFileSync(join(deployDir, 'preset', 'enterprise.yaml'), 'name: enterprise\n')
    writeFileSync(join(deployDir, 'extensions', 'sales-analysis', 'index.ts'), 'export default () => {}\n')
  })

  afterEach(() => rmSync(profileDir, { recursive: true, force: true }))

  it('reads the current protocol shape and validates its selected profile fragment', () => {
    const read = readDeployManifest(deployDir)
    expect(read).toMatchObject({
      id: 'xinwei',
      profileFragment: 'profile/profile.yaml',
      presets: ['preset/enterprise.yaml'],
    })
    expect(readProfileFragment(deployDir, read)).toEqual({
      policy: { capabilityCeiling: ['tools'] },
    })
  })

  it('refuses the planned partner package id because the current profile schema cannot represent it', () => {
    writeFileSync(
      join(deployDir, 'profile', 'profile.yaml'),
      'packages:\n  - id: xinwei/sales-analysis\n    source: workspace:extensions/sales-analysis\n',
    )
    expect(() => readProfileFragment(deployDir, readDeployManifest(deployDir))).toThrow(/E_PACKAGE_STATE/)
  })

  it('rejects the obsolete plan shape and prefix-smuggled traversal paths', () => {
    writeFileSync(
      join(deployDir, 'manifest.json'),
      JSON.stringify(manifest({ profileFragment: './profile', presets: './preset' })),
    )
    expect(() => readDeployManifest(deployDir)).toThrow(/E_PACKAGE_STATE/)

    writeFileSync(
      join(deployDir, 'manifest.json'),
      JSON.stringify(
        manifest({
          extensions: [{ path: 'extensions/../outside', id: 'xinwei/sales-analysis' }],
        }),
      ),
    )
    expect(() => readDeployManifest(deployDir)).toThrow(/unsafe relative path/)
  })

  it('rejects a profile fragment that escapes through a parent symlink', () => {
    const outside = join(profileDir, 'outside-profile')
    mkdirSync(outside)
    writeFileSync(join(outside, 'profile.yaml'), 'policy: {}\n')
    rmSync(join(deployDir, 'profile'), { recursive: true })
    symlinkSync(outside, join(deployDir, 'profile'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => readProfileFragment(deployDir, readDeployManifest(deployDir))).toThrow(/symbolic link/)
  })

  it('rejects duplicate extension identities or directories before a manager can install them', () => {
    writeFileSync(
      join(deployDir, 'manifest.json'),
      JSON.stringify(
        manifest({
          extensions: [
            { path: 'extensions/a', id: 'xinwei/a' },
            { path: 'extensions/b', id: 'xinwei/a' },
          ],
        }),
      ),
    )
    expect(() => readDeployManifest(deployDir)).toThrow(/duplicate extension/)
  })

  it('hashes deterministically, ignores only fixed generated trees, and rejects symlinks', () => {
    const first = hashWorkspace(deployDir)
    expect(first).toMatch(HASH_PATTERN)
    expect(hashWorkspace(deployDir)).toBe(first)
    mkdirSync(join(deployDir, 'node_modules', 'ignored'), { recursive: true })
    mkdirSync(join(deployDir, 'fixtures', 'out'), { recursive: true })
    writeFileSync(join(deployDir, 'node_modules', 'ignored', 'x'), 'ignored')
    writeFileSync(join(deployDir, 'fixtures', 'out', 'x'), 'ignored')
    expect(hashWorkspace(deployDir)).toBe(first)
    writeFileSync(join(deployDir, 'extensions', 'sales-analysis', 'index.ts'), 'changed\n')
    expect(hashWorkspace(deployDir)).not.toBe(first)

    symlinkSync(join(deployDir, 'manifest.json'), join(deployDir, 'escape'))
    expect(() => hashWorkspace(deployDir)).toThrow(/symbolic link/)
  })

  it('verifies the pinned tree and fails closed after content or manifest identity changes', () => {
    const lock = emptyLock('enterprise', '0.1.0')
    expect(verifyWorkspace(lock, profileDir)).toMatchObject({
      ok: false,
      code: 'E_WORKSPACE_UNTRUSTED',
    })
    lock.workspace = {
      path: 'deploy/xinwei',
      hash: hashWorkspace(deployDir),
      manifestId: 'xinwei',
      trustedAt: '2026-09-07T00:00:00Z',
    }
    expect(verifyWorkspace(lock, profileDir)).toEqual({ ok: true, deployDir })

    writeFileSync(join(deployDir, 'extensions', 'sales-analysis', 'index.ts'), 'tampered\n')
    expect(verifyWorkspace(lock, profileDir)).toMatchObject({
      ok: false,
      code: 'E_LOCK_MISMATCH',
      detail: { reason: 'workspace-hash-changed' },
    })

    lock.workspace.hash = hashWorkspace(deployDir)
    writeFileSync(join(deployDir, 'manifest.json'), JSON.stringify(manifest({ id: 'other' })))
    lock.workspace.hash = hashWorkspace(deployDir)
    expect(verifyWorkspace(lock, profileDir)).toMatchObject({
      ok: false,
      code: 'E_LOCK_MISMATCH',
      detail: { reason: 'workspace-manifest-changed' },
    })
  })

  it('refuses an unvalidated path escape even when handed an in-memory lock', () => {
    const lock = emptyLock('enterprise', '0.1.0')
    lock.workspace = {
      path: '../outside',
      hash: `sha256-${'0'.repeat(64)}`,
      manifestId: 'xinwei',
      trustedAt: '2026-09-07T00:00:00Z',
    }
    expect(verifyWorkspace(lock, profileDir)).toMatchObject({
      ok: false,
      code: 'E_LOCK_MISMATCH',
      detail: { reason: 'invalid-workspace-path' },
    })
  })
})
