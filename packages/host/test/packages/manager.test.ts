import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isHostError } from '../../src/errors.js'
import { emptyLock, type Lockfile, readLock, writeLock } from '../../src/packages/lockfile.js'
import { createPackageManager } from '../../src/packages/manager.js'
import { type ExecFn, packageDir } from '../../src/packages/sources.js'
import { verifyWorkspace } from '../../src/packages/workspace.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const HASH = `sha256-${'0'.repeat(64)}`
const SEAMS = {
  approval: '@agnes/base',
  checkpoint: '@agnes/base',
  ledger: '@agnes/base',
  sandbox: '@agnes/base',
  verifier: '@agnes/base',
  repair: '@agnes/base',
  artifacts: '@agnes/base',
  principals: '@agnes/base',
  platform: '@agnes/base',
  harness: '@agnes/base',
}

function writableLock(profile: string, ceiling = ['tools']): Lockfile {
  return {
    ...emptyLock(profile, '0.1.0'),
    resolvedProfileHash: HASH,
    seams: { ...SEAMS },
    policySnapshot: {
      capabilityCeiling: ceiling,
      workspacePackages: 'require-project-trust',
    },
  }
}

function errorFrom(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => {
      throw new Error('expected refusal')
    },
    (error: unknown) => error,
  )
}

