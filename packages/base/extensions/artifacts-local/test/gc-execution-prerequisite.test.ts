import { describe, expect, it, vi } from 'vitest'
import { prepareArtifactGcExecutionPrerequisite } from '../src/gc-execution-prerequisite.js'
import {
  ARTIFACT_ROOT_SOURCES,
  type ArtifactReachabilityInput,
  artifactStorePath,
  planArtifactGc,
} from '../src/reachability.js'

const DATA = process.platform === 'win32' ? 'C:\\agnes-data' : '/var/lib/agnes'
const digest = (character: string): string => character.repeat(64)
const REACHABILITY = { epoch: 'roots-epoch-1', hash: digest('c') }

function roots(ledger: readonly string[] = []): ArtifactReachabilityInput['roots'] {
  return Object.fromEntries(
    ARTIFACT_ROOT_SOURCES.map((source) => [
      source,
      {
        complete: true,
        roots: source === 'ledger' ? ledger.map((sha256) => ({ sha256 })) : [],
      },
    ]),
  ) as unknown as ArtifactReachabilityInput['roots']
}

function candidate(sha256: string) {
  return { sha256, contentSha256: sha256, path: artifactStorePath(DATA, sha256) }
}

function plan() {
  const kept = digest('a')
  const orphan = digest('b')
  return planArtifactGc({
    dataDir: DATA,
    candidates: [candidate(orphan), candidate(kept)],
    roots: roots([kept]),
  })
}

function prepare(value: unknown = plan()) {
  return prepareArtifactGcExecutionPrerequisite({
    dataDir: DATA,
    plan: value,
    reachabilitySnapshot: REACHABILITY,
  })
}

