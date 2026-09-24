import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { packageDirs } from '../../src/assemble/packages.js'
import { emptyLock, type Lockfile } from '../../src/packages/lockfile.js'
import { packageDir } from '../../src/packages/sources.js'
import type { ResolvedPackage, ResolvedProfile } from '../../src/profile/types.js'

// A ResolvedProfile with only the fields packageDirs reads, narrowed from the real type the way
// routes.test.ts does, so a field the function starts reading cannot go unnoticed.
type DirsProfile = Pick<ResolvedProfile, 'name' | 'packages'>
const profile = (packages: ResolvedPackage[]): ResolvedProfile => {
  const p: DirsProfile = { name: 'local-dev', packages }
  return p as ResolvedProfile
}
const pkg = (id: string, over: Partial<ResolvedPackage> = {}): ResolvedPackage => ({
  id,
  version: '0.1.0',
  source: 'builtin',
  integrity: 'builtin:0.1.0',
  trust: 'builtin',
  enabled: true,
  ...over,
})

const dirs: string[] = []
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-pkgdirs-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// This package's own root: @agnes/host depends on every builtin package, so createRequire from its
// package.json resolves them exactly the way cli's hostRootFrom() root does in production.
const HOST_PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = join(HOST_PKG_ROOT, '..', '..')

const workspaceEntry = (ref: string): Lockfile['packages'][string] => ({
  version: '0.1.0',
  source: { type: 'workspace', ref },
  integrity: `sha256-${'1'.repeat(64)}`,
  trust: 'trusted',
  license: 'MIT',
  state: { installed: '2026-09-11T00:00:00Z', trusted: '2026-09-11T00:00:00Z', enabled: true },
  dependencies: {},
  previous: null,
})

