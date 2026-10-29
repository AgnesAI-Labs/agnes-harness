import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  approval: { provider: 'local-prompt' },
  checkpoint: { provider: 'fs' },
  billing: { provider: 'budget' },
  verifier: { provider: 't0' },
  repair: { provider: 'default' },
  artifacts: { provider: 'local' },
  principals: { provider: 'local' },
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

    const capturedText = readFileSync(
      new URL('./fixtures/runtime-snapshots-v1/home/profiles/local-dev/agnes-lock.json', import.meta.url),
      'utf8',
    )
    const captured = JSON.parse(capturedText)
    writeFileSync(lockPath(dir), capturedText)
    expect(() => readLock(dir, { profile: 'local-dev', agnesVersion: '0.1.0' })).toThrow(
      /Retired.*clean home/,
    )
    expect(readFileSync(lockPath(dir), 'utf8')).toBe(capturedText)
    expect(() => writeLock(dir, captured)).toThrow(/Retired.*clean home/)
    expect(readFileSync(lockPath(dir), 'utf8')).toBe(capturedText)
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

    const legacy = JSON.parse(
      readFileSync(
        new URL('./fixtures/runtime-snapshots-v1/home/profiles/local-dev/agnes-lock.json', import.meta.url),
        'utf8',
      ),
    )
    legacy.packages['acme/legacy'].metadata.category = 'unknown-category'
    writeFileSync(lockPath(dir), JSON.stringify(legacy))
    expect(() => readLock(dir, { profile: 'local-dev', agnesVersion: '0.1.0' })).toThrow()
    expect(() => writeLock(dir, legacy)).toThrow()
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

  it('never exposes a lock without its owner', async () => {
    const lock = join(dir, '.agnes-lock.lock')
    await withLock(dir, async () => {
      expect(readFileSync(lock, 'utf8')).toBe(String(process.pid))
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    })
  })

  it.each(['stale empty owner', 'fresh dead owner'])('reclaims an abandoned lock: %s', async (scenario) => {
    const lock = join(dir, '.agnes-lock.lock')
    const deadPid = 2147483647
    writeFileSync(lock, scenario === 'fresh dead owner' ? String(deadPid) : '')
    if (scenario === 'stale empty owner') {
      const old = new Date(Date.now() - 5 * 60_000)
      utimesSync(lock, old, old)
    }
    const kill = process.kill.bind(process)
    const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === deadPid) throw Object.assign(new Error('exited fixture owner'), { code: 'ESRCH' })
      return kill(pid, signal)
    })
    vi.useFakeTimers()
    try {
      const attempt = withLock(dir, async () => 'ran').then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      await vi.advanceTimersByTimeAsync(11_000)
      expect(await attempt).toEqual({ value: 'ran' })
      expect(existsSync(lock)).toBe(false)
    } finally {
      vi.useRealTimers()
      probe.mockRestore()
    }
  })

  it.each(['live owner', 'fresh empty owner'])('keeps a contended lock: %s', async (owner) => {
    const lock = join(dir, '.agnes-lock.lock')
    const recordedOwner = owner === 'live owner' ? String(process.pid) : ''
    writeFileSync(lock, recordedOwner)
    vi.useFakeTimers()
    try {
      const attempt = withLock(dir, async () => 'never').catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(11_000)
      const error = (await attempt) as {
        code: string
        legacyCode: string
        message: string
        detail: Record<string, unknown>
      }
      expect(error.message).toContain(lock)
      // Contention with a live holder is retryable, not a verification failure.
      expect([error.code, error.legacyCode]).toEqual(['E_PACKAGE_BUSY', 'E_LOCK_MISMATCH'])
      expect(error.detail).toMatchObject({ reason: 'busy', lockPath: lock })
      expect(String(error.detail.recovery)).toContain('delete the lock file')
    } finally {
      vi.useRealTimers()
    }
    expect(readFileSync(lock, 'utf8')).toBe(recordedOwner)
  })

  it('reports a filesystem failure as itself, never as a busy lock', async () => {
    const error = await withLock(join(dir, 'missing'), async () => 'never').catch((caught: unknown) => caught)
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT')
    expect(isPackageError(error, 'E_LOCK_MISMATCH')).toBe(false)
  })

  it('never writes host names or absolute paths', () => {
    writeLock(dir, writableLock('p'))
    const text = readFileSync(lockPath(dir), 'utf8')
    expect(text).not.toContain(dir)
    expect(text).not.toContain(process.env.HOME ?? '~~')
  })
})
