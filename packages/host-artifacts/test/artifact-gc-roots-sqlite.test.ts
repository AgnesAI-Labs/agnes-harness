import { describe, expect, it } from 'vitest'
import { computerUseArtifactRootSnapshot } from '../src/artifact-gc-roots-sqlite.js'

const digest = (character: string) => character.repeat(64)

describe('Computer Use artifact root snapshot', () => {
  it('keeps indexed ledger and request-media roots of candidates and declares absent producers empty', async () => {
    const ledger = digest('a')
    const request = digest('b')
    const ignored = digest('c')
    const input = {
      candidateDigests: new Set([ledger, request, ignored]),
      roots: { ledger: new Set([ledger, request, digest('f')]), requestMedia: new Set([request]) },
    }
    const first = await computerUseArtifactRootSnapshot(input)
    const second = await computerUseArtifactRootSnapshot(input)
    expect(first).toEqual(second)
    expect(first.roots.ledger.roots.map((root) => root.sha256)).toEqual([ledger, request])
    expect(first.roots['request-media'].roots).toEqual([
      { sha256: request, artifactUri: `artifact://${request}` },
    ])
    expect(first.roots.export.roots).toEqual([])
    expect(first.roots.retention.roots).toEqual([])
    expect(first.roots.rollback.roots).toEqual([])
    expect(first.identity.hash).toMatch(/^[a-f0-9]{64}$/u)
    // The epoch no longer depends on ledger size; only the roots distinguish two snapshots.
    const other = await computerUseArtifactRootSnapshot({
      ...input,
      roots: { ledger: new Set([ledger]), requestMedia: new Set([request]) },
    })
    expect(other.identity.epoch).toBe(first.identity.epoch)
    expect(other.identity.hash).not.toBe(first.identity.hash)
  })

  it('fails closed for a nonempty store without a root database', async () => {
    await expect(
      computerUseArtifactRootSnapshot({ candidateDigests: new Set([digest('e')]) }),
    ).rejects.toThrow(/database/)
    const empty = await computerUseArtifactRootSnapshot({ candidateDigests: new Set() })
    expect(
      Object.values(empty.roots).every((snapshot) => snapshot.complete && snapshot.roots.length === 0),
    ).toBe(true)
  })
})
