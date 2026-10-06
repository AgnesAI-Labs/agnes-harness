import type { ContentBlock } from '../gen/ts/session-v1.js'

const PREFIX = 'agnes-attachment:'

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
    block.type === 'file'
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
      resource?: { uri?: string; mimeType?: string | null; blob?: string; text?: string }
    }
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
