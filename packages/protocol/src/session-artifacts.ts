import type { ArtifactRef, EventEnvelope } from '../gen/ts/agnes-v1.js'
import { ArtifactRef as ArtifactRefSchema } from '../gen/ts/agnes-v1.js'
import { validateAgainst, validateStoredAttachment } from './validate.js'

export const ARTIFACT_REGISTERED_EVENT = 'x/core/artifact.registered'
const MAX_ROOTS = 256
const ARTIFACT_URI = /^artifact:\/\/([0-9a-f]{64})$/u

/**
 * Provenance candidates from validated server ledger rows. The caller still owns session/lane,
 * principal and store checks; this parser grants no authority from an arbitrary supplied event.
 * UI surface data never creates artifact roots.
 */
export function sessionArtifactRoots(
  event: EventEnvelope,
): readonly Readonly<{ sha256: string; mime: string; size?: number }>[] | undefined {
  if (event.type === ARTIFACT_REGISTERED_EVENT) {
    if (event.origin !== 'system' || event.trust !== 'trusted') return undefined
    const checked = validateAgainst<ArtifactRef>(
      ArtifactRefSchema,
      (event.data as { artifact?: unknown }).artifact,
    )
    if (!checked.ok) throw new Error('artifact registration invalid')
    return [checked.value]
  }
  if (
    event.type === 'user/message' ||
    (event.type === 'inbox' && event.origin === 'system' && event.trust === 'trusted')
  ) {
    const data = event.data as { content?: unknown[]; items?: { content?: unknown[] }[] }
    const blocks =
      event.type === 'inbox' ? (data.items ?? []).flatMap((item) => item.content ?? []) : (data.content ?? [])
    const refs: ArtifactRef[] = []
    for (const block of blocks) {
      if (!block || typeof block !== 'object' || !('attachment' in block)) continue
      validateStoredAttachment(block)
      refs.push(block.attachment.artifact)
      if (block.attachment.thumbnail) refs.push(block.attachment.thumbnail)
    }
    if (refs.length > MAX_ROOTS) throw new Error('artifact roots invalid')
    return refs
  }
  if (event.type === 'request/header') {
    if (event.origin !== 'system' || event.trust !== 'trusted') return undefined
    const data = event.data as { media?: { manifest?: unknown } }
    if (!data.media) return undefined
    const manifest = data.media.manifest
    if (!Array.isArray(manifest) || manifest.length > MAX_ROOTS) throw new Error('artifact roots invalid')
    return manifest.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('artifact roots invalid')
      const entry = value as Record<string, unknown>
      if (
        typeof entry.sha256 !== 'string' ||
        typeof entry.mime !== 'string' ||
        entry.artifactUri !== `artifact://${entry.sha256}`
      )
        throw new Error('artifact roots invalid')
      return Object.freeze({ sha256: entry.sha256, mime: entry.mime })
    })
  }
  if (event.type !== 'tool/result') return undefined
  const data = event.data as { content?: unknown; isError?: unknown }
  const deliverableResult = event.origin === 'tool:present' && event.trust === 'trusted'
  const imageResult =
    (['tool:computer_use', 'tool:document_read'].includes(event.origin) && event.trust === 'untrusted') ||
    (event.origin === 'tool:read' && event.trust === 'trusted')
  if ((!imageResult && !deliverableResult) || data.isError !== false) return undefined
  if (!Array.isArray(data.content)) return undefined
  const roots = new Map<string, Readonly<{ sha256: string; mime: string }>>()
  for (const value of data.content) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const block = value as Record<string, unknown>
    if (block.type !== 'resource_link') continue
    const match = typeof block.uri === 'string' ? ARTIFACT_URI.exec(block.uri) : null
    if (
      !match ||
      typeof block.mimeType !== 'string' ||
      (!deliverableResult && block.mimeType !== 'image/png' && block.mimeType !== 'image/jpeg')
    )
      continue
    const sha256 = match[1] as string
    roots.set(`${sha256}:${block.mimeType}`, Object.freeze({ sha256, mime: block.mimeType }))
    if (roots.size > MAX_ROOTS) throw new Error('artifact roots invalid')
  }
  return [...roots.values()]
}
