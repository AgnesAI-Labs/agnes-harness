import type { ToolResult } from '@agnes/extension-api'
import type { ContentBlock } from '@agnes/protocol'
import type { ArtifactRef } from '../reduce/shapes.js'

/** How an artifact is named in the conversation: by content hash, so the name is the identity. */
export function artifactUri(ref: ArtifactRef): string {
  return `artifact://${ref.sha256}`
}

/**
 * The author-facing result shape into the one the ledger stores. They are deliberately different:
 * an author hands back a reference to bytes the artifact store already holds, and the ledger — which
 * is also what the next request is derived from — carries a link to those bytes rather than the
 * bytes themselves. Inlining them would put a megabyte of image into every later request and into
 * every replay of this session.
 *
 * `mime` is a required key on ArtifactRef, so a `ref` block that does not restate the type still
 * carries one. The block's own is preferred where both exist: that is what the author said this use
 * of the artifact is, and it may narrow the type the bytes were stored under.
 */
export function toLedgerContent(content: ToolResult['content']): ContentBlock[] {
  return content.map((b): ContentBlock => {
    if (b.type === 'text') return { type: 'text', text: b.text }
    if (b.type === 'image')
      return { type: 'resource_link', uri: artifactUri(b.ref), mimeType: b.mime, name: 'image' }
    return {
      type: 'resource_link',
      uri: artifactUri(b.ref),
      mimeType: b.mime ?? b.ref.mime,
      name: 'artifact',
    }
  })
}
