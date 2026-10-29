import {
  AttachmentError,
  type ContentBlock,
  IncrementalSha256,
  sha256Hex,
  uploadedAttachment,
} from '@agnes/protocol'
import type { SessionImpl } from '../step/session.js'
import { attachmentOperation } from './attachment-operation.js'

/** Preserve workspace uploads, but never persist a client URI as proof that its bytes exist. */
export async function validateWorkspaceUploads(
  session: SessionImpl,
  content: ContentBlock[],
  signal: AbortSignal,
): Promise<void> {
  const uploads = content.flatMap((block) =>
    block.type === 'resource_link' && uploadedAttachment(block.uri) ? [uploadedAttachment(block.uri)!] : [],
  )
  if (!uploads.length) return
  const port = session.d.workspaceInvocation
  if (!port) throw new AttachmentError('ATTACHMENT_NOT_AUTHORIZED')
  for (const upload of uploads) {
    if (upload.session !== sha256Hex(session.key)) throw new AttachmentError('ATTACHMENT_NOT_AUTHORIZED')
    await attachmentOperation(
      port.run(async (view) => {
        const fs = view.fs()
        const stat = await fs.stat(upload.path)
        if (stat.kind !== 'file' || stat.size !== upload.size) throw new AttachmentError('ATTACHMENT_DATA')
        const digest = new IncrementalSha256()
        for (let at = 0; at < upload.size; ) {
          signal.throwIfAborted()
          const bytes = await fs.read(upload.path, {
            offset: at,
            limit: Math.min(64 * 1024, upload.size - at),
          })
          if (!bytes.length || bytes.length > Math.min(64 * 1024, upload.size - at))
            throw new AttachmentError('ATTACHMENT_DATA')
          digest.update(bytes)
          at += bytes.length
        }
        signal.throwIfAborted()
        if ((await fs.stat(upload.path)).size !== upload.size) throw new AttachmentError('ATTACHMENT_DATA')
        if (digest.digest() !== upload.sha256) throw new AttachmentError('ATTACHMENT_HASH_MISMATCH')
      }),
      signal,
    )
  }
}
