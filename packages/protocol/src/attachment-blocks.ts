import type { ContentBlock, EventEnvelope } from '../gen/ts/session-v1.js'

/**
 * How an `image` or `file` block carries its bytes: `inline` holds them as Base64, `reference`
 * names a stored object by digest, and `omitted` is the lean transfer form that left them in
 * storage. Every other block has no attachment form.
 */
export type AttachmentForm = 'inline' | 'reference' | 'omitted'
type Loose = Record<string, unknown>

export function attachmentForm(block: unknown): AttachmentForm | undefined {
  if (!block || typeof block !== 'object') return undefined
  const b = block as Loose
  if (b.type !== 'image' && b.type !== 'file') return undefined
  if (typeof b.data === 'string') return 'inline'
  if (b.attachment && typeof b.attachment === 'object') return 'reference'
  if (b.dataOmitted && typeof b.dataOmitted === 'object') return 'omitted'
  return undefined
}

export const isReferenceBlock = (block: unknown): boolean => attachmentForm(block) === 'reference'
export const isInlineAttachment = (block: unknown): boolean => attachmentForm(block) === 'inline'
export const containsAttachmentRef = (content: readonly unknown[]): boolean => content.some(isReferenceBlock)

/** What a client that never declared attachment references receives instead of a reference block. */
export function downgradeBlock(block: ContentBlock, _at: { seq: number; index: number }): ContentBlock[] {
  if (!isReferenceBlock(block)) return [block]
  const b = block as unknown as {
    type: 'image' | 'file'
    mimeType: string
    name?: string
    attachment: { sha256: string }
    width?: number
    height?: number
  }
  // ACP requires a link to have a name; an unnamed image is called what it is.
  const name = b.name ?? 'image'
  const link = {
    type: 'resource_link' as const,
    uri: `artifact://${b.attachment.sha256}`,
    name,
    mimeType: b.mimeType,
  }
  if (b.type === 'file') return [link]
  return [link, { type: 'text', text: `[image ${name} ${b.width}×${b.height}]` }]
}

function downgradeContent(content: unknown, seq: number): unknown {
  if (!Array.isArray(content) || !containsAttachmentRef(content)) return content
  let index = 0
  return content.flatMap((block) => downgradeBlock(block as ContentBlock, { seq, index: ++index }))
}

/** A ledger row as a client without attachment references may see it; only user input carries them. */
export function downgradeEvent(event: EventEnvelope): EventEnvelope {
  const data = event.data as Loose | null
  if (!data || typeof data !== 'object') return event
  if (event.type === 'user/message') {
    const content = downgradeContent(data.content, event.seq)
    return content === data.content ? event : ({ ...event, data: { ...data, content } } as EventEnvelope)
  }
  if (event.type === 'inbox' && Array.isArray(data.items)) {
    let changed = false
    const items = data.items.map((item) => {
      const i = item as Loose
      const content = downgradeContent(i?.content, event.seq)
      if (content === i?.content) return item
      changed = true
      return { ...i, content }
    })
    return changed ? ({ ...event, data: { ...data, items } } as EventEnvelope) : event
  }
  return event
}

const TIMELINE_DEPTH = 8

/**
 * A UI projection result as a client without attachment references may see it: every array under a
 * `content` key, down to eight levels, has its reference blocks replaced. Untouched parts are
 * returned as they are, so a result without references comes back as the same object.
 */
export function downgradeTimeline<T>(value: T): T {
  return walk(value, 0) as T
}

function walk(value: unknown, depth: number): unknown {
  if (!value || typeof value !== 'object' || depth > TIMELINE_DEPTH) return value
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = walk(item, depth + 1)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  let copy: Loose | undefined
  for (const [key, child] of Object.entries(value as Loose)) {
    let next = walk(child, depth + 1)
    if (key === 'content') next = downgradeContent(next, 0)
    if (next === child) continue
    copy ??= { ...(value as Loose) }
    copy[key] = next
  }
  return copy ?? value
}
