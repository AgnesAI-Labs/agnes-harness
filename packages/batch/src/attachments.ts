import type { AttachmentScope, AttachmentStore } from '@agnes/extension-api'
import { BatchError, type InputReference } from './contracts.js'
import type { SnapshotArtifacts } from './enumerate.js'

const imageMime: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}
const mimeFor = (name: string): string =>
  imageMime[name.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'text/plain'
/**
 * bindScope must resolve a Host-prepared child scope; the batch/name pair is an identity hint, never a
 * session selector. Pending receipts stay pinned until Core commits that child's inbox input.
 */
export function attachmentSnapshots(
  store: AttachmentStore | undefined,
  bindScope: (input: { batch: string; name: string }) => Promise<AttachmentScope>,
  signal: AbortSignal,
): SnapshotArtifacts {
  if (!store) throw new BatchError('E_BATCH_ATTACHMENT_STORE_REQUIRED')
  const provider: AttachmentStore = store
  return {
    async put(bytes, metadata): Promise<InputReference> {
      signal.throwIfAborted()
      const scope = await bindScope({ batch: metadata.batch, name: metadata.name })
      const mime = mimeFor(metadata.name)
      const receipt = await provider.store(scope, bytes, mime, signal)
      try {
        if (
          receipt.artifact.sha256 !== metadata.digest ||
          receipt.artifact.size !== bytes.byteLength ||
          receipt.artifact.mime !== mime ||
          !(await provider.authorize(scope, receipt, signal))
        )
          throw new BatchError('E_BATCH_ATTACHMENT_RECEIPT')
        return { artifact: receipt.artifact, receipt: { id: receipt.id, scope } }
      } catch (error) {
        await provider.discard(scope, receipt.id)
        throw error
      }
    },
    async discard(input) {
      if (input.receipt) await provider.discard(input.receipt.scope, input.receipt.id)
    },
  }
}
