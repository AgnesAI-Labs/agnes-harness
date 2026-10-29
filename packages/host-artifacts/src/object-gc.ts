import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { artifactStorePath, createArtifactGcScheduler, planArtifactGc } from '@agnes/core/artifacts'
import type { AttachmentRootSnapshot } from '@agnes/extension-api'
import { deletePrivateArtifactSync } from '@agnes/system-node'
import { computerUseArtifactRootSnapshot } from './artifact-gc-roots-sqlite.js'
import {
  catchUpArtifactRefIndex,
  openArtifactRefIndex,
  verifyRootsUnderLedgerLock,
} from './artifact-ref-index.js'
import { readPrivateMarker, validatePrivateMarkerDirectory } from './computer-use-marker.js'
import { withComputerUseArtifactMutation } from './private-artifact-store.js'

const GRACE_MS = 24 * 60 * 60 * 1000
const inputRoot = (dataDir: string) => join(dataDir, 'artifacts', 'sha256')
const HASH = /^[a-f0-9]{64}$/u

/** One original at a time, hashed in bounded windows; no original-sized GC allocation. */
export async function scanStoredObjects(dataDir: string, now: number) {
  const root = join(dataDir, 'artifacts', 'object-meta')
  let shards: string[]
  try {
    shards = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  validatePrivateMarkerDirectory(root)
  const candidates: {
    sha256: string
    contentSha256: string
    path: string
    size: number
    createdAtMs: number
  }[] = []
  for (const shard of shards) {
    if (!/^[a-f0-9]{2}$/u.test(shard)) throw new Error('Artifact object inventory is malformed')
    const dir = join(root, shard)
    validatePrivateMarkerDirectory(dir)
    for (const name of await readdir(dir)) {
      // Private atomic publication may leave a temporary after a crash; it never names CAS bytes.
      if (/^\.[a-f0-9-]{36}\.tmp$/u.test(name)) continue
      const hash = name.slice(0, -5)
      if (!name.endsWith('.json') || !HASH.test(hash) || hash.slice(0, 2) !== shard)
        throw new Error('Artifact object marker is malformed')
      const marker = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(await readPrivateMarker(join(dir, name))),
      ) as { schemaVersion: number; sha256: string; size: number; createdAtMs: number }
      if (
        marker.schemaVersion !== 1 ||
        marker.sha256 !== hash ||
        !Number.isSafeInteger(marker.size) ||
        marker.size < 0 ||
        !Number.isSafeInteger(marker.createdAtMs) ||
        marker.createdAtMs < 0
      )
        throw new Error('Artifact object marker is malformed')
      if (now - marker.createdAtMs < GRACE_MS) continue
      const path = join(dataDir, 'artifacts', 'sha256', shard, hash)
      let handle: Awaited<ReturnType<typeof open>>
      try {
        validatePrivateMarkerDirectory(join(inputRoot(dataDir), shard))
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== marker.size)
          throw new Error('Artifact object identity mismatch')
        const digest = createHash('sha256'),
          bytes = new Uint8Array(64 * 1024)
        for (let at = 0; at < stat.size; ) {
          const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, stat.size - at), at)
          if (!bytesRead) throw new Error('Artifact object was truncated')
          digest.update(bytes.subarray(0, bytesRead))
          at += bytesRead
        }
        const after = await handle.stat()
        if (
          digest.digest('hex') !== hash ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          throw new Error('Artifact object integrity mismatch')
        candidates.push({
          sha256: hash,
          contentSha256: hash,
          path: artifactStorePath(dataDir, hash),
          size: stat.size,
          createdAtMs: marker.createdAtMs,
        })
      } finally {
        await handle.close()
      }
    }
  }
  return candidates
}

/** General CAS collection never reclaims reachable originals, even under capacity pressure. */
export function createStoredObjectGc(input: {
  dataDir: string
  pendingRoots?: () => Promise<AttachmentRootSnapshot>
  onError(error: unknown): void
}) {
  return createArtifactGcScheduler(
    async () => {
      await withComputerUseArtifactMutation(input.dataDir, async () => {
        const candidates = await scanStoredObjects(input.dataDir, Date.now())
        if (!candidates.length) return
        // No database means no proof of absence. Opening a missing ledger must never create one.
        const { existsSync } = await import('node:fs')
        const ledgerPath = join(input.dataDir, 'sessions.db')
        if (!existsSync(ledgerPath)) throw new Error('Artifact ledger roots are unavailable')
        const ledger = new DatabaseSync(ledgerPath)
        let index: DatabaseSync
        try {
          index = await openArtifactRefIndex(input.dataDir)
        } catch (error) {
          ledger.close()
          throw error
        }
        try {
          await catchUpArtifactRefIndex({ ledger, index, signal: AbortSignal.timeout(30_000) })
          ledger.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE')
          try {
            const digests = new Set(candidates.map((candidate) => candidate.sha256))
            const verified = await verifyRootsUnderLedgerLock({
              ledger,
              index,
              candidates: digests,
              waitMs: 1000,
            })
            if (!verified) throw new Error('Artifact reference inventory is incomplete')
            const pending = await input.pendingRoots?.()
            if (
              pending &&
              (!pending.complete ||
                !Array.isArray(pending.roots) ||
                pending.roots.some(
                  (ref) => !ref || !HASH.test(ref.sha256) || !Number.isSafeInteger(ref.size) || ref.size < 0,
                ))
            )
              throw new Error('Artifact receipt inventory is incomplete')
            const roots = await computerUseArtifactRootSnapshot({
              candidateDigests: digests,
              roots: verified,
              retention: new Set(pending?.roots.map((ref) => ref.sha256)),
            })
            const plan = planArtifactGc({ dataDir: input.dataDir, candidates, roots: roots.roots })
            if (plan.blocked) throw new Error('Artifact reachability proof is incomplete')
            let count = 0,
              deletedBytes = 0
            for (const entry of plan.eligibleForDeletion) {
              const size = candidates.find((candidate) => candidate.sha256 === entry.sha256)?.size ?? 0
              if (count >= 8 || (count > 0 && deletedBytes + size > 32 * 1024 * 1024)) break
              deletedBytes += deletePrivateArtifactSync(
                join(input.dataDir, 'artifacts', 'sha256'),
                `${entry.sha256.slice(0, 2)}/${entry.sha256}`,
                entry.sha256,
              )
              count++
            }
            ledger.exec('COMMIT')
          } catch (error) {
            ledger.exec('ROLLBACK')
            throw error
          }
        } finally {
          index.close()
          ledger.close()
        }
      })
    },
    { intervalMs: 3_600_000, onError: input.onError },
  )
}
