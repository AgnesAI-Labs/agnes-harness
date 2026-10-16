import type { ArtifactRef } from '../gen/ts/agnes-v1.js'
import type { ContentBlock } from '../gen/ts/session-v1.js'

export type StoredAttachment = Extract<ContentBlock, { type: 'resource_link' }> & {
  name: string
  mimeType: string
  attachment: {
    artifact: ArtifactRef
    image?: { width: number; height: number }
    thumbnail?: ArtifactRef
    receiptId?: string
  }
}

/** Shape guard only. Authorization requires a visible ledger row or an exact pending receipt. */
export function storedAttachment(block: ContentBlock): block is StoredAttachment {
  return block.type === 'resource_link' && block.attachment !== undefined
}

export function attachmentLink(
  artifact: ArtifactRef,
  name: string,
  options: Omit<StoredAttachment['attachment'], 'artifact'> = {},
): StoredAttachment {
  return {
    type: 'resource_link',
    uri: `artifact://${artifact.sha256}`,
    name,
    mimeType: artifact.mime,
    attachment: { artifact, ...options },
  }
}
