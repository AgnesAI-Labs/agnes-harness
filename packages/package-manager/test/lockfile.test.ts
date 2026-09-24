import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isPackageError } from '../src/errors.js'
import {
  emptyLock,
  type LockEntry,
  type Lockfile,
  lockPath,
  readLock,
  withLock,
  writeLock,
} from '../src/lockfile.js'

// A lockfile only validates with every field the schema makes required: resolvedProfileHash is a
// real `sha256-<64 hex>` (null is a draft-only value, never writable), seams is the closed
// ten-key object, and an npm/market entry carries license, releasedAt and dependencies.
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
const npmEntry = (id: string): LockEntry => ({
  version: '0.1.0',
  source: { type: 'npm', ref: `npm:${id}@0.1.0` },
  integrity: 'sha512-x',
  trust: 'builtin',
  license: 'MIT',
  state: { installed: '2026-09-07T00:00:00Z', trusted: '2026-09-07T00:00:00Z', enabled: true },
  releasedAt: '2026-09-07T00:00:00Z',
  dependencies: {},
  previous: null,
})
const writableLock = (profile: string): Lockfile => ({
  ...emptyLock(profile, '0.1.0'),
  resolvedProfileHash: HASH,
  seams: { ...SEAMS },
})

describe('lockfile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-lock-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns an empty lock when the file is missing and round-trips writes', () => {
    const l = readLock(dir, { profile: 'local-dev', agnesVersion: '0.1.0' })
    expect(l).toMatchObject({ lockfileVersion: 1, profile: 'local-dev', packages: {} })
    expect(l.resolvedProfileHash).toBeNull()
    expect(existsSync(lockPath(dir))).toBe(false)

    const w = writableLock('local-dev')
    w.packages['@agnes/base'] = npmEntry('@agnes/base')
    writeLock(dir, w)
    const back = readLock(dir, { profile: 'local-dev', agnesVersion: '0.1.0' })
    expect(back.packages['@agnes/base']?.integrity).toBe('sha512-x')
    expect(back.resolvedProfileHash).toBe(HASH)
    expect(existsSync(`${lockPath(dir)}.tmp`)).toBe(false)
  })

  it('rejects a lock that is not JSON, and one that does not validate, with E_LOCK_MISMATCH', () => {
    writeFileSync(lockPath(dir), 'not json{')
    const a = (() => {
      try {
        readLock(dir, { profile: 'x', agnesVersion: '0.1.0' })
      } catch (e) {
        return e
      }
      throw new Error('should have thrown')
    })()
    expect(isPackageError(a, 'E_LOCK_MISMATCH')).toBe(true)

    writeFileSync(lockPath(dir), JSON.stringify({ lockfileVersion: 2 }))
    const b = (() => {
      try {
        readLock(dir, { profile: 'x', agnesVersion: '0.1.0' })
      } catch (e) {
        return e
      }
      throw new Error('should have thrown')
    })()
    expect(isPackageError(b, 'E_LOCK_MISMATCH')).toBe(true)
    expect((b as { detail?: unknown }).detail).toMatchObject({ reason: 'invalid' })
  })

  it('replaces an existing lock and preserves it if the next temporary write fails', () => {
    writeLock(dir, writableLock('local-dev'))
    const next = writableLock('local-dev')
    next.packages['@agnes/base'] = npmEntry('@agnes/base')
    writeLock(dir, next)
    expect(readLock(dir, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages).toEqual(next.packages)
    const saved = readFileSync(lockPath(dir), 'utf8')
    mkdirSync(`${lockPath(dir)}.tmp`)
    expect(() => writeLock(dir, writableLock('local-dev'))).toThrow()
    expect(readFileSync(lockPath(dir), 'utf8')).toBe(saved)
  })

  it('continues accepting a relative profile directory', () => {
    writeLock(relative(process.cwd(), dir), writableLock('local-dev'))
    expect(readLock(dir, { profile: 'local-dev', agnesVersion: '0.1.0' }).resolvedProfileHash).toBe(HASH)
  })

  it('preserves an existing valid lock when a new draft fails validation', () => {
    writeLock(dir, writableLock('local-dev'))
    const saved = readFileSync(lockPath(dir), 'utf8')
    expect(() => writeLock(dir, emptyLock('local-dev', '0.1.0'))).toThrow()
    expect(readFileSync(lockPath(dir), 'utf8')).toBe(saved)
    expect(existsSync(`${lockPath(dir)}.tmp`)).toBe(false)
  })

  // The write side validates against the same schema the read side enforces, so a lock on disk can
  // never be one readLock would refuse. The price: an empty lock carries no resolvedProfileHash to
  // attest, and is therefore a draft that cannot be written -- only snapshotPolicy (or a caller
  // holding a real hash) produces a writable lock.
  it('refuses to write a lock that would not read back', () => {
    const draft = emptyLock('local-dev', '0.1.0')
    expect(() => writeLock(dir, draft)).toThrow(/E_PACKAGE_INTEGRITY/)
    expect(existsSync(lockPath(dir))).toBe(false)
    expect(existsSync(`${lockPath(dir)}.tmp`)).toBe(false)
  })

  it('withLock serializes writers and cleans up', async () => {
    const order: string[] = []
    await Promise.all([
      withLock(dir, async () => {
        order.push('a-start')
        await new Promise((r) => setTimeout(r, 50))
        order.push('a-end')
      }),
      withLock(dir, async () => {
        order.push('b-start')
        order.push('b-end')
      }),
    ])
    expect(order.indexOf('a-end')).toBeLessThan(order.indexOf('b-start'))
    expect(existsSync(join(dir, '.agnes-lock.lock'))).toBe(false)
  })

  it('withLock releases the lock file when the callback throws', async () => {
    await expect(
      withLock(dir, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(existsSync(join(dir, '.agnes-lock.lock'))).toBe(false)
  })

  it('never writes host names or absolute paths', () => {
    writeLock(dir, writableLock('p'))
    const text = readFileSync(lockPath(dir), 'utf8')
    expect(text).not.toContain(dir)
    expect(text).not.toContain(process.env.HOME ?? '~~')
  })
})
