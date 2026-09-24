import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as owner from '@agnes/package-manager'
import { afterEach, expect, it, vi } from 'vitest'
import { HostError } from '../../src/errors.js'
import { manifestCapabilities } from '../../src/packages/capabilities.js'
import * as legacyLock from '../../src/packages/lockfile.js'
import { createPackageManager } from '../../src/packages/manager.js'
import { resolveProfile } from '../../src/profile/resolve.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

it('new owner and unchanged Host API produce identical lock bytes and installed trees', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-12T00:00:00Z'))
  const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
  const lockBytes: string[] = []
  const trees: string[][] = []
  for (const make of [owner.createPackageManager, createPackageManager]) {
    const temp = mkdtempSync(join(tmpdir(), 'agnes-pm-oracle-'))
    dirs.push(temp)
    const dir = join(temp, 'local-dev')
    mkdirSync(dir)
    const profile = await resolveProfile(
      { builtin: 'local-dev' },
      {
        agnesVersion: '0.1.0',
        now: '2026-09-12T00:00:00Z',
        platform: { os: 'darwin', arch: 'arm64', capabilities: {} },
      },
    )
    await owner.snapshotPolicy(dir, profile, '0.1.0')
    const manager = make({ dataDir: dir, agnesVersion: '0.1.0', cwd: fixture })
    await manager.add(dir, 'file:./pkg-a')
    const lock = owner.readLock(dir, { profile: dir.split('/').at(-1) as string, agnesVersion: '0.1.0' })
    expect(lock.packages['acme/pkg-a']?.state.enabled).toBe(false)
    expect(lock.resolvedProfileHash).toBe(profile.hash)
    // The builtin profile evolves independently of the package-manager byte-format contract.
    // Validate its current hash above, then normalize identity for the historical byte oracle.
    lockBytes.push(
      readFileSync(owner.lockPath(dir), 'utf8')
        .replaceAll(lock.profile, '<profile>')
        .replace(profile.hash, '<resolved-profile-hash>'),
    )
    const installed = owner.packageDir(dir, lock.profile, 'acme/pkg-a')
    trees.push(
      (readdirSync(installed, { recursive: true }) as string[]).sort().map((path) => {
        try {
          return `${path}:${readFileSync(join(installed, path)).toString('base64')}`
        } catch {
          return `${path}/`
        }
      }),
    )
  }
  const golden = JSON.parse(readFileSync(join(fixture, 'package-manager/pm1-8c51bc9.json'), 'utf8'))
  const historicalHash = JSON.parse(golden.lock).resolvedProfileHash as string
  golden.lock = golden.lock.replace(historicalHash, '<resolved-profile-hash>')
  expect({ lock: lockBytes[0], tree: trees[0] }).toEqual(golden)
  expect(lockBytes[0]).toBe(lockBytes[1])
  expect(trees[0]).toEqual(trees[1])
})

it('maps domain errors back to legacy Host code, message, source and detail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-pm-error-'))
  dirs.push(dir)
  const draft = owner.emptyLock('test', '0.1.0')
  let domain: unknown
  let legacy: unknown
  try {
    owner.writeLock(dir, draft)
  } catch (error) {
    domain = error
  }
  try {
    legacyLock.writeLock(dir, draft)
  } catch (error) {
    legacy = error
  }
  expect(domain).toBeInstanceOf(owner.PackageError)
  expect(legacy).toBeInstanceOf(HostError)
  expect(domain).toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  expect(legacy).toMatchObject({
    code: 'E_LOCK_MISMATCH',
    source: (domain as owner.PackageError).source,
    detail: (domain as owner.PackageError).detail,
  })
  expect((legacy as Error).message).toBe(`E_LOCK_MISMATCH: ${(domain as owner.PackageError).reason}`)
})

it('preserves absent legacy error detail', () => {
  let error: unknown
  try {
    manifestCapabilities({} as never)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(HostError)
  expect((error as HostError).code).toBe('E_EXT_LOAD')
  expect((error as HostError).detail).toBeUndefined()
})
