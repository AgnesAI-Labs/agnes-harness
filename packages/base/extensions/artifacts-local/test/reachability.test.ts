import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_ROOT_SOURCES,
  type ArtifactReachabilityInput,
  type ArtifactRootSource,
  artifactStorePath,
  planArtifactGc,
} from '../src/reachability.js'

const DATA = '/home/u/.agh'
const digest = (char: string): string => char.repeat(64)
const candidate = (sha256: string) => ({
  sha256,
  contentSha256: sha256,
  path: artifactStorePath(DATA, sha256),
})
const planEntry = (sha256: string, reachableFrom: readonly ArtifactRootSource[]) => ({
  sha256,
  path: artifactStorePath(DATA, sha256),
  reachableFrom,
})

function roots(
  entries: Partial<Record<ArtifactRootSource, ArtifactReachabilityInput['roots']['ledger']['roots']>> = {},
): ArtifactReachabilityInput['roots'] {
  return Object.fromEntries(
    ARTIFACT_ROOT_SOURCES.map((source) => [source, { complete: true, roots: entries[source] ?? [] }]),
  ) as unknown as ArtifactReachabilityInput['roots']
}

describe('artifact reachability GC planning', () => {
  it.each(ARTIFACT_ROOT_SOURCES)('keeps bytes reachable from the %s roots', (source) => {
    const sha256 = digest('a')
    const root = {
      sha256,
      ...(source === 'request-media' ? { artifactUri: `artifact://${sha256}` } : {}),
    }
    const plan = planArtifactGc({
      dataDir: DATA,
      candidates: [candidate(sha256)],
      roots: roots({ [source]: [root] }),
    })

    expect(plan).toMatchObject({ mode: 'dry-run', blocked: false, eligibleForDeletion: [] })
    expect(plan.kept).toEqual([planEntry(sha256, [source])])
  })

  it('marks only globally unreachable bytes as eligible and never deletes anything', () => {
    const ledger = digest('b')
    const orphan = digest('c')
    const plan = planArtifactGc({
      dataDir: DATA,
      candidates: [candidate(orphan), candidate(ledger)],
      roots: roots({ ledger: [{ sha256: ledger }] }),
    })

    expect(plan.blocked).toBe(false)
    expect(plan.kept.map((entry) => entry.sha256)).toEqual([ledger])
    expect(plan.eligibleForDeletion).toEqual([planEntry(orphan, [])])
    expect('delete' in plan).toBe(false)
  })

  it('does not use recent-20 metadata presence or eviction as byte-deletion authority', () => {
    const reachable = digest('d')
    const orphan = digest('e')
    const common = {
      dataDir: DATA,
      candidates: [candidate(reachable), candidate(orphan)],
      roots: roots({ export: [{ sha256: reachable }] }),
    }
    const beforeEviction = planArtifactGc({
      ...common,
      recentMetadataDigests: [reachable, orphan],
    })
    const afterEviction = planArtifactGc({ ...common, recentMetadataDigests: [] })

    expect(afterEviction).toEqual(beforeEviction)
    expect(afterEviction.kept.map((entry) => entry.sha256)).toEqual([reachable])
    expect(afterEviction.eligibleForDeletion.map((entry) => entry.sha256)).toEqual([orphan])
  })

  it('sorts candidates, sources and issues deterministically regardless of scan order', () => {
    const a = digest('1')
    const b = digest('2')
    const forward = planArtifactGc({
      dataDir: DATA,
      candidates: [candidate(b), candidate(a)],
      roots: roots({ rollback: [{ sha256: a }], ledger: [{ sha256: a }] }),
    })
    const reverse = planArtifactGc({
      dataDir: DATA,
      candidates: [candidate(a), candidate(b)],
      roots: roots({ ledger: [{ sha256: a }], rollback: [{ sha256: a }] }),
    })

    expect(reverse).toEqual(forward)
    expect(forward.kept[0]?.reachableFrom).toEqual(['ledger', 'rollback'])
    expect(forward.eligibleForDeletion[0]?.sha256).toBe(b)
  })

  it.each(ARTIFACT_ROOT_SOURCES)('fails closed when the %s root scan is incomplete', (source) => {
    const sha256 = digest('f')
    const allRoots = roots()
    const plan = planArtifactGc({
      dataDir: DATA,
      candidates: [candidate(sha256)],
      roots: { ...allRoots, [source]: { complete: false, roots: [] } },
    })

    expect(plan.blocked).toBe(true)
    expect(plan.issues).toContain(`${source} root scan is incomplete`)
    expect(plan.eligibleForDeletion).toEqual([])
    expect(plan.kept.map((entry) => entry.sha256)).toEqual([sha256])
  })

  it('fails closed for digest/path mismatch, duplicate scans, invalid roots and missing bytes', () => {
    const present = digest('3')
    const missing = digest('4')
    const plan = planArtifactGc({
      dataDir: DATA,
      candidates: [
        candidate(present),
        candidate(present),
        { sha256: digest('5'), contentSha256: digest('6'), path: '/tmp/escape' },
      ],
      roots: roots({
        ledger: [{ sha256: missing }, { sha256: 'ABC' }],
        'request-media': [{ sha256: present, artifactUri: `artifact://${missing}` }],
      }),
    })

    expect(plan.blocked).toBe(true)
    expect(plan.eligibleForDeletion).toEqual([])
    expect(plan.issues).toEqual(
      expect.arrayContaining([
        `candidate ${present} duplicates a content digest`,
        `candidate ${digest('5')} content digest does not match its name`,
        `candidate ${digest('5')} path does not match its content digest`,
        'ledger root has an invalid sha256',
        `request-media root ${present} artifactUri does not match its content digest`,
        `reachable artifact ${missing} is missing from the store scan`,
      ]),
    )
  })

  it('requires request-media URI identity and rejects unsafe dataDir input', () => {
    const sha256 = digest('6')
    const plan = planArtifactGc({
      dataDir: 'bad\0dir',
      candidates: [candidate(sha256)],
      roots: roots({ 'request-media': [{ sha256 }] }),
    })

    expect(plan.blocked).toBe(true)
    expect(plan.issues).toEqual(
      expect.arrayContaining([
        'dataDir must be a non-empty NUL-free path',
        `request-media root ${sha256} is missing artifactUri`,
      ]),
    )
    expect(plan.eligibleForDeletion).toEqual([])
  })
})
