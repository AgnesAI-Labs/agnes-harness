import { createHash, randomUUID } from 'node:crypto'
import type {
  AttachmentReceipt,
  AttachmentScope,
  AttachmentStore,
  PersistenceMetadataNamespace,
} from '@agnes/extension-api'
import { type ArtifactRef, AttachmentError } from '@agnes/protocol'

const MAX_PENDING_BYTES = 512 * 1024 * 1024
const MAX_PENDING = 1024
const TTL = 24 * 60 * 60 * 1000
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu
const scopeKey = (scope: AttachmentScope) => JSON.stringify([scope.sessionKey, scope.lane])
type Receipt = AttachmentReceipt & { scope: string; expires: number }
const validRef = (ref: ArtifactRef) =>
  ref &&
  /^[a-f0-9]{64}$/u.test(ref.sha256) &&
  Number.isSafeInteger(ref.size) &&
  ref.size >= 0 &&
  typeof ref.mime === 'string' &&
  ref.mime.length <= 128 &&
  MIME.test(ref.mime)

/** Metadata and bytes use the selected providers, not a second Core-owned file store. */
export function createAttachmentStore(
  metadata: PersistenceMetadataNamespace,
  bytes: { put(bytes: Uint8Array, meta: { mime: string }): Promise<ArtifactRef> },
  putStream?: (
    artifact: ArtifactRef,
    source: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ) => Promise<void>,
): AttachmentStore {
  const entries = (): Receipt[] =>
    metadata.entries().map(({ key, value }) => {
      const row = value as Receipt
      if (
        !row ||
        row.id !== key ||
        !/^[a-f0-9-]{36}$/u.test(key) ||
        !validRef(row.artifact) ||
        typeof row.scope !== 'string' ||
        !Number.isSafeInteger(row.expires)
      )
        throw new AttachmentError('ATTACHMENT_UNAVAILABLE')
      return row
    })
  const remove = (scope: AttachmentScope, id: string) =>
    metadata.transaction(() => {
      const row = metadata.get(id) as Receipt | undefined
      if (!row) return
      if (row.scope !== scopeKey(scope)) throw new AttachmentError('ATTACHMENT_NOT_AUTHORIZED')
      metadata.delete(id)
    })
  const reserve = (scope: AttachmentScope, id: string, artifact: ArtifactRef) => {
    metadata.transaction(() => {
      const rows = entries()
      for (const row of rows) if (row.expires <= Date.now()) metadata.delete(row.id)
      const pending = rows.filter((row) => row.expires > Date.now())
      if (
        pending.length >= MAX_PENDING ||
        pending
          .filter((row) => row.scope === scopeKey(scope))
          .reduce((n, row) => n + row.artifact.size, artifact.size) > MAX_PENDING_BYTES
      )
        throw new AttachmentError('ATTACHMENT_QUOTA')
      metadata.set(id, { id, artifact, scope: scopeKey(scope), expires: Date.now() + TTL })
    })
  }
  return {
    ...(putStream
      ? {
          async storeStream(
            scope: AttachmentScope,
            source: AsyncIterable<Uint8Array>,
            artifact: ArtifactRef,
            signal: AbortSignal,
          ) {
            signal.throwIfAborted()
            if (!scope.sessionKey || !scope.lane || !validRef(artifact))
              throw new AttachmentError('ATTACHMENT_DATA')
            if (artifact.size > 100 * 1024 * 1024) throw new AttachmentError('ATTACHMENT_BYTES')
            const snapshot = { ...artifact }
            const id = randomUUID()
            reserve(scope, id, snapshot)
            try {
              await putStream(snapshot, source, signal)
              signal.throwIfAborted()
              return { id, artifact: snapshot }
            } catch (error) {
              remove(scope, id)
              if (signal.aborted) throw new AttachmentError('ATTACHMENT_CANCELLED')
              throw error instanceof AttachmentError ? error : new AttachmentError('ATTACHMENT_UNAVAILABLE')
            }
          },
        }
      : {}),
    async store(scope, data, mime, signal) {
      signal.throwIfAborted()
      if (!scope.sessionKey || !scope.lane || !MIME.test(mime) || mime.length > 128)
        throw new AttachmentError('ATTACHMENT_DATA')
      if (data.byteLength > 100 * 1024 * 1024) throw new AttachmentError('ATTACHMENT_BYTES')
      // Copy before the first await so a producer cannot mutate the admitted buffer.
      const snapshot = data.slice()
      const id = randomUUID()
      // Reserve quota before asynchronous storage. This also protects bytes published before the
      // caller's inbox commit; failed publication leaves a bounded, expiring conservative root.
      const artifact = {
        sha256: createHash('sha256').update(snapshot).digest('hex'),
        size: snapshot.length,
        mime,
      }
      reserve(scope, id, artifact)
      try {
        signal.throwIfAborted()
        const stored = await bytes.put(snapshot, { mime })
        signal.throwIfAborted()
        if (stored.sha256 !== artifact.sha256 || stored.size !== artifact.size || stored.mime !== mime)
          throw new AttachmentError('ATTACHMENT_HASH_MISMATCH')
        return { id, artifact }
      } catch (error) {
        remove(scope, id)
        if (signal.aborted) throw new AttachmentError('ATTACHMENT_CANCELLED')
        throw error instanceof AttachmentError ? error : new AttachmentError('ATTACHMENT_UNAVAILABLE')
      }
    },
    async authorize(scope, receipt, signal) {
      signal.throwIfAborted()
      const row = entries().find((entry) => entry.id === receipt.id)
      return (
        !!row &&
        row.scope === scopeKey(scope) &&
        row.expires > Date.now() &&
        row.artifact.sha256 === receipt.artifact.sha256 &&
        row.artifact.size === receipt.artifact.size &&
        row.artifact.mime === receipt.artifact.mime
      )
    },
    async confirm(scope, id) {
      remove(scope, id)
    },
    async discard(scope, id) {
      remove(scope, id)
    },
    async pendingRoots() {
      // Do not turn corruption/unavailable metadata into an empty complete snapshot.
      try {
        const roots = entries()
          .filter((row) => row.expires > Date.now())
          .map((row) => row.artifact)
        return { complete: true, roots }
      } catch {
        return { complete: false, roots: [] }
      }
    },
  }
}
