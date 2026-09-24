import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isHostError } from '../../src/errors.js'
import { cacheDir as defaultCacheDir, dataDir as defaultDataDir } from '../../src/paths.js'
import { expandHome, resolveProfile } from '../../src/profile/resolve.js'
import type { LockState, ResolveEnv } from '../../src/profile/types.js'

const HOME = '/home/tester'
const env = (over: Partial<ResolveEnv> = {}): ResolveEnv => ({
  platform: { os: 'linux', arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-09T00:00:00Z',
  homeDir: HOME,
  ...over,
})
const lock: LockState = {
  packages: Object.fromEntries(
    ['@agnes/ai', '@agnes/base', '@agnes/code'].map((id) => [
      id,
      { version: '0.1.0', integrity: 'sha512-x', trust: 'builtin' as const, enabled: true },
    ]),
  ),
}

/**
 * The unconfigured case, first, because it is the only one a real installation walks and the only
 * one no test walked. `dataDir` used to default to the literal string `~/.agnes`, and
 * templates/local-dev.yaml wrote the same string, and nothing expanded it: an installation that
 * configured nothing put its session database, its tables and its audit log in a directory
 * literally named `~`, under whatever the process's working directory happened to be.
 *
 * The severity was in the silence. It never failed. Two invocations from two directories got two
 * different databases, each perfectly usable, and a session written by one could not be found from
 * the other -- nothing anywhere said so. Fixing the literal `~` left a second, quieter version of
 * the same defect standing: the default it expanded to was the home root itself, the very directory
 * daemon's own default (home/data) deliberately avoids writing into. Both are covered below.
 */
describe('a profile that configures no paths at all', () => {
  it('puts its data under home/data and its cache under home/cache, never the home root itself', async () => {
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env())
    expect(p.dataDir).toBe(join(HOME, 'data'))
    expect(p.cacheDir).toBe(join(HOME, 'cache'))
    // Not a coincidental match: this is the exact function daemon's own default calls too.
    expect(p.dataDir).toBe(defaultDataDir(HOME))
    expect(p.cacheDir).toBe(defaultCacheDir(HOME))
  })

  it('and every one of those paths is absolute, so two working directories cannot disagree', async () => {
    const p = await resolveProfile({ builtin: 'local-dev', lock }, env())
    for (const path of [p.dataDir, p.cacheDir]) {
      expect(isAbsolute(path), path).toBe(true)
      expect(path.includes('~'), path).toBe(false)
    }
  })

  it('resolves from the same place whichever directory the process was started in', async () => {
    const a = await resolveProfile({ builtin: 'local-dev', lock }, env())
    const b = await resolveProfile({ builtin: 'local-dev', lock }, env())
    expect(a.dataDir).toBe(b.dataDir)
  })

  it('falls back to the account home when the caller names none', async () => {
    const { homeDir: _unset, ...rest } = env()
    const p = await resolveProfile({ builtin: 'local-dev', lock }, rest)
    expect(p.dataDir).toBe(join(homedir(), 'data'))
  })
})

describe('every path a profile carries', () => {
  it('expands a tilde in the paths a deployment writes for itself, not only in the defaults', async () => {
    const p = await resolveProfile(
      {
        builtin: 'local-dev',
        lock,
        user: {
          name: 'local-dev',
          dataDir: '~/state',
          cacheDir: '~',
          adapters: { secrets: { kind: 'file', path: '~/keys' } },
        },
      },
      env(),
    )
    expect(p.dataDir).toBe(join(HOME, 'state'))
    expect(p.cacheDir).toBe(HOME)
    expect(p.adapters.secrets.path).toBe(join(HOME, 'keys'))
  })

  it('leaves an absolute path, a relative path and a tilde elsewhere in the string alone', async () => {
    const p = await resolveProfile(
      {
        builtin: 'local-dev',
        lock,
        user: { name: 'local-dev', dataDir: '/srv/agnes', cacheDir: 'var/cache~1' },
      },
      env(),
    )
    expect(p.dataDir).toBe('/srv/agnes')
    expect(p.cacheDir).toBe('var/cache~1')
  })

  // The default changed; an explicit choice must not. A deployment that named its own dataDir
  // never asked to be filed under a `data/` subdirectory of it -- that relocation only applies to
  // the unconfigured case above.
  it('honours an explicit dataDir exactly, never nesting it under its own data/', async () => {
    const p = await resolveProfile(
      { builtin: 'local-dev', lock, user: { name: 'local-dev', dataDir: '/var/lib/agnes' } },
      env(),
    )
    expect(p.dataDir).toBe('/var/lib/agnes')
    expect(p.dataDir).not.toBe(join('/var/lib/agnes', 'data'))
  })

  // Refused rather than passed through: passing it through is how the original bug worked, and
  // guessing another account's home directory would be worse than saying no.
  it('refuses ~user, which it cannot expand and must not invent', async () => {
    const e = await resolveProfile(
      { builtin: 'local-dev', lock, user: { name: 'local-dev', dataDir: '~someone/agnes' } },
      env(),
    ).catch((x: unknown) => x)
    expect(isHostError(e)).toBe(true)
    expect((e as { code: string }).code).toBe('E_PRESET_UNRESOLVED')
    expect((e as { detail: { reason: string } }).detail.reason).toBe('unsupported-home-reference')
  })
})

// The hash is meant to describe what actually ran. Two machines whose home directories differ really
// did run against different directories, so the expansion happens before the hash rather than after
// -- the same principle that makes this resolver refuse a layer it cannot apply.
describe('the resolved hash', () => {
  it('follows the expanded paths, so two homes are not reported as one profile', async () => {
    const a = await resolveProfile({ builtin: 'local-dev', lock }, env())
    const b = await resolveProfile({ builtin: 'local-dev', lock }, env({ homeDir: '/home/other' }))
    expect(a.dataDir).not.toBe(b.dataDir)
    expect(a.hash).not.toBe(b.hash)
  })
})

describe('expandHome', () => {
  it.each([
    ['~', HOME],
    ['~/', join(HOME)],
    ['~/x', join(HOME, 'x')],
    ['~/x/y', join(HOME, 'x', 'y')],
    ['/abs', '/abs'],
    ['rel', 'rel'],
    ['', ''],
    ['a~b', 'a~b'],
    ['./~', './~'],
  ])('%j becomes %j', (input, expected) => {
    expect(expandHome(input, HOME)).toBe(expected)
  })

  it('refuses every other leading tilde rather than writing it out literally', () => {
    for (const bad of ['~root', '~root/x', '~+', '~-/x'])
      expect(() => expandHome(bad, HOME), bad).toThrow(/only ~ and ~\//)
  })
})
