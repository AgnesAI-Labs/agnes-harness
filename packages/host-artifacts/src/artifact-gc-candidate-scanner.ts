import { createHash } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { artifactStorePath, type RetainedArtifactCandidate } from '@agnes/core/artifacts'
import {
  isMarkerWriteTemporary,
  parseComputerUseMarker,
  pathEntryExists,
  readPrivateMarker,
  removeMarkerWriteTemporary,
  validatePrivateMarkerDirectory,
} from './computer-use-marker.js'

const SHARD = /^[0-9a-f]{2}$/u

async function readRegularSingleLink(
  path: string,
  maximum: number,
): Promise<Readonly<{ bytes: Uint8Array; mtimeMs: number }>> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum)
      throw new Error('Computer Use artifact GC file identity is unsafe')
    return { bytes: await handle.readFile(), mtimeMs: Math.floor(stat.mtimeMs) }
  } finally {
    await handle.close()
  }
}

/**
 * Scans only artifacts explicitly classified at write time as Computer Use screenshots. Callers
 * hold the screenshot mutation lock.
 */
export async function scanComputerUseArtifactCandidates(
  dataDir: string,
): Promise<readonly RetainedArtifactCandidate[]> {
  const metadataRoot = join(dataDir, 'artifacts', 'computer-use-meta')
  let shards: Dirent[]
  try {
    shards = await readdir(metadataRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([])
    throw error
  }
  validatePrivateMarkerDirectory(metadataRoot)
  const candidates: RetainedArtifactCandidate[] = []
  for (const shard of shards.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!shard.isDirectory() || shard.isSymbolicLink() || !SHARD.test(shard.name))
      throw new Error('Computer Use artifact GC metadata tree contains an unsafe shard')
    const directory = join(metadataRoot, shard.name)
    validatePrivateMarkerDirectory(directory)
    const files = await readdir(directory, { withFileTypes: true })
    for (const file of files.sort((left, right) => left.name.localeCompare(right.name))) {
      // A marker write that crashed before its rename leaves its temporary behind.
      if (isMarkerWriteTemporary(file.name, shard.name)) {
        removeMarkerWriteTemporary(join(directory, file.name))
        continue
      }
      const match = /^([0-9a-f]{64})\.json$/u.exec(file.name)
      if (!file.isFile() || file.isSymbolicLink() || !match || match[1]?.slice(0, 2) !== shard.name)
        throw new Error('Computer Use artifact GC metadata tree contains an unsafe entry')
      const sha256 = match[1]
      const artifact = join(dataDir, 'artifacts', 'sha256', sha256.slice(0, 2), sha256)
      // Deleted or reclaimed bytes are not candidates; their markers are not read at all.
      if (!pathEntryExists(artifact)) continue
      const marker = parseComputerUseMarker(await readPrivateMarker(join(directory, file.name)), sha256)
      let read: Awaited<ReturnType<typeof readRegularSingleLink>>
      try {
        read = await readRegularSingleLink(artifact, marker.size)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (
        read.bytes.byteLength !== marker.size ||
        createHash('sha256').update(read.bytes).digest('hex') !== sha256
      )
        throw new Error('Computer Use artifact GC candidate content identity is inconsistent')
      candidates.push(
        Object.freeze({
          sha256,
          contentSha256: sha256,
          path: artifactStorePath(dataDir, sha256),
          bytes: marker.size,
          // Bytes republished over a tombstone keep its old creation time until the v1 marker lands;
          // the file time keeps them inside the grace window meanwhile.
          createdAtMs:
            marker.schemaVersion === 2 ? Math.max(marker.createdAtMs, read.mtimeMs) : marker.createdAtMs,
        }),
      )
    }
  }
  return Object.freeze(candidates)
}
