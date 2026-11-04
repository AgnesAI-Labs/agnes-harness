import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundledPackageJson } from '@agnes/extension-api'
import { RuntimeAdminSnapshot, validateAgainst } from '@agnes/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isPackageError } from '../src/errors.js'
import { emptyLock, type Lockfile, readLock, writeLock } from '../src/lockfile.js'
import { createPackageManager } from '../src/manager.js'
import { type ExecFn, packageDir, parseSource } from '../src/sources.js'
import { hashWorkspace, verifyWorkspace } from '../src/workspace.js'
import { listWorkspaceDeployments } from '../src/workspace-deployments.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const HASH = `sha256-${'0'.repeat(64)}`
const SEAMS = {
  approval: { provider: 'local-prompt' },
  checkpoint: { provider: 'fs' },
  billing: { provider: 'budget' },
  verifier: { provider: 't0' },
  repair: { provider: 'default' },
  artifacts: { provider: 'local' },
  principals: { provider: 'local' },
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
    expect(isPackageError(error, 'E_LOCK_MISMATCH')).toBe(true)
    expect((error as { detail?: unknown }).detail).toMatchObject({ reason: 'integrity' })
  })

  it('admits a Cordis plugin row without a capability ceiling and refuses raw workspace add', async () => {
    const denied = createPackageManager({
      dataDir,
      agnesVersion: '0.1.0',
      cwd: fixtures,
      ceiling: [],
    })
    await denied.add(profileDir, 'file:./pkg-a', { trust: 'verify' })
    expect(existsSync(packageDir(dataDir, 'local-dev', 'acme/pkg-a'))).toBe(true)
    await expect(denied.add(profileDir, 'workspace:extensions/pkg-a')).rejects.toThrow(/E_PACKAGE_TRUST/)
  })

  it('requires an already-resolved lock before mutating packages', async () => {
    const fresh = join(dataDir, 'profiles', 'fresh')
    mkdirSync(fresh)
    const manager = createPackageManager({ dataDir, agnesVersion: '0.1.0', cwd: fixtures })
    await expect(manager.add(fresh, 'file:./pkg-a')).rejects.toThrow(/E_PACKAGE_INTEGRITY/)
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
    expect(isPackageError(dependent, 'E_DEP_MISSING')).toBe(true)
    expect((dependent as { detail?: unknown }).detail).toMatchObject({
      reason: 'dependents',
      dependents: ['other'],
    })
    delete lock.packages.other
    writeLock(profileDir, lock)
    const residue = await errorFrom(() => manager.remove(profileDir, 'acme/pkg-a'))
    expect(isPackageError(residue, 'E_EXT_LOAD')).toBe(true)
    expect(residue).toMatchObject({
      code: 'E_PACKAGE_STATE',
      detail: { reason: 'residue', residue: ['hook:tool_result'] },
    })
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
      npmProvenance: async () => undefined,
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
      state: { trusted: null, enabled: false },
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
      JSON.stringify(
        bundledPackageJson(
          {
            id: 'xinwei/sales-analysis',
            version: '1.0.0',
            apiRange: '^5.0.0',
            entry: './index.ts',
            capabilities: { tools: { prefix: 'xw_', names: ['xw_analyze'] } },
          },
          { name: 'xinwei/sales-analysis', license: 'Apache-2.0', dependencies: {} },
        ),
      ),
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

  it('offers the deploy directories trust accepts, with what the lock already vouches for', async () => {
    const manager = createPackageManager({
      dataDir,
      agnesVersion: '0.1.0',
      now: () => '2026-09-07T00:00:00Z',
    })
    // Read with the lock and version the manager itself trusts with.
    const offered = (_manager: unknown) =>
      listWorkspaceDeployments(profileDir, () =>
        readLock(profileDir, { profile: 'enterprise', agnesVersion: '0.1.0' }),
      )
    const offer = { deployDir: realpathSync.native(deployDir), path: 'deploy/xinwei', manifestId: 'xinwei' }
    const shown = offered(manager)[0]?.trustHash
    expect(offered(manager)).toEqual([
      { ...offer, trustHash: expect.stringMatching(/^sha256-[a-f0-9]{64}$/), state: 'untrusted' },
    ])
    expect(
      validateAgainst(RuntimeAdminSnapshot, {
        providers: [],
        presets: [],
        localPluginFolders: { home: 'plugins', workspace: 'workspace-plugins' },
        workspaceDeployments: offered(manager),
      }).ok,
    ).toBe(true)
    // What is offered is what trust takes, bound to the hash the offer showed.
    await manager.trustWorkspace(profileDir, offer.deployDir, shown)
    expect(offered(manager)).toEqual([{ ...offer, trustHash: shown, state: 'trusted' }])
    writeFileSync(join(deployDir, 'notes.txt'), 'edited after trust')
    const edited = offered(manager)[0]?.trustHash
    expect(edited).not.toBe(shown)
    expect(offered(manager)).toEqual([{ ...offer, trustHash: edited, state: 'changed' }])
    // Re-trust is the remedy for `changed`; it must leave every inventory read working.
    await manager.trustWorkspace(profileDir, offer.deployDir, edited)
    expect(offered(manager)).toEqual([{ ...offer, trustHash: edited, state: 'trusted' }])
    const retrusted = readLock(profileDir, { profile: 'enterprise', agnesVersion: '0.1.0' })
    expect(retrusted.packages['xinwei/sales-analysis']?.previous).toBeNull()
    const row = async () => (await manager.inventory(profileDir, { fresh: true })).packages[0]
    await expect(row()).resolves.toMatchObject({
      id: 'xinwei/sales-analysis',
      blockers: [{ code: 'unknown-contribution', references: ['static-inventory-migration-required'] }],
      verifiedRollbackTarget: null,
    })
    // A version/integrity-only previous left by an earlier re-trust stays a row fact, not a profile failure.
    const legacy = retrusted.packages['xinwei/sales-analysis']
    if (!legacy) throw new Error('missing workspace entry')
    legacy.previous = { version: legacy.version, integrity: legacy.integrity }
    writeLock(profileDir, retrusted)
    await expect(row()).resolves.toMatchObject({ verifiedRollbackTarget: null })

    // A directory without a valid manifest, a hidden one and a symlink are never offered.
    mkdirSync(join(profileDir, 'deploy', 'empty'))
    mkdirSync(join(profileDir, 'deploy', 'broken'))
    writeFileSync(join(profileDir, 'deploy', 'broken', 'manifest.json'), '{ "id": "broken" }')
    cpSync(deployDir, join(profileDir, '.hidden'), { recursive: true })
    const directoryLink = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(deployDir, join(profileDir, 'deploy', 'linked'), directoryLink)
    expect(offered(manager).map((entry) => entry.path)).toEqual(['deploy/xinwei'])
    // A policy that refuses workspace packages offers none.
    const lock = readLock(profileDir, { profile: 'enterprise', agnesVersion: '0.1.0' })
    writeLock(profileDir, { ...lock, policySnapshot: { ...lock.policySnapshot, workspacePackages: 'deny' } })
    expect(offered(manager)).toEqual([])
  })

  it('checks harnessRange against the harness contract version, whatever label the process carries', async () => {
    // The daemon and its workers label their managers with the unpublished placeholder.
    const manager = createPackageManager({
      dataDir,
      agnesVersion: '0.0.0',
      now: () => '2026-09-07T00:00:00Z',
    })
    const offered = () =>
      listWorkspaceDeployments(profileDir, () =>
        readLock(profileDir, { profile: 'enterprise', agnesVersion: '0.0.0' }),
      )
    expect(offered().map((entry) => entry.state)).toEqual(['untrusted'])
    await expect(manager.trustWorkspace(profileDir, deployDir)).resolves.toMatchObject({
      hash: expect.stringMatching(/^sha256-/),
    })
    expect(offered().map((entry) => entry.state)).toEqual(['trusted'])

    // A workspace written for a harness this is not is refused by trust and never offered.
    const manifestFile = join(deployDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, harnessRange: '^99.0.0' }))
    const refused = await manager.trustWorkspace(profileDir, deployDir).catch((error: unknown) => error)
    expect(isPackageError(refused, 'E_API_RANGE')).toBe(true)
    expect(offered()).toEqual([])
  })

  it('refuses id collisions, stale reviewed hashes, identity drift, policy denial, and outside directories', async () => {
    const manager = createPackageManager({
      dataDir,
      agnesVersion: '0.1.0',
      cwd: profileDir,
      references: async () => [],
    })
    const lockBytes = () => readFileSync(join(profileDir, 'agnes-lock.json'), 'utf8')
    // An id already installed from another source is never silently replaced by project trust.
    const fileSource = parseSource('file:./deploy/xinwei/extensions/sales-analysis')
    const preview = await manager.inspect(profileDir, fileSource)
    await manager.install(profileDir, fileSource, { expectedIntegrity: preview.integrity })
    const installed = lockBytes()
    await expect(manager.trustWorkspace(profileDir, deployDir)).rejects.toThrow(/E_PACKAGE_STATE/)
    expect(lockBytes()).toBe(installed)
    expect(existsSync(packageDir(dataDir, 'enterprise', 'xinwei/sales-analysis'))).toBe(true)
    await manager.remove(profileDir, 'xinwei/sales-analysis')

    // Confirmation binds to the hash that was reviewed; a stale one changes nothing.
    const reviewed = lockBytes()
    await expect(
      manager.trustWorkspace(profileDir, deployDir, `sha256-${'1'.repeat(64)}`),
    ).rejects.toMatchObject({ code: 'E_PACKAGE_PREVIEW_STALE' })
    expect(lockBytes()).toBe(reviewed)
    await expect(manager.trustWorkspace(profileDir, deployDir, hashWorkspace(deployDir))).resolves.toEqual({
      hash: hashWorkspace(deployDir),
    })

    writeFileSync(
      join(deployDir, 'extensions', 'sales-analysis', 'package.json'),
      JSON.stringify({ name: 'xinwei/other', version: '1.0.0', license: 'MIT' }),
    )
    await expect(manager.trustWorkspace(profileDir, deployDir)).rejects.toThrow(/E_PACKAGE_STATE/)

    const lock = readLock(profileDir, { profile: 'enterprise', agnesVersion: '0.1.0' })
    lock.policySnapshot.workspacePackages = 'deny'
    writeLock(profileDir, lock)
    await expect(manager.trustWorkspace(profileDir, deployDir)).rejects.toThrow(/E_PACKAGE_TRUST/)

    const outside = join(dataDir, 'outside')
    mkdirSync(outside)
    await expect(manager.trustWorkspace(profileDir, outside)).rejects.toThrow(/E_PACKAGE_TRUST/)
  })
})