describe('packageDirs', () => {
  it('locates a real builtin package by walking up from its resolved entry', () => {
    const dataDir = dir()
    const out = packageDirs(profile([pkg('@agnes/base')]), {
      dataDir,
      profileDir: dir(),
      lock: emptyLock('local-dev', '0.0.0'),
      hostRoot: HOST_PKG_ROOT,
    })
    // realpath: Node resolves the pnpm symlink to the package's real directory.
    expect(realpathSync(out.get('@agnes/base') as string)).toBe(
      realpathSync(join(REPO_ROOT, 'packages', 'base')),
    )
  })

  // The plan sketch located builtins with `require.resolve(`${id}/package.json`)`, but no workspace
  // package here exports that subpath, so the resolve always threw and every builtin silently fell
  // into the data-dir fallback -- a wrong directory, not a refusal. This fixture's exports map has
  // no './package.json' entry, so the sketch's resolve throws; its `main` is a decoy pointing at a
  // file that does not exist; and a package.json with the wrong name sits between the entry and the
  // package root. Only walking up from the resolved entry to the package.json whose `name` is the
  // id lands on the right directory.
  it('is not fooled by a decoy main, a closed exports map, or a mis-named nested package.json', () => {
    const hostRoot = dir()
    writeFileSync(join(hostRoot, 'package.json'), JSON.stringify({ name: 'host-fixture' }))
    const pkgRoot = join(hostRoot, 'node_modules', 'acme-pkg')
    mkdirSync(join(pkgRoot, 'src'), { recursive: true })
    writeFileSync(
      join(pkgRoot, 'package.json'),
      JSON.stringify({ name: 'acme-pkg', main: './decoy-main.js', exports: { '.': './src/entry.js' } }),
    )
    writeFileSync(join(pkgRoot, 'src', 'package.json'), JSON.stringify({ name: 'acme-decoy' }))
    writeFileSync(join(pkgRoot, 'src', 'entry.js'), 'export {}')
    const out = packageDirs(profile([pkg('acme-pkg')]), {
      dataDir: dir(),
      profileDir: dir(),
      lock: emptyLock('local-dev', '0.0.0'),
      hostRoot,
    })
    expect(realpathSync(out.get('acme-pkg') as string)).toBe(realpathSync(pkgRoot))
    expect(out.get('acme-pkg')).not.toBe(packageDir(dir(), 'local-dev', 'acme-pkg'))
  })

  it('refuses a builtin that cannot be resolved instead of falling back to the data dir', () => {
    expect(() =>
      packageDirs(profile([pkg('acme-missing-pkg')]), {
        dataDir: dir(),
        profileDir: dir(),
        lock: emptyLock('local-dev', '0.0.0'),
        hostRoot: dir(),
      }),
    ).toThrowError(/E_DEP_MISSING/)
  })

  it('still resolves a builtin to the shipped copy when its lock entry is npm', () => {
    const lock: Lockfile = {
      ...emptyLock('local-dev', '0.0.0'),
      packages: {
        '@agnes/code': {
          version: '0.1.0',
          source: { type: 'npm', ref: 'npm:@agnes/code@0.1.0' },
          integrity: `sha512-${'1'.repeat(64)}`,
          trust: 'builtin',
          license: 'MIT',
          state: { installed: '2026-09-11T00:00:00Z', trusted: '2026-09-11T00:00:00Z', enabled: true },
          releasedAt: '2026-09-11T00:00:00Z',
          dependencies: {},
          previous: null,
        },
      },
    }
    const out = packageDirs(profile([pkg('@agnes/code')]), {
      dataDir: dir(),
      profileDir: dir(),
      lock,
      hostRoot: HOST_PKG_ROOT,
    })
    expect(realpathSync(out.get('@agnes/code') as string)).toBe(
      realpathSync(join(REPO_ROOT, 'packages', 'code')),
    )
  })

  it('sends a non-builtin package with no lock entry to the per-profile packages cache', () => {
    const dataDir = dir()
    const out = packageDirs(
      profile([pkg('acme/trusted', { trust: 'trusted', source: 'npm:acme/trusted@1' })]),
      {
        dataDir,
        profileDir: dir(),
        lock: emptyLock('local-dev', '0.0.0'),
        hostRoot: HOST_PKG_ROOT,
      },
    )
    expect(out.get('acme/trusted')).toBe(packageDir(dataDir, 'local-dev', 'acme/trusted'))
  })

  it('leaves packages that are not enabled out of the map entirely', () => {
    const out = packageDirs(
      profile([pkg('@agnes/base'), pkg('acme/off', { trust: 'trusted', enabled: false })]),
      { dataDir: dir(), profileDir: dir(), lock: emptyLock('local-dev', '0.0.0'), hostRoot: HOST_PKG_ROOT },
    )
    expect(out.has('@agnes/base')).toBe(true)
    expect(out.has('acme/off')).toBe(false)
  })

  // lockState refuses any lock carrying a workspace section (fail-closed, Task 13/18 slice), so no
  // profile resolved through the real boot path can arrive here with one today; the branch exists
  // per the plan sketch against Task 17 and is pinned by constructing the Lockfile directly.
  it('maps a workspace-sourced entry under the lock workspace path, relative to the profile dir', () => {
    const profileDir = dir()
    const lock: Lockfile = {
      ...emptyLock('local-dev', '0.0.0'),
      workspace: {
        path: 'checkout',
        hash: `sha256-${'0'.repeat(64)}`,
        manifestId: 'ws',
        trustedAt: '2026-09-11T00:00:00Z',
      },
      packages: { 'acme-local': workspaceEntry('workspace:pkgs/local') },
    }
    const out = packageDirs(
      profile([pkg('acme-local', { trust: 'trusted', source: 'workspace:pkgs/local' })]),
      { dataDir: dir(), profileDir, lock, hostRoot: HOST_PKG_ROOT },
    )
    expect(out.get('acme-local')).toBe(resolve(profileDir, 'checkout', 'pkgs/local'))
  })

  it('falls to the packages cache for a workspace entry when the lock has no workspace section', () => {
    const dataDir = dir()
    const lock: Lockfile = {
      ...emptyLock('local-dev', '0.0.0'),
      packages: { 'acme-local': workspaceEntry('workspace:pkgs/local') },
    }
    const out = packageDirs(
      profile([pkg('acme-local', { trust: 'trusted', source: 'workspace:pkgs/local' })]),
      { dataDir, profileDir: dir(), lock, hostRoot: HOST_PKG_ROOT },
    )
    expect(out.get('acme-local')).toBe(packageDir(dataDir, 'local-dev', 'acme-local'))
  })
})
