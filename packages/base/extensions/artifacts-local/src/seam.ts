import { createHash } from 'node:crypto'
import type { ArtifactRef, ArtifactsSeam } from '@agnes/core'
import type { SeamFactory } from '../../../src/seam-init.js'
import { createJobRunner } from './jobs.js'

const ARTIFACTS = 'artifacts/sha256'
const COMPUTER_USE_METADATA = 'artifacts/computer-use-meta'
const SHA256 = /^[0-9a-f]{64}$/

function computerUseArtifactName(value: string | undefined): boolean {
  return value === 'computer-use-screenshot.png' || value === 'computer-use-screenshot.jpg'
}

function metadataBytes(sha256: string, size: number, createdAtMs: number): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({ schemaVersion: 1, sha256, size, createdAtMs }, null, 2)}\n`,
  )
}

function snapshotArtifactIdentity(ref: ArtifactRef): { sha256: string; size: number } {
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref))
    throw new Error('invalid artifact ref: expected a plain object')
  const proto = Object.getPrototypeOf(ref)
  if (proto !== Object.prototype && proto !== null)
    throw new Error('invalid artifact ref: expected a plain object')
  const descriptors = Object.getOwnPropertyDescriptors(ref)
  const shaDescriptor = descriptors.sha256
  const sizeDescriptor = descriptors.size
  if (!shaDescriptor || !('value' in shaDescriptor) || !sizeDescriptor || !('value' in sizeDescriptor))
    throw new Error('invalid artifact ref: identity fields must be own data properties')
  const sha256: unknown = shaDescriptor.value
  const size: unknown = sizeDescriptor.value
  if (typeof sha256 !== 'string' || !SHA256.test(sha256))
    throw new Error('invalid artifact ref: sha256 must be 64 lowercase hex characters')
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
    throw new Error('invalid artifact ref: size must be a non-negative safe integer')
  return { sha256, size }
}

/**
 * Content-addressed bytes under the installation's own data directory, two hex characters of fan-out
 * so one directory does not end up holding every artifact a machine has ever produced.
 *
 * It writes through `dataFs`, not `fs`: the store lives beside the session database, which on a
 * normal machine is `~/.agh` and therefore outside the workspace the file seam is fenced to.
 */
export const artifactsLocal: SeamFactory<ArtifactsSeam> = async (ctx) => {
  const fs = ctx.adapters.dataFs
  const pathOf = (sha256: string): string =>
    `${ctx.profile.dataDir}/${ARTIFACTS}/${sha256.slice(0, 2)}/${sha256}`
  const jobs = createJobRunner(ctx)
  return {
    async put(bytes, meta) {
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const at = pathOf(sha256)
      const isComputerUse = computerUseArtifactName(meta?.name)
      const metadata = `${ctx.profile.dataDir}/${COMPUTER_USE_METADATA}/${sha256.slice(0, 2)}/${sha256}.json`
      // Written once. A second put of the same bytes is the same file, so it is skipped rather than
      // rewritten - and the skip is decided by asking whether the file is there, which is the only
      // question whose answer does not depend on what this process has done before.
      let present = true
      try {
        await fs.stat(at)
      } catch {
        present = false
      }
      if (ctx.privateArtifactStore && isComputerUse) {
        // Classify the digest before making screenshot bytes reachable. A metadata failure must not
        // leave an unclassified CAS file that the retention scanner can never discover. A marker
        // that briefly precedes its bytes is harmless: the scanner ignores a missing CAS target.
        // A reclaim tombstone for bytes that are still gone is kept here; `put` replaces it only
        // after the bytes are back.
        await ctx.privateArtifactStore.putComputerUseMetadata(
          sha256,
          metadataBytes(sha256, bytes.byteLength, Date.now()),
        )
      }
      if (ctx.privateArtifactStore) {
        // On GC-capable platforms the whole shared CAS is private from its first write. That avoids
        // a prior ordinary artifact creating a broad-permission shard before CU uses the same hash.
        await ctx.privateArtifactStore.put(sha256, bytes)
      } else if (!present) {
        await fs.mkdir(at.slice(0, at.lastIndexOf('/')))
        await fs.write(at, bytes)
      }
      if (isComputerUse && !ctx.privateArtifactStore) {
        let metadataPresent = true
        try {
          await fs.stat(metadata)
        } catch {
          metadataPresent = false
        }
        // Legacy screenshot bytes get a fresh conservative timestamp when first observed instead
        // of inheriting a filesystem timestamp that may predate the retention contract.
        if (!metadataPresent) {
          await fs.mkdir(metadata.slice(0, metadata.lastIndexOf('/')))
          await fs.write(metadata, metadataBytes(sha256, bytes.byteLength, Date.now()))
        }
      }
      const ref: ArtifactRef = {
        sha256,
        size: bytes.byteLength,
        mime: meta?.mime ?? 'application/octet-stream',
      }
      return ref
    },
    async get(ref) {
      // The digest is also a path component. Reject malformed identities before touching dataFs so
      // a caller cannot turn an ArtifactRef into an alternate path within the data directory.
      const identity = snapshotArtifactIdentity(ref)
      const at = pathOf(identity.sha256)
      let bytes: Uint8Array
      try {
        const stat = await fs.stat(at)
        if (stat.kind !== 'file' || stat.size !== identity.size)
          throw new Error(`artifact size mismatch: ${identity.sha256}`)
        bytes = await fs.read(at)
      } catch (e) {
        // Only a missing file is "not found". A permission error, a refused path or a failing disk
        // is re-thrown as itself: reporting those as an absent artifact would have a caller decide
        // the bytes were never stored and quietly produce them again.
        if ((e as { code?: unknown }).code === 'ENOENT')
          throw new Error(`artifact not found: ${identity.sha256}`)
        throw e
      }
      // A content-addressed filename is not evidence about the bytes currently at that path. This
      // catches corruption and swap/tamper before media preflight or any other consumer can use it.
      const actualSha256 = createHash('sha256').update(bytes).digest('hex')
      if (actualSha256 !== identity.sha256) throw new Error(`artifact integrity mismatch: ${identity.sha256}`)
      if (bytes.byteLength !== identity.size) throw new Error(`artifact size mismatch: ${identity.sha256}`)
      return bytes
    },
    submitJob: (spec) => jobs.submit(spec),
    poll: (jobId) => jobs.poll(jobId),
    cancel: (jobId) => jobs.cancel(jobId),
  }
}
