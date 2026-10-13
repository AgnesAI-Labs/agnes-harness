import type { ContentBlock } from '../gen/ts/session-v1.js'
import { attachmentForm } from './attachment-blocks.js'
import { META_KEY } from './constants.js'

const PREFIX = 'agnes-attachment:'
const LINK = 'artifact://'

/**
 * ACP has no attachment reference, so one travels as a link to the stored object that carries the
 * block itself in its `_meta`; the receiving end checks it like any reference a client sends.
 */
function referenceLink(block: ContentBlock): unknown {
  const ref = block as {
    type: 'image' | 'file'
    mimeType: string
    name?: string
    attachment: { sha256: string; bytes: number }
  }
  return {
    type: 'resource_link',
    uri: `${LINK}${ref.attachment.sha256}`,
    name: ref.name ?? 'image',
    mimeType: ref.mimeType,
    size: ref.attachment.bytes,
    _meta: { [META_KEY]: { attachment: block } },
  }
}

/** The reference block a link from `referenceLink` carries, when it is one and names its own link. */
function linkedReference(block: { type?: string; uri?: unknown; _meta?: unknown }): ContentBlock | undefined {
  if (block.type !== 'resource_link') return undefined
  const carried = (block._meta as Record<string, { attachment?: unknown } | undefined> | null | undefined)?.[
    META_KEY
  ]?.attachment
  if (attachmentForm(carried) !== 'reference') return undefined
  const ref = carried as { attachment: { sha256: string } }
  return block.uri === `${LINK}${ref.attachment.sha256}` ? (carried as ContentBlock) : undefined
}

function textData(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const parts: string[] = []
  for (let at = 0; at < bytes.length; at += 16384)
    parts.push(String.fromCharCode(...bytes.subarray(at, at + 16384)))
  return btoa(parts.join(''))
}

/** File originals use ACP's existing embedded blob resource, never a private ACP schema fork. */
export function toAcpPrompt(content: readonly ContentBlock[]): unknown[] {
  return content.map((block) =>
    attachmentForm(block) === 'reference'
      ? referenceLink(block)
      : // A lean file (bytes left in storage) has nothing to embed and passes through as metadata.
        block.type === 'file' && 'data' in block
        ? {
            type: 'resource',
            resource: {
              uri: `${PREFIX}${encodeURIComponent(block.name)}`,
              mimeType: block.mimeType,
              blob: block.data,
            },
          }
        : block,
  )
}

/** Embedded bytes become session files; a resource URI is only a label, never a fetch or disk path. */
export function fromAcpPrompt(content: readonly unknown[]): ContentBlock[] {
  return content.map((value) => {
    const block = value as {
      type?: string
      uri?: unknown
      _meta?: unknown
      resource?: { uri?: string; mimeType?: string | null; blob?: string; text?: string }
    }
    const reference = linkedReference(block)
    if (reference) return reference
    if (block.type !== 'resource') return value as ContentBlock
    const { uri, blob, mimeType, text } = block.resource ?? {}
    if (typeof uri !== 'string' || (typeof blob !== 'string' && typeof text !== 'string'))
      throw new Error('Invalid attachment resource.')
    return {
      type: 'file',
      name: uri.startsWith(PREFIX)
        ? decodeURIComponent(uri.slice(PREFIX.length))
        : uri.slice(0, 256) || 'attachment',
      mimeType:
        mimeType?.split(';')[0]?.trim() ||
        (typeof blob === 'string' ? 'application/octet-stream' : 'text/plain'),
      data: typeof blob === 'string' ? blob : textData(text as string),
    }
  })
}
