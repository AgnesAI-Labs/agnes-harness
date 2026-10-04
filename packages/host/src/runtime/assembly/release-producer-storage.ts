import { createHash, randomUUID } from 'node:crypto'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { PublicRef } from '@agnes/protocol/runtime'
import type { BlobService } from '../providers/blob.js'
import { MaintenanceFailure } from './maintenance-journal.js'
import { equal, readWire, requireRelease } from './primitives.js'

import type { RetainedPublicationObject } from './release-producer-reference-codec.js'

export type { RetainedPublicationObject } from './release-producer-reference-codec.js'
/** Supplied by the trusted installer. This adapter cannot authenticate an installation or delegation. */
export interface PublicationObjectStore {
  retain(body: Uint8Array, context: CallContext): Promise<RetainedPublicationObject>
  read(reference: RetainedPublicationObject, context: CallContext): Promise<Uint8Array>
}
const unwrap = <T>(outcome: Outcome<T>): T => {
  if (!outcome.ok) throw new MaintenanceFailure(outcome.error)
  return outcome.value
}
export const publicationBytesDigest = (body: Uint8Array) => createHash('sha256').update(body).digest('hex')

/** Reuses the original Blob owner's upload, indefinite pin and checked read paths. */
export function createPublicationObjectStore(
  blob: BlobService,
  originalOwner: PublicRef,
): PublicationObjectStore {
  const owner = readWire('PublicRef', originalOwner)
  const read = async (input: RetainedPublicationObject, context: CallContext) => {
    const ref = readWire('BlobRef', input.location)
    requireRelease(
      input.retentionRevision === 1 && equal(input.owner, owner),
      'producer_retention_missing',
      '/publication/storage',
    )
    const proof = unwrap(await blob.inspect({ ref: { kind: 'blob', value: ref } }, context))
    requireRelease(
      proof.status === 'pinned' &&
        proof.digest === ref.digest &&
        proof.bytes === ref.bytes &&
        proof.ownerRefs.some((row) => equal(row, owner)) &&
        (await blob.holds(ref)),
      'producer_retention_missing',
      '/publication/storage',
    )
    const stream = unwrap(await blob.blobRead.openRead({ ref, offset: 0 }, context))
    const chunks: Buffer[] = []
    try {
      for await (const chunk of stream.chunks) chunks.push(Buffer.from(chunk))
      unwrap(await stream.ended)
    } finally {
      await stream.close()
    }
    const body = Buffer.concat(chunks)
    requireRelease(
      body.length === ref.bytes && publicationBytesDigest(body) === ref.digest,
      'producer_object_mismatch',
      '/publication/storage',
    )
    // Recheck this exact pin after the stream, including revocation during an empty read.
    const after = unwrap(await blob.inspect({ ref: { kind: 'blob', value: ref } }, context))
    requireRelease(
      after.status === 'pinned' && after.ownerRefs.some((row) => equal(row, owner)),
      'producer_retention_missing',
      '/publication/storage',
    )
    return body
  }
  return {
    read,
    async retain(input, context) {
      const body = Buffer.from(input),
        expectedDigest = publicationBytesDigest(body)
      const uploadId = randomUUID()
      unwrap(
        await blob.stage(
          { uploadId, size: body.length, mediaType: 'application/octet-stream', expectedDigest },
          context,
        ),
      )
      const writer = unwrap(blob.openWriter(uploadId, context))
      let upload: import('@agnes/protocol/runtime').UploadResult
      try {
        for (let at = 0; at < body.length; at += 1024 * 1024)
          unwrap(writer.write(at, body.subarray(at, at + 1024 * 1024)))
        upload = unwrap(await writer.seal())
      } finally {
        writer.close()
      }
      const stagedBlob = unwrap(await blob.promote({ upload: upload.upload, expectedDigest }, context))
      const location = unwrap(await blob.pin({ stagedBlob, ownerRef: owner, retentionUntil: null }, context))
      const reference: RetainedPublicationObject = { location, owner, retentionRevision: 1 }
      requireRelease(
        location.digest === expectedDigest && location.bytes === body.length,
        'producer_object_mismatch',
        '/publication/storage',
      )
      await read(reference, context)
      unwrap(await blob.unpin({ pinId: upload.retention.pinId, expectedRevision: 1 }, context))
      return reference
    },
  }
}
