import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_ROOT_SOURCES,
  type ArtifactReachabilityInput,
  type ArtifactRootSource,
  artifactStorePath,
} from '../src/reachability.js'
import { planRetainedArtifactGc } from '../src/retention-selector.js'

const DATA = process.platform === 'win32' ? 'C:\\agnes-data' : '/var/lib/agnes'
const digest = (character: string) => character.repeat(64)
const roots = (
  entries: Partial<Record<ArtifactRootSource, ArtifactReachabilityInput['roots']['ledger']['roots']>> = {},
) =>
  Object.fromEntries(
    ARTIFACT_ROOT_SOURCES.map((source) => [source, { complete: true, roots: entries[source] ?? [] }]),
  ) as unknown as ArtifactReachabilityInput['roots']
const candidate = (sha256: string, bytes: number, createdAtMs: number) => ({
  sha256,
  contentSha256: sha256,
  path: artifactStorePath(DATA, sha256),
  bytes,
  createdAtMs,
})

describe('artifact TTL and global byte-cap selection', () => {
  it('deletes expired unreachable bytes while preserving every five-source root', () => {
    const kept = digest('a')
    const expired = digest('b')
    const fresh = digest('c')
    const result = planRetainedArtifactGc({
      dataDir: DATA,
      lastReferencedAtMs: new Map<string, number>(),
      candidates: [candidate(kept, 10, 0), candidate(expired, 20, 0), candidate(fresh, 30, 9_500)],
      roots: roots({ ledger: [{ sha256: kept }] }),
      nowMs: 10_000,
      ttlMs: 1_000,
      maxExtendedTtlMs: 7_000,
      globalMaxBytes: 1_000,
      capacityGraceMs: 1_000,
    })
    expect(result.plan.kept.map((entry) => entry.sha256)).toEqual([kept])
    expect(result.plan.eligibleForDeletion.map((entry) => entry.sha256)).toEqual([expired])
    expect(result.executionPlan.kept).toEqual([])
    expect(result.executionPlan.eligibleForDeletion.map((entry) => entry.sha256)).toEqual([expired])
    expect(result.remainingBytes).toBe(40)
  })

  it('evicts oldest unreachable bytes before TTL only when required by the global cap', () => {
    const oldest = digest('a')
    const newest = digest('b')
    const result = planRetainedArtifactGc({
      dataDir: DATA,
      lastReferencedAtMs: new Map<string, number>(),
      candidates: [candidate(newest, 60, 9_000), candidate(oldest, 60, 8_000)],
      roots: roots(),
      nowMs: 10_000,
      ttlMs: 5_000,
      maxExtendedTtlMs: 7_000,
      globalMaxBytes: 100,
      capacityGraceMs: 500,
    })
    expect(result.plan.eligibleForDeletion.map((entry) => entry.sha256)).toEqual([oldest])
    expect(result.remainingBytes).toBe(60)
    expect(result.unresolvedPressureBytes).toBe(0)
  })

  it('reports pressure without deleting reachable bytes', () => {
    const kept = digest('d')
    const result = planRetainedArtifactGc({
      dataDir: DATA,
      lastReferencedAtMs: new Map<string, number>(),
      candidates: [candidate(kept, 200, 0)],
      roots: roots({ rollback: [{ sha256: kept }] }),
      nowMs: 10_000,
      ttlMs: 1_000,
      maxExtendedTtlMs: 7_000,
      globalMaxBytes: 100,
      capacityGraceMs: 1_000,
    })
    expect(result.plan.eligibleForDeletion).toEqual([])
    expect(result.executionPlan.eligibleForDeletion).toEqual([])
    expect(result.unresolvedPressureBytes).toBe(100)
  })

  it('honors an explicit trusted-profile extension up to seven days', () => {
    const retained = digest('e')
    const common = {
      dataDir: DATA,
      lastReferencedAtMs: new Map<string, number>(),
      candidates: [candidate(retained, 10, 0)],
      roots: roots(),
      ttlMs: 7 * 24 * 60 * 60_000,
      maxExtendedTtlMs: 7 * 24 * 60 * 60_000,
      globalMaxBytes: 1_000,
      capacityGraceMs: 60_000,
    }
    expect(
      planRetainedArtifactGc({ ...common, nowMs: 24 * 60 * 60_000 }).executionPlan.eligibleForDeletion,
    ).toEqual([])
    expect(
      planRetainedArtifactGc({
        ...common,
        nowMs: 7 * 24 * 60 * 60_000,
      }).executionPlan.eligibleForDeletion.map((entry) => entry.sha256),
    ).toEqual([retained])
  })

  it('reports temporary pressure instead of deleting a screenshot before its ledger commit', () => {
    const inFlight = digest('f')
    const result = planRetainedArtifactGc({
      dataDir: DATA,
      lastReferencedAtMs: new Map<string, number>(),
      candidates: [candidate(inFlight, 200, 9_500)],
      roots: roots(),
      nowMs: 10_000,
      ttlMs: 5_000,
      maxExtendedTtlMs: 7_000,
      globalMaxBytes: 100,
      capacityGraceMs: 1_000,
    })
    expect(result.executionPlan.eligibleForDeletion).toEqual([])
    expect(result.remainingBytes).toBe(200)
    expect(result.unresolvedPressureBytes).toBe(100)
  })

  it('stops selecting once the next deletion would exceed the byte bound, TTL and capacity alike', () => {
    const [a, b, c, d] = [digest('1'), digest('2'), digest('3'), digest('4')]
    const common = {
      dataDir: DATA,
      lastReferencedAtMs: new Map<string, number>(),
      candidates: [candidate(a, 10, 0), candidate(b, 20, 1), candidate(c, 30, 2), candidate(d, 40, 3)],
      roots: roots(),
      maxExtendedTtlMs: 7_000,
      capacityGraceMs: 1,
      maxDeleteBytes: 35,
    }
    const expired = planRetainedArtifactGc({ ...common, nowMs: 10_000, ttlMs: 1_000, globalMaxBytes: 1_000 })
    expect(expired.executionPlan.eligibleForDeletion.map((entry) => entry.sha256)).toEqual([a, b])
    expect(expired.plannedDeleteBytes).toBe(30)
    const pressured = planRetainedArtifactGc({ ...common, nowMs: 10, ttlMs: 1_000, globalMaxBytes: 1 })
    expect(pressured.executionPlan.eligibleForDeletion.map((entry) => entry.sha256)).toEqual([a, b])
    expect(pressured.unresolvedPressureBytes).toBe(69)
  })

  it('still selects one candidate larger than the byte bound so collection progresses', () => {
    const large = digest('5')
    const small = digest('6')
    const result = planRetainedArtifactGc({
      dataDir: DATA,
      lastReferencedAtMs: new Map<string, number>(),
      candidates: [candidate(large, 100, 0), candidate(small, 1, 1)],
      roots: roots(),
      nowMs: 10_000,
      ttlMs: 1_000,
      maxExtendedTtlMs: 7_000,
      globalMaxBytes: 1_000,
      capacityGraceMs: 1_000,
      maxDeleteBytes: 50,
    })
    expect(result.executionPlan.eligibleForDeletion.map((entry) => entry.sha256)).toEqual([large])
    expect(() =>
      planRetainedArtifactGc({
        dataDir: DATA,
        lastReferencedAtMs: new Map<string, number>(),
        candidates: [],
        roots: roots(),
        nowMs: 1,
        ttlMs: 1,
        maxExtendedTtlMs: 1,
        globalMaxBytes: 1,
        capacityGraceMs: 1,
        maxDeleteBytes: 0,
      }),
    ).toThrow('maximum deletion bytes')
  })

  it('selects exactly as before when no byte bound is given', () => {
    let seed = 7
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let run = 0; run < 200; run += 1) {
      const candidates = Array.from({ length: 1 + Math.floor(random() * 12) }, (_, index) =>
        candidate(
          index.toString(16).padStart(64, '0'),
          1 + Math.floor(random() * 50),
          Math.floor(random() * 9_000),
        ),
      )
      const input = {
        dataDir: DATA,
        lastReferencedAtMs: new Map<string, number>(),
        candidates,
        roots: roots({ ledger: candidates.filter(() => random() < 0.3).map(({ sha256 }) => ({ sha256 })) }),
        nowMs: 10_000,
        ttlMs: 1 + Math.floor(random() * 9_000),
        maxExtendedTtlMs: 10_000,
        globalMaxBytes: 1 + Math.floor(random() * 300),
        capacityGraceMs: 1 + Math.floor(random() * 2_000),
        maxDeletes: 1 + Math.floor(random() * 6),
      }
      expect(planRetainedArtifactGc(input)).toEqual(
        planRetainedArtifactGc({ ...input, maxDeleteBytes: 1_000_000 }),
      )
    }
  })

  it('evicts referenced bytes above the cap, oldest last reference first, until the cap is met', () => {
    const [a, b, c, d] = [digest('7'), digest('8'), digest('9'), digest('0')]
    const result = planRetainedArtifactGc({
      dataDir: DATA,
      candidates: [
        candidate(a, 40, 100),
        candidate(b, 40, 200),
        candidate(c, 40, 300),
        candidate(d, 40, 400),
      ],
      roots: roots({
        ledger: [{ sha256: a }, { sha256: b }, { sha256: c }],
        'request-media': [{ sha256: d, artifactUri: `artifact://${d}` }],
      }),
      // a was referenced again recently, so b (then d, which falls back to createdAtMs) goes first.
      lastReferencedAtMs: new Map([
        [a, 9_000],
        [b, 500],
        [c, 8_000],
      ]),
      nowMs: 10_000,
      ttlMs: 1_000,
      maxExtendedTtlMs: 7_000,
      globalMaxBytes: 90,
      capacityGraceMs: 1_000,
    })
    expect(result.executionPlan.eligibleForDeletion.map((entry) => entry.sha256)).toEqual([d, b].sort())
    expect(result.remainingBytes).toBe(80)
    expect(result.unresolvedPressureBytes).toBe(0)
  })

  it('never evicts referenced bytes below the cap, inside the grace window, or held by another root', () => {
    const [ledgerOnly, fresh, retained, exported, rolledBack] = [
      digest('a'),
      digest('b'),
      digest('c'),
      digest('d'),
      digest('e'),
    ]
    const common = {
      dataDir: DATA,
      candidates: [
        candidate(ledgerOnly, 50, 0),
        candidate(fresh, 50, 9_900),
        candidate(retained, 50, 0),
        candidate(exported, 50, 0),
        candidate(rolledBack, 50, 0),
      ],
      roots: roots({
        ledger: [ledgerOnly, fresh, retained, exported, rolledBack].map((sha256) => ({ sha256 })),
        retention: [{ sha256: retained }],
        export: [{ sha256: exported }],
        rollback: [{ sha256: rolledBack }],
      }),
      lastReferencedAtMs: new Map<string, number>(),
      nowMs: 10_000,
      ttlMs: 1_000,
      maxExtendedTtlMs: 7_000,
      capacityGraceMs: 1_000,
    }
    expect(
      planRetainedArtifactGc({ ...common, globalMaxBytes: 250 }).executionPlan.eligibleForDeletion,
    ).toEqual([])
    const over = planRetainedArtifactGc({ ...common, globalMaxBytes: 1 })
    expect(over.executionPlan.eligibleForDeletion.map((entry) => entry.sha256)).toEqual([ledgerOnly])
    expect(over.unresolvedPressureBytes).toBe(199)
  })

  it('bounds referenced eviction by the batch limits', () => {
    const shas = [digest('1'), digest('2'), digest('3')]
    const input = {
      dataDir: DATA,
      candidates: shas.map((sha256, index) => candidate(sha256, 30, index)),
      roots: roots({ ledger: shas.map((sha256) => ({ sha256 })) }),
      lastReferencedAtMs: new Map<string, number>(),
      nowMs: 10_000,
      ttlMs: 1_000,
      maxExtendedTtlMs: 7_000,
      globalMaxBytes: 1,
      capacityGraceMs: 1_000,
    }
    expect(
      planRetainedArtifactGc({ ...input, maxDeletes: 2 }).executionPlan.eligibleForDeletion,
    ).toHaveLength(2)
    expect(
      planRetainedArtifactGc({ ...input, maxDeleteBytes: 50 }).executionPlan.eligibleForDeletion,
    ).toHaveLength(1)
    expect(() =>
      planRetainedArtifactGc({ ...input, lastReferencedAtMs: new Map([[shas[0] as string, -1]]) }),
    ).toThrow('last reference time')
  })
})