describe('artifact GC execution prerequisite', () => {
  it('turns an identity-checked plan into a deterministic, still-blocked fd-relative Host request', () => {
    const prepared = prepare()
    const repeated = prepare()

    expect(prepared).toMatchObject({
      mode: 'dry-run-attestation',
      blocked: true,
      blocker: 'fd-relative-host-capability-unavailable',
      authority: 'none',
      reachabilitySnapshot: REACHABILITY,
      candidates: [
        {
          sha256: digest('b'),
          rootRelativePath: `artifacts/sha256/bb/${digest('b')}`,
        },
      ],
    })
    expect(prepared.planHash).toBe(repeated.planHash)
    expect(
      prepareArtifactGcExecutionPrerequisite({
        dataDir: DATA,
        plan: plan(),
        reachabilitySnapshot: { ...REACHABILITY, epoch: 'roots-epoch-2' },
      }).planHash,
    ).not.toBe(prepared.planHash)
    expect(prepared.hostRequirements).toEqual(
      expect.arrayContaining([
        'acquire-exclusive-reachability-and-deletion-lock',
        'recompute-ledger-request-media-export-retention-rollback-roots-under-lock-before-each-unlink',
        'prove-each-ledger-session-prefix-unchanged-under-lock-by-anchor-id-and-hash-chained-integrity-digest-or-id-alone-for-legacy-rows-without-digest',
        're-extract-every-ledger-row-after-each-anchor-under-lock-and-match-bound-snapshot-epoch-hash',
        'open-each-candidate-path-component-as-held-no-follow-directory-handle',
        'require-regular-file-single-link',
        'bind-open-file-handle-to-parent-entry-dev-ino-or-file-id',
        'recompute-sha256-from-open-handle',
        'revalidate-open-handle-and-parent-entry-identity-immediately-before-unlink',
        'abort-batch-on-any-identity-change',
      ]),
    )
    expect('delete' in prepared).toBe(false)
    expect('execute' in prepared).toBe(false)
    expect('expectedPath' in (prepared.candidates[0] ?? {})).toBe(false)
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared.candidates)).toBe(true)
  })

  it('rejects blocked, incomplete, reachable, duplicate and path-drifted plans', () => {
    const valid = plan()
    expect(() => prepare({ ...valid, blocked: true, issues: ['ledger root scan is incomplete'] })).toThrow(
      'unblocked dry-run plan',
    )
    expect(() => prepare({ ...valid, issues: ['incomplete'] })).toThrow('complete issue-free plan')
    expect(() =>
      prepare({
        ...valid,
        eligibleForDeletion: [{ ...valid.eligibleForDeletion[0], reachableFrom: ['ledger'] }],
      }),
    ).toThrow('still reachable')
    expect(() =>
      prepare({ ...valid, eligibleForDeletion: [...valid.eligibleForDeletion, valid.kept[0]] }),
    ).toThrow(/not deterministic|still reachable|duplicate identities/)
    expect(() =>
      prepare({
        ...valid,
        eligibleForDeletion: [{ ...valid.eligibleForDeletion[0], path: '/tmp/escape' }],
      }),
    ).toThrow('content/path identity')
  })

  it('rejects Proxy/accessor/sparse inputs without invoking hostile code', () => {
    const valid = plan()
    const getter = vi.fn(() => valid.eligibleForDeletion)
    const accessor = { ...valid }
    Object.defineProperty(accessor, 'eligibleForDeletion', { enumerable: true, get: getter })
    expect(() => prepare(accessor)).toThrow('unblocked dry-run plan')
    expect(getter).not.toHaveBeenCalled()

    const trap = vi.fn(() => {
      throw new Error('must not run')
    })
    expect(() => prepare(new Proxy(valid, { get: trap }))).toThrow('unblocked dry-run plan')
    expect(trap).not.toHaveBeenCalled()

    const sparse = [...valid.eligibleForDeletion]
    sparse.length = 2
    expect(() => prepare({ ...valid, eligibleForDeletion: sparse })).toThrow('invalid candidate list')
  })

  it('strictly snapshots the outer request and reachability identity without invoking hostile code', () => {
    const dataDirGetter = vi.fn(() => DATA)
    const outer = { plan: plan(), reachabilitySnapshot: REACHABILITY } as Record<string, unknown>
    Object.defineProperty(outer, 'dataDir', { enumerable: true, get: dataDirGetter })
    expect(() => prepareArtifactGcExecutionPrerequisite(outer as never)).toThrow('exact request snapshot')
    expect(dataDirGetter).not.toHaveBeenCalled()

    const outerTrap = vi.fn(() => {
      throw new Error('outer trap must not run')
    })
    expect(() =>
      prepareArtifactGcExecutionPrerequisite(
        new Proxy({ dataDir: DATA, plan: plan(), reachabilitySnapshot: REACHABILITY }, { get: outerTrap }),
      ),
    ).toThrow('exact request snapshot')
    expect(outerTrap).not.toHaveBeenCalled()
    expect(() =>
      prepareArtifactGcExecutionPrerequisite({
        dataDir: DATA,
        plan: plan(),
        reachabilitySnapshot: REACHABILITY,
        extra: true,
      } as never),
    ).toThrow('exact request snapshot')

    const epochGetter = vi.fn(() => 'roots-epoch-1')
    const reachability = { hash: digest('c') } as Record<string, unknown>
    Object.defineProperty(reachability, 'epoch', { enumerable: true, get: epochGetter })
    expect(() =>
      prepareArtifactGcExecutionPrerequisite({
        dataDir: DATA,
        plan: plan(),
        reachabilitySnapshot: reachability,
      }),
    ).toThrow('canonical reachability snapshot identity')
    expect(epochGetter).not.toHaveBeenCalled()
  })

  it('caps one execution batch at 4096 entries', () => {
    const eligibleForDeletion = Array.from({ length: 4097 }, (_, index) => {
      const sha256 = index.toString(16).padStart(64, '0')
      return { sha256, path: artifactStorePath(DATA, sha256), reachableFrom: [] }
    })
    expect(() =>
      prepare({
        mode: 'dry-run',
        blocked: false,
        issues: [],
        kept: [],
        eligibleForDeletion,
      }),
    ).toThrow('invalid candidate list')
  })

  it.each(
    process.platform === 'win32'
      ? ['relative/path', 'C:\\', 'C:\\agnes-data\\..\\agnes-data', 'C:\\agnes-data\\']
      : ['relative/path', '/', '/var/lib/agnes/../agnes', '/var/lib/agnes/'],
  )('rejects noncanonical root %s', (dataDir) => {
    expect(() =>
      prepareArtifactGcExecutionPrerequisite({
        dataDir,
        plan: plan(),
        reachabilitySnapshot: REACHABILITY,
      }),
    ).toThrow('absolute canonical dataDir')
  })
})