describe('PackageManager lifecycle', () => {
  let dataDir: string
  let profileDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agnes-manager-'))
    profileDir = join(dataDir, 'profiles', 'local-dev')
    mkdirSync(profileDir, { recursive: true })
    writeLock(profileDir, writableLock('local-dev'))
  })

  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  it('installs, verifies, trusts and enables a pinned package through the three states', async () => {
    const manager = createPackageManager({
      dataDir,
      agnesVersion: '0.1.0',
      cwd: fixtures,
      now: () => '2026-09-07T00:00:00Z',
    })
    const installed = await manager.add(profileDir, 'file:./pkg-a')
    expect(installed).toMatchObject({
      version: '1.0.0',
      trust: 'trusted',
      state: { trusted: null, enabled: false },
    })
    expect(await manager.status(profileDir)).toMatchObject([{ id: 'acme/pkg-a', state: 'installed' }])
    await expect(manager.enable(profileDir, 'acme/pkg-a', true)).rejects.toThrow(/not passed package trust/)
    await manager.trust(profileDir, 'acme/pkg-a')
    await manager.enable(profileDir, 'acme/pkg-a', true)
    expect(await manager.status(profileDir)).toMatchObject([{ id: 'acme/pkg-a', state: 'enabled' }])
  })

  it('detects installed-tree tampering before the softer trust gates', async () => {
    const manager = createPackageManager({
      dataDir,
      agnesVersion: '0.1.0',
      cwd: fixtures,
      ceiling: [],
    })
    await manager.add(profileDir, 'file:./pkg-a')
    writeFileSync(join(packageDir(dataDir, 'local-dev', 'acme/pkg-a'), 'tampered'), 'changed')
    const error = await errorFrom(() => manager.trust(profileDir, 'acme/pkg-a'))
    expect(isHostError(error, 'E_LOCK_MISMATCH')).toBe(true)
    expect((error as { detail?: unknown }).detail).toMatchObject({ reason: 'integrity' })
  })

  it('admits a verified install only within the capability ceiling and refuses raw workspace add', async () => {
    const denied = createPackageManager({
      dataDir,
      agnesVersion: '0.1.0',
      cwd: fixtures,
      ceiling: [],
    })
    await expect(denied.add(profileDir, 'file:./pkg-a', { trust: 'verify' })).rejects.toThrow(
      /E_CEILING_EXCEEDED/,
    )
    expect(existsSync(packageDir(dataDir, 'local-dev', 'acme/pkg-a'))).toBe(false)
    await expect(denied.add(profileDir, 'workspace:extensions/pkg-a')).rejects.toThrow(
      /E_WORKSPACE_UNTRUSTED/,
    )
  })

  it('requires an already-resolved lock before mutating packages', async () => {
    const fresh = join(dataDir, 'profiles', 'fresh')
    mkdirSync(fresh)
    const manager = createPackageManager({ dataDir, agnesVersion: '0.1.0', cwd: fixtures })
    await expect(manager.add(fresh, 'file:./pkg-a')).rejects.toThrow(/E_LOCK_MISMATCH/)
    expect(existsSync(packageDir(dataDir, 'fresh', 'acme/pkg-a'))).toBe(false)
  })

  it('refuses reverse dependencies and residue, then removes the lock entry and package tree', async () => {
    const residueCheck = vi.fn(async () => ['hook:tool_result'])
    const manager = createPackageManager({
      dataDir,
      agnesVersion: '0.1.0',
      cwd: fixtures,
      residueCheck,
    })
    await manager.add(profileDir, 'file:./pkg-a')
    const lock = readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.1.0' })
    const pkgA = lock.packages['acme/pkg-a']
    if (!pkgA) throw new Error('fixture package was not installed')
    lock.packages.other = {
      ...pkgA,
      version: '2.0.0',
      source: { type: 'file', ref: 'file:./pkg-a' },
      integrity: HASH,
      dependencies: { 'acme/pkg-a': '^1.0.0' },
    }
    writeLock(profileDir, lock)
    const dependent = await errorFrom(() => manager.remove(profileDir, 'acme/pkg-a'))
    expect(isHostError(dependent, 'E_DEP_MISSING')).toBe(true)
    expect((dependent as { detail?: unknown }).detail).toMatchObject({
      reason: 'dependents',
      dependents: ['other'],
    })
    delete lock.packages.other
    writeLock(profileDir, lock)
    const residue = await errorFrom(() => manager.remove(profileDir, 'acme/pkg-a'))
    expect(isHostError(residue, 'E_EXT_LOAD')).toBe(true)
    expect(existsSync(packageDir(dataDir, 'local-dev', 'acme/pkg-a'))).toBe(true)
    residueCheck.mockResolvedValue([])
    await manager.remove(profileDir, 'acme/pkg-a')
    expect(existsSync(packageDir(dataDir, 'local-dev', 'acme/pkg-a'))).toBe(false)
    expect(
      readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages['acme/pkg-a'],
    ).toBeUndefined()
  })

  it('refetches npm sources for trust and rollback, preserving exactly one previous version', async () => {
    let extractedVersion = '1.0.0'
    let packCalls = 0
    const exec: ExecFn = async (_command, args) => {
      const spec = args[1] ?? ''
      const version = spec.slice(spec.lastIndexOf('@') + 1)
      if (args[0] === 'pack') {
        packCalls++
        extractedVersion = version
        const packDir = args[args.indexOf('--pack-destination') + 1]
        if (!packDir) throw new Error('missing pack destination')
        const bytes = Buffer.from(`archive:${version}`)
        writeFileSync(join(packDir, 'pkg.tgz'), bytes)
        return {
          stdout: JSON.stringify([
            {
              filename: 'pkg.tgz',
              integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
              version,
            },
          ]),
        }
      }
      return { stdout: JSON.stringify({ [version]: '2026-01-01T00:00:00Z' }) }
    }
    const extract = async (_tarball: string, into: string): Promise<void> => {
      mkdirSync(into, { recursive: true })
      writeFileSync(
        join(into, 'package.json'),
        JSON.stringify({ name: 'x', version: extractedVersion, license: 'MIT', dependencies: {} }),
      )
      writeFileSync(join(into, 'index.js'), `export const version = '${extractedVersion}'\n`)
    }
    const manager = createPackageManager({
      dataDir,
      agnesVersion: '0.1.0',
      cwd: profileDir,
      exec,
      extract,
      now: () => '2026-09-07T00:00:00Z',
    })
    await manager.add(profileDir, 'npm:x@1.0.0')
    await manager.trust(profileDir, 'x')
    expect(packCalls).toBe(2)
    await manager.add(profileDir, 'npm:x@1.0.1')
    const upgraded = readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages.x
    expect(upgraded?.previous).toMatchObject({ version: '1.0.0' })
    const rolled = await manager.rollback(profileDir, 'x')
    expect(rolled).toMatchObject({
      version: '1.0.0',
      state: { trusted: null },
      previous: { version: '1.0.1' },
    })
    expect(readFileSync(join(packageDir(dataDir, 'local-dev', 'x'), 'index.js'), 'utf8')).toContain('1.0.0')
  })
})

