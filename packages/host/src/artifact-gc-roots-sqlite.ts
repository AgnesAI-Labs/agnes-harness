import {
  type ArtifactGcFiveSourceSnapshot,
  type ArtifactRoot,
  collectArtifactGcFiveSourceSnapshot,
} from '@agnes/core/artifacts'
import { nodeArtifactGcPreparationRuntime } from '@agnes/system-node'
import type { IndexedRoots } from './artifact-ref-index.js'

function roots(
  values: ReadonlySet<string>,
  targets: ReadonlySet<string>,
  requestMedia = false,
): readonly ArtifactRoot[] {
  return [...values]
    .filter((sha256) => targets.has(sha256))
    .sort()
    .map((sha256) =>
      Object.freeze({ sha256, ...(requestMedia ? { artifactUri: `artifact://${sha256}` } : {}) }),
    )
}

/**
 * Five-source snapshot for Computer Use candidates. Ledger and request-media roots come from the
 * reference index (or its locked re-verification); retention roots are the screenshots active
 * sessions still need. Export and rollback are explicitly empty: exports do not detach bytes from
 * their ledger and there is no rollback artifact owner. Without a ledger database, only an empty
 * candidate set is collectable.
 */
export async function computerUseArtifactRootSnapshot(
  input: Readonly<{
    candidateDigests: ReadonlySet<string>
    roots?: IndexedRoots
    /** Screenshots active sessions still need; retention never evicts them. */
    retention?: ReadonlySet<string>
  }>,
): Promise<ArtifactGcFiveSourceSnapshot> {
  if (!input.roots && input.candidateDigests.size !== 0)
    throw new Error('artifact GC durable root database is unavailable')
  const epoch = input.roots ? 'ref-index-v1' : 'empty-v1'
  const fixed = (source: 'ledger' | 'request-media', sourceRoots: readonly ArtifactRoot[]) => ({
    source,
    snapshot: async () => ({ complete: true as const, epoch, roots: sourceRoots }),
  })
  const empty = (source: 'export' | 'rollback') => ({
    source,
    snapshot: async () => ({
      complete: true as const,
      epoch: input.roots ? 'none-v1' : 'empty-v1',
      roots: [],
    }),
  })
  return collectArtifactGcFiveSourceSnapshot(
    [
      fixed('ledger', input.roots ? roots(input.roots.ledger, input.candidateDigests) : []),
      fixed(
        'request-media',
        input.roots ? roots(input.roots.requestMedia, input.candidateDigests, true) : [],
      ),
      empty('export'),
      {
        source: 'retention' as const,
        snapshot: async () => ({
          complete: true as const,
          epoch: input.roots ? 'retention-v1' : 'empty-v1',
          roots: input.roots ? roots(input.retention ?? new Set(), input.candidateDigests) : [],
        }),
      },
      empty('rollback'),
    ],
    nodeArtifactGcPreparationRuntime.sha256Utf8,
  )
}
