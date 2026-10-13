import type { Event } from '../types.js'

/**
 * A lean row is what crosses a process boundary or reaches a projection: every inline image or file
 * block whose base64 is longer than this keeps its metadata and loses its bytes. Lean rows are a read
 * view only; storage keeps the row as written, and append refuses the lean shape.
 */
export const LEAN_DATA_MIN_CHARS = 262_144

const LEAN_TYPES: ReadonlySet<string> = new Set(['user/message', 'inbox'])
type Block = Record<string, unknown>

export function base64DecodedBytes(data: string): number {
  return Math.floor(data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
}

function leanBlock(block: unknown): unknown {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return block
  const b = block as Block
  if (
    (b.type !== 'image' && b.type !== 'file') ||
    typeof b.data !== 'string' ||
    b.data.length <= LEAN_DATA_MIN_CHARS
  )
    return block
  const { data, ...rest } = b
  return { ...rest, dataOmitted: { bytes: base64DecodedBytes(data as string) } }
}

function leanContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  let changed = false
  const out = content.map((block) => {
    const next = leanBlock(block)
    if (next !== block) changed = true
    return next
  })
  return changed ? out : content
}

export function leanEvent(event: Event): Event {
  if (!LEAN_TYPES.has(event.type) || !event.data || typeof event.data !== 'object') return event
  const data = event.data as Block
  if (event.type === 'user/message') {
    const content = leanContent(data.content)
    return content === data.content ? event : { ...event, data: { ...data, content } as Event['data'] }
  }
  if (!Array.isArray(data.items)) return event
  let changed = false
  const items = data.items.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !Array.isArray((item as Block).content)) return item
    const content = leanContent((item as Block).content)
    if (content === (item as Block).content) return item
    changed = true
    return { ...(item as Block), content }
  })
  return changed ? { ...event, data: { ...data, items } as Event['data'] } : event
}

export const leanEvents = (events: readonly Event[]): Event[] => events.map(leanEvent)

const hasOmitted = (content: unknown): boolean =>
  Array.isArray(content) && content.some((b) => !!b && typeof b === 'object' && 'dataOmitted' in b)

export function isLeanEvent(event: Event): boolean {
  const data = event.data as Block | null
  if (!data || typeof data !== 'object') return false
  if (hasOmitted(data.content)) return true
  return Array.isArray(data.items) && data.items.some((item) => hasOmitted((item as Block | null)?.content))
}

/**
 * Append-time guard: the lean shape is a read view and must never be written back. It is looked for
 * only where the session schema places a ContentBlock: the `content` of user/message and tool/result,
 * and the `content` of each inbox item. Free-form JSON elsewhere, such as tool-call arguments or an
 * extension event's data, may hold any shape and is left alone.
 */
export function containsOmittedData(type: string, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const d = data as Block
  if (type === 'user/message' || type === 'tool/result') return hasOmitted(d.content)
  return (
    type === 'inbox' &&
    Array.isArray(d.items) &&
    d.items.some((item) => hasOmitted((item as Block | null)?.content))
  )
}
