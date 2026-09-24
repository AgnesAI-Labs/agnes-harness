import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { selectIsolatedPackages } from '../src/select.js'

type Profile = Parameters<typeof selectIsolatedPackages>[0]
type Installed = Parameters<typeof selectIsolatedPackages>[1][number]

const profile: Profile = {
  seams: { tools: '@agnes/builtin-tools' },
  provider: { package: '@agnes/ai', adapters: ['@agnes/ai-anthropic'] },
  adapters: { storage: '@agnes/storage-sqlite' },
  packages: [
    { id: 'acme/isolated', enabled: true, trust: 'trusted', version: '1.0.0', integrity: 'sha256-abc' },
    { id: 'acme/untrusted', enabled: true, trust: 'candidate', version: '1.0.0', integrity: 'sha256-abc' },
  ],
}

function installed(overrides: Partial<Installed> = {}): Installed {
  return {
    id: 'acme/isolated',
    entry: { version: '1.0.0', integrity: 'sha256-abc' },
    directory: null,
    trusted: true,
    enabled: true,
    contributions: [{ kind: 'extension' }],
    blockers: [],
    ...overrides,
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function realDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-package-isolation-'))
  dirs.push(dir)
  return dir
}

describe('selectIsolatedPackages', () => {
  it('selects a package that matches the profile entry and its own real directory', () => {
    const dir = realDir()
    const row = installed({ directory: dir })
    const result = selectIsolatedPackages(profile, [row], new Map([['acme/isolated', dir]]))
    expect(result.get('acme/isolated')).toBe(row)
  })

  it('excludes a package the profile does not list as trusted and enabled', () => {
    const dir = realDir()
    const row = installed({ id: 'acme/untrusted', directory: dir })
    const result = selectIsolatedPackages(profile, [row], new Map([['acme/untrusted', dir]]))
    expect(result.size).toBe(0)
  })

  it('excludes a package whose installed version does not match the profile-pinned version', () => {
    const dir = realDir()
    const row = installed({ directory: dir, entry: { version: '2.0.0', integrity: 'sha256-abc' } })
    const result = selectIsolatedPackages(profile, [row], new Map([['acme/isolated', dir]]))
    expect(result.size).toBe(0)
  })

  it('excludes a package whose installed integrity does not match the profile-pinned integrity', () => {
    const dir = realDir()
    const row = installed({ directory: dir, entry: { version: '1.0.0', integrity: 'sha256-tampered' } })
    const result = selectIsolatedPackages(profile, [row], new Map([['acme/isolated', dir]]))
    expect(result.size).toBe(0)
  })

  it('excludes a package whose real directory does not match the trusted install location (symlink tampering)', () => {
    const trusted = realDir()
    const swapped = realDir()
    const link = join(tmpdir(), `agnes-package-isolation-link-${Date.now()}`)
    symlinkSync(swapped, link)
    dirs.push(link)
    mkdirSync(swapped, { recursive: true })
    // `row.directory` resolves (via a symlink) to `swapped`, not the `trusted` directory the
    // profile/dirs map expects -- this is the exact tamper shape realpathSync must catch.
    const row = installed({ directory: link })
    const result = selectIsolatedPackages(profile, [row], new Map([['acme/isolated', trusted]]))
    expect(result.size).toBe(0)
  })

  it('excludes a package the runtime never actually installed (no directory)', () => {
    const dir = realDir()
    const row = installed({ directory: null })
    const result = selectIsolatedPackages(profile, [row], new Map([['acme/isolated', dir]]))
    expect(result.size).toBe(0)
  })

  it('excludes a package carrying an unresolved blocker', () => {
    const dir = realDir()
    const row = installed({ directory: dir, blockers: [{ code: 'E_BLOCKED' }] })
    const result = selectIsolatedPackages(profile, [row], new Map([['acme/isolated', dir]]))
    expect(result.size).toBe(0)
  })

  it('excludes a package contributing an out-of-band kind (not extension or surface)', () => {
    const dir = realDir()
    const row = installed({ directory: dir, contributions: [{ kind: 'runtime-python' }] })
    const result = selectIsolatedPackages(profile, [row], new Map([['acme/isolated', dir]]))
    expect(result.size).toBe(0)
  })

  it('excludes a package id already bound into the profile assembly (seams/provider/adapters)', () => {
    const dir = realDir()
    const row = installed({ id: '@agnes/ai', directory: dir })
    const withAssembly: Profile = {
      ...profile,
      packages: [
        ...profile.packages,
        { id: '@agnes/ai', enabled: true, trust: 'trusted', version: '1.0.0', integrity: 'sha256-abc' },
      ],
    }
    const result = selectIsolatedPackages(withAssembly, [row], new Map([['@agnes/ai', dir]]))
    expect(result.size).toBe(0)
  })
})
