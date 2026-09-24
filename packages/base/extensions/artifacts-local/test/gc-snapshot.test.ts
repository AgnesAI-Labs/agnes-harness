import { describe, expect, it, vi } from 'vitest'
import { type ArtifactGcRootOwner, collectArtifactGcFiveSourceSnapshot } from '../src/gc-snapshot.js'
import { ARTIFACT_ROOT_SOURCES, type ArtifactRootSource } from '../src/reachability.js'

const digest = (character: string) => character.repeat(64)

function owners(overrides: Partial<Record<ArtifactRootSource, ArtifactGcRootOwner>> = {}) {
  return ARTIFACT_ROOT_SOURCES.map(
    (source, index) =>
      overrides[source] ?? {
        source,
        snapshot: vi.fn(async () => ({
          complete: true as const,
          epoch: `${source}-1`,
          roots: [
            {
              sha256: digest(String(index + 1)),
              ...(source === 'request-media'
                ? { artifactUri: `artifact://${digest(String(index + 1))}` }
                : {}),
            },
          ],
        })),
      },
  )
}

describe('five-source artifact GC snapshots', () => {
  it('binds all five complete owner epochs and sorted roots into a stable identity', async () => {
    const first = await collectArtifactGcFiveSourceSnapshot(owners())
    const second = await collectArtifactGcFiveSourceSnapshot(owners())
    expect(first).toEqual(second)
    expect(first.identity.epoch).toMatch(/^roots-v1-[a-f0-9]{64}$/)
    expect(first.identity.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.keys(first.roots).sort()).toEqual([...ARTIFACT_ROOT_SOURCES].sort())
  })

  it('fails closed for a missing, duplicate, incomplete, or malformed owner', async () => {
    await expect(collectArtifactGcFiveSourceSnapshot(owners().slice(1))).rejects.toThrow(/exactly one/)
    const duplicate = owners()
    duplicate[1] = duplicate[0] as ArtifactGcRootOwner
    await expect(collectArtifactGcFiveSourceSnapshot(duplicate)).rejects.toThrow(/exactly one/)
    await expect(
      collectArtifactGcFiveSourceSnapshot(
        owners({
          ledger: { source: 'ledger', snapshot: async () => ({ complete: false, epoch: 'x', roots: [] }) },
        }),
      ),
    ).rejects.toThrow(/incomplete/)
    await expect(
      collectArtifactGcFiveSourceSnapshot(
        owners({
          'request-media': {
            source: 'request-media',
            snapshot: async () => ({ complete: true, epoch: 'x', roots: [{ sha256: digest('a') }] }),
          },
        }),
      ),
    ).rejects.toThrow(/artifact URI/)
  })
})