describe('PackageManager project trust', () => {
  let dataDir: string
  let profileDir: string
  let deployDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agnes-project-trust-'))
    profileDir = join(dataDir, 'profiles', 'enterprise')
    deployDir = join(profileDir, 'deploy', 'xinwei')
    for (const dir of [
      profileDir,
      join(deployDir, 'extensions', 'sales-analysis'),
      join(deployDir, 'profile'),
      join(deployDir, 'preset'),
      join(deployDir, 'fixtures', 'in'),
    ])
      mkdirSync(dir, { recursive: true })
    writeLock(profileDir, writableLock('enterprise'))
    writeFileSync(
      join(deployDir, 'manifest.json'),
      JSON.stringify({
        id: 'xinwei',
        version: '1.0.0',
        harnessRange: '^0.1.0',
        extensions: [{ path: 'extensions/sales-analysis', id: 'xinwei/sales-analysis' }],
        profileFragment: 'profile/profile.yaml',
        presets: ['preset/enterprise.yaml'],
        fixtures: 'fixtures/in',
      }),
    )
    writeFileSync(join(deployDir, 'profile', 'profile.yaml'), 'policy:\n  capabilityCeiling: [tools]\n')
    writeFileSync(join(deployDir, 'preset', 'enterprise.yaml'), 'name: enterprise\n')
    const extensionDir = join(deployDir, 'extensions', 'sales-analysis')
    writeFileSync(
      join(extensionDir, 'package.json'),
      JSON.stringify({
        name: 'xinwei/sales-analysis',
        version: '1.0.0',
        license: 'Apache-2.0',
        dependencies: {},
      }),
    )
    writeFileSync(
      join(extensionDir, 'agnes.extension.json'),
      JSON.stringify({
        id: 'xinwei/sales-analysis',
        version: '1.0.0',
        apiRange: '^1.0',
        entry: './index.ts',
        capabilities: { tools: { prefix: 'xw_', names: ['xw_analyze'] } },
      }),
    )
    writeFileSync(join(extensionDir, 'index.ts'), 'export default () => () => {}\n')
  })

  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  it('pins the current protocol manifest and installs its workspace extensions trusted+enabled', async () => {
    const manager = createPackageManager({
      dataDir,
      agnesVersion: '0.1.0',
      now: () => '2026-09-07T00:00:00Z',
    })
    const result = await manager.trustWorkspace(profileDir, deployDir)
    const lock = readLock(profileDir, { profile: 'enterprise', agnesVersion: '0.1.0' })
    expect(lock.workspace).toEqual({
      path: 'deploy/xinwei',
      hash: result.hash,
      manifestId: 'xinwei',
      trustedAt: '2026-09-07T00:00:00Z',
    })
    expect(lock.packages['xinwei/sales-analysis']).toMatchObject({
      source: { type: 'workspace', ref: 'workspace:extensions/sales-analysis' },
      trust: 'trusted',
      state: { trusted: '2026-09-07T00:00:00Z', enabled: true },
    })
    expect(verifyWorkspace(lock, profileDir)).toEqual({ ok: true, deployDir })
  })

  it('refuses identity drift, policy denial, and deploy directories outside the profile root', async () => {
    const manager = createPackageManager({ dataDir, agnesVersion: '0.1.0' })
    writeFileSync(
      join(deployDir, 'extensions', 'sales-analysis', 'package.json'),
      JSON.stringify({ name: 'xinwei/other', version: '1.0.0', license: 'MIT' }),
    )
    await expect(manager.trustWorkspace(profileDir, deployDir)).rejects.toThrow(/E_EXT_LOAD/)

    const lock = readLock(profileDir, { profile: 'enterprise', agnesVersion: '0.1.0' })
    lock.policySnapshot.workspacePackages = 'deny'
    writeLock(profileDir, lock)
    await expect(manager.trustWorkspace(profileDir, deployDir)).rejects.toThrow(/E_WORKSPACE_UNTRUSTED/)

    const outside = join(dataDir, 'outside')
    mkdirSync(outside)
    await expect(manager.trustWorkspace(profileDir, outside)).rejects.toThrow(/E_WORKSPACE_UNTRUSTED/)
  })
})
