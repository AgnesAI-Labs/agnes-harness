import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type BuildIdentity,
  type ConformanceHarness,
  providerFileForContract,
} from '@agnes/extension-api/testkit'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import {
  type BlobContractPort,
  blobContractPort,
  createBlobReadGate,
  registerBlobContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/blob.js'
import { BLOB_PROVIDER, openBlobStore, PIECE_BYTES } from './blob.js'

const sha256 = (url: URL) => createHash('sha256').update(readFileSync(url)).digest('hex')

export const build: BuildIdentity = {
  codeSha: 'reference-code',
  buildDigest: 'reference-build',
  lockDigest: 'reference-lock',
  specVersion: 'reference-spec',
  sdkVersion: 'reference-sdk',
  sdkDigest: 'reference-sdk-digest',
  platform: 'reference-platform',
}

export const releaseSetDigest = () => sha256(new URL('../../package.json', import.meta.url))

/**
 * Overwrites the stored pieces of one object behind the store's back. The recorded piece digests stay,
 * and pieces past the new length are dropped, as a damaged or truncated backend would leave them.
 */
export function damage(databasePath: string, blobId: string, bytes: Uint8Array): void {
  const db = new DatabaseSync(databasePath)
  try {
    db.prepare('DELETE FROM pieces WHERE blob_id = ? AND seq * ? >= ?').run(
      blobId,
      PIECE_BYTES,
      bytes.byteLength,
    )
    const update = db.prepare('UPDATE pieces SET data = ? WHERE blob_id = ? AND seq = ?')
    for (let seq = 0; seq * PIECE_BYTES < bytes.byteLength; seq++)
      update.run(bytes.subarray(seq * PIECE_BYTES, (seq + 1) * PIECE_BYTES), blobId, seq)
  } finally {
    db.close()
  }
}

/** Drives the reference blob store through the six scenarios; the contract module judges what it reports. */
export function referenceBlobPort(
  databasePath: string,
  providerId: string = BLOB_PROVIDER.id,
): { port: BlobContractPort; close(): void } {
  const gate = createBlobReadGate()
  const options = { authorizeRead: gate.allows }
  let current = openBlobStore(databasePath, options)
  const port = blobContractPort({
    binding: {
      requirement: {
        contract: 'agh.blob',
        major: 1,
        logicalName: `blob-${providerId}`,
        features: ['blob-read.v1'],
        scope: 'runtime',
        optional: false,
      },
      binding: {
        bindingId: `reference-blob-${providerId}`,
        contract: 'agh.blob',
        logicalName: `blob-${providerId}`,
        providerId,
      },
      blobRead: current.blobRead,
    },
    gate,
    read: () => current.blobRead,
    seed: async (bytes) => current.seed(bytes),
    corrupt: async (ref, bytes) => damage(databasePath, ref.blobId, bytes),
    async reopen() {
      current.close()
      current = openBlobStore(databasePath, options)
    },
    close: async () => current.close(),
    remains: () => existsSync(databasePath),
  })
  return { port, close: () => current.close() }
}

/**
 * Registers the six blob cases for the reference provider on a fresh database, reported under
 * `providerId` (the runner passes the name it was asked for, such as `reference`). `change` lets a
 * test break one scenario to prove the contract notices. Call `close` after the harness has run.
 */
export function bindBlobContract(
  harness: ConformanceHarness,
  command: string,
  options: Readonly<{ providerId?: string; change?: (port: BlobContractPort) => BlobContractPort }> = {},
): { close(): void } {
  const providerId = options.providerId ?? BLOB_PROVIDER.id
  const directory = mkdtempSync(join(tmpdir(), 'reference-blob-contract-'))
  const reference = referenceBlobPort(join(directory, 'blob.sqlite'), providerId)
  registerBlobContract(harness, {
    providerId,
    recipe: providerFileForContract('agh.blob'),
    command,
    build,
    providerDigest: sha256(new URL('./blob.ts', import.meta.url)),
    configDigest: canonicalJsonDigest({ pieceBytes: PIECE_BYTES }),
    releaseSetDigest: releaseSetDigest(),
    port: options.change ? options.change(reference.port) : reference.port,
  })
  return {
    close() {
      reference.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
