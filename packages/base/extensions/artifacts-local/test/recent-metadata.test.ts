import { describe, expect, it, vi } from 'vitest'
import {
  ARTIFACT_ROOT_SOURCES,
  type ArtifactReachabilityInput,
  artifactStorePath,
  planArtifactGc,
} from '../src/reachability.js'
import { createRecentArtifactMetadataIndex } from '../src/recent-metadata.js'

const digest = (value: number): string => value.toString(16).padStart(64, '0')
const ref = (value: number, mime = 'image/png') => ({ sha256: digest(value), size: value, mime })

describe('per-session recent artifact metadata', () => {
  it('keeps exactly the most recent 100 entries in deterministic newest-first order', () => {
    const index = createRecentArtifactMetadataIndex()
    for (let value = 1; value <= 105; value += 1) index.record('session-a', ref(value))

    const snapshot = index.snapshot('session-a')
    expect(snapshot.artifacts).toHaveLength(100)
    expect(snapshot.artifacts.map((entry) => entry.sha256)).toEqual(
      Array.from({ length: 100 }, (_, offset) => digest(105 - offset)),
    )
    expect(snapshot).toMatchObject({
      sessionKey: 'session-a',
      purpose: 'recent-ui-and-dedup-metadata',
      gcDeletionAuthority: false,
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.artifacts)).toBe(true)
    expect(Object.isFrozen(snapshot.artifacts[0])).toBe(true)
  })

  it('supports a profile-tightened recent window and rejects limits above the reviewed maximum', () => {
    const index = createRecentArtifactMetadataIndex(2)
    index.record('session-a', ref(1))
    index.record('session-a', ref(2))
    index.record('session-a', ref(3))
    expect(index.snapshot('session-a').artifacts).toEqual([ref(3), ref(2)])
    expect(() => createRecentArtifactMetadataIndex(0)).toThrow(/1 to 100/)
    expect(() => createRecentArtifactMetadataIndex(101)).toThrow(/1 to 100/)
  })

  it('deduplicates by digest, promotes repeats, and snapshots mutable caller data', () => {
    const index = createRecentArtifactMetadataIndex()
    const mutable = ref(1)
    index.record('session-a', mutable)
    index.record('session-a', ref(2))
    mutable.sha256 = digest(3)
    mutable.size = 3

    const promoted = index.record('session-a', ref(1, 'image/jpeg'))
    expect(promoted.artifacts).toEqual([ref(1, 'image/jpeg'), ref(2)])
    expect(() => index.record('session-a', { ...ref(1), size: 999 })).toThrow(/identity collision/)
    expect(index.snapshot('session-a')).toEqual(promoted)
  })

  it('strictly isolates sessions and resets only the named session', () => {
    const index = createRecentArtifactMetadataIndex()
    index.record('session-a', ref(1))
    index.record('session-b', ref(2))

    index.resetForCompaction('session-a')
    expect(index.snapshot('session-a').artifacts).toEqual([])
    expect(index.snapshot('session-b').artifacts).toEqual([ref(2)])
    index.record('session-a', ref(3))

    index.resetSession('session-b')
    expect(index.snapshot('session-a').artifacts).toEqual([ref(3)])
    expect(index.snapshot('session-b').artifacts).toEqual([])
  })

  it('rejects proxy, accessor, custom-prototype, symbol, extra and malformed identities', () => {
    const index = createRecentArtifactMetadataIndex()
    const getter = vi.fn(() => digest(1))
    const accessor = { size: 1, mime: 'image/png' }
    Object.defineProperty(accessor, 'sha256', { enumerable: true, get: getter })
    const proxyGet = vi.fn(() => {
      throw new Error('must not execute')
    })
    const symbol = ref(1) as Record<PropertyKey, unknown>
    symbol[Symbol('hidden')] = true
    const samples: unknown[] = [
      accessor,
      new Proxy(ref(1), { get: proxyGet }),
      Object.assign(Object.create({ inherited: true }), ref(1)),
      symbol,
      { ...ref(1), extra: true },
      { ...ref(1), sha256: 'A'.repeat(64) },
      { ...ref(1), size: -1 },
      { ...ref(1), mime: 'image/png\0secret' },
    ]
    for (const sample of samples) expect(() => index.record('session-a', sample)).toThrow(/identity/)
    expect(getter).not.toHaveBeenCalled()
    expect(proxyGet).not.toHaveBeenCalled()
    expect(index.snapshot('session-a').artifacts).toEqual([])
  })

  it('rejects invalid session identities without coercion or cross-session mutation', () => {
    const index = createRecentArtifactMetadataIndex()
    index.record('session-a', ref(1))
    const coerced = { toString: vi.fn(() => 'session-a') }
    expect(() => index.record(coerced as unknown as string, ref(2))).toThrow(/session identity/)
    expect(() => index.snapshot('session-a\nother')).toThrow(/session identity/)
    expect(coerced.toString).not.toHaveBeenCalled()
    expect(index.snapshot('session-a').artifacts).toEqual([ref(1)])
  })

  it('never becomes GC deletion authority when entries are present or evicted', () => {
    const index = createRecentArtifactMetadataIndex()
    const sha256 = digest(1)
    const dataDir = '/home/u/.agh'
    const roots = Object.fromEntries(
      ARTIFACT_ROOT_SOURCES.map((source) => [source, { complete: true, roots: [] }]),
    ) as unknown as ArtifactReachabilityInput['roots']
    const common = {
      dataDir,
      candidates: [{ sha256, contentSha256: sha256, path: artifactStorePath(dataDir, sha256) }],
      roots,
    }
    const present = index.record('session-a', ref(1))
    const before = planArtifactGc({
      ...common,
      recentMetadataDigests: present.artifacts.map((entry) => entry.sha256),
    })
    index.resetForCompaction('session-a')
    const after = planArtifactGc({ ...common, recentMetadataDigests: [] })

    expect(after).toEqual(before)
    expect(after.eligibleForDeletion.map((entry) => entry.sha256)).toEqual([sha256])
    expect('delete' in index).toBe(false)
  })
})
