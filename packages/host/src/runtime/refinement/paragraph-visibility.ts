import type { MemoryParagraphList, MemoryParagraphValidity, MemorySession } from '@agnes/extension-api'
import type { RefinementRegistry } from '@agnes/host-infrastructure/refinement-registry'
import { registryView } from './registry-view.js'

type Layer = 'workspace' | 'user'
type Span = { start: number; end: number }
type Validity = (id: string) => MemoryParagraphValidity

async function rawIndex(memory: MemorySession, layer: Layer, listed: MemoryParagraphList) {
  if (listed.content !== undefined) return listed.content
  if (layer === 'user' || typeof memory.readFile !== 'function') return undefined
  const stored = await memory.readFile('MEMORY.md')
  return stored.hash === listed.hash ? stored.content : undefined
}

type Markers = { open: Span; close: Span }

/** Only one opening and one subsequent closing line may identify a body in the raw index. */
export function paragraphMarkers(text: string): Map<string, Markers> {
  const pairs = new Map<string, Markers>()
  const damaged = new Set<string>()
  const seen = new Set<string>()
  const stack: { id?: string; span: Span; nested: boolean }[] = []
  for (const line of text.matchAll(/[^\n]*\n|[^\n]+$/gu)) {
    const loose = /^\s*<!--\s*(\/?)\s*refinement\s*:/iu.exec(line[0])
    if (!loose) continue
    const id = /^\uFEFF?<!-- \/?refinement:(r[0-9a-z]{10}) -->\r?\n?$/u.exec(line[0])?.[1]
    if (!id) {
      const malformedId = /refinement\s*:\s*(r[0-9a-z]{10})\b/iu.exec(line[0])?.[1]
      if (malformedId) damaged.add(malformedId)
    }
    const span = {
      start: line.index + Number(line[0].startsWith('\uFEFF')),
      end: line.index + line[0].length,
    }
    if (!loose[1]) {
      const parent = stack.at(-1)
      if (parent) parent.nested = true
      if (id && seen.has(id)) damaged.add(id)
      if (id) seen.add(id)
      stack.push({ ...(id ? { id } : {}), span, nested: !!parent })
    } else {
      const open = stack.pop()
      if (id && open?.id === id && !open.nested) pairs.set(id, { open: open.span, close: span })
      else if (id) damaged.add(id)
    }
  }
  for (const id of damaged) pairs.delete(id)
  return pairs
}

const reference = /<!--\s*ref:(r[0-9a-z]{10})\s*-->|\bref:[ \t]+(r[0-9a-z]{10})\b/gu
const annotation = /^<!--\s*expires_at:/u
const iso = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/u

function annotationExpiry(line: string): number | undefined {
  const marker = annotation.exec(line)
  if (!marker || line.indexOf('-->') !== line.length - 3) return undefined
  const parsed = iso.exec(line.slice(marker[0].length, -3).trim())
  if (!parsed) return NaN
  const [, date, time, zone] = parsed
  const midnight = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(midnight.getTime()) || !midnight.toISOString().startsWith(`${date}T`)) return NaN
  return time ? Date.parse(`${date}T${time}${zone ?? 'Z'}`) : midnight.getTime()
}

/** References hide a whole blank-line-delimited block. An expiry hides from its own line to the same end. */
function visibilitySpans(text: string, validity: Validity, now: number) {
  const hidden: Span[] = []
  const deadlines: (Span & { at: number })[] = []
  let blockStart = 0
  let hideFrom = Infinity
  let pending: { start: number; at: number }[] = []
  const finish = (end: number) => {
    if (hideFrom < end) hidden.push({ start: hideFrom, end })
    for (const deadline of pending) deadlines.push({ ...deadline, end })
    pending = []
    hideFrom = Infinity
  }
  for (const line of text.matchAll(/[^\n]*\n|[^\n]+$/gu)) {
    const trimmed = line[0].trim()
    if (!trimmed) {
      finish(line.index)
      blockStart = line.index + line[0].length
      continue
    }
    for (const match of line[0].matchAll(reference)) {
      const state = validity(match[1] ?? match[2] ?? '')
      if (state !== 'valid' && state !== 'delivered') hideFrom = blockStart
    }
    const at = annotationExpiry(trimmed)
    if (at === undefined) continue
    if (at > now) pending.push({ start: line.index, at })
    else hideFrom = Math.min(hideFrom, line.index)
  }
  finish(text.length)
  return { hidden, deadlines }
}

/** Project the same file ranges into each paragraph, including blocks crossing its marker lines. */
export async function paragraphVisibility(
  memory: MemorySession,
  layer: Layer,
  listed: MemoryParagraphList,
  registry: RefinementRegistry,
  clock: () => number,
  futureExpiry?: (at: number) => void,
): Promise<(id: string, text: string, view?: 'stored' | 'visible') => string | undefined> {
  const raw = await rawIndex(memory, layer, listed)
  if (raw === undefined) return () => undefined
  const { validity } = registryView(registry, clock)
  const now = clock()
  const markers = paragraphMarkers(raw)
  const { hidden, deadlines } = visibilitySpans(raw, validity, now)
  return function paragraphText(id, text, view = 'visible') {
    const pair = markers.get(id)
    // Two reads raced or the supplied index has ambiguous markers. Wait for a consistent listing.
    if (!pair || raw.slice(pair.open.end, pair.close.start).replace(/\r?\n$/u, '') !== text) return undefined
    if (view === 'stored') return text
    const start = pair.open.end
    const end = start + text.length
    for (const deadline of deadlines) {
      if (deadline.start < end && deadline.end > start) futureExpiry?.(deadline.at)
    }
    let cursor = 0
    const kept: string[] = []
    for (const span of hidden) {
      if (span.start >= end) break
      if (span.end <= start) continue
      kept.push(text.slice(cursor, Math.max(span.start - start, 0)))
      cursor = Math.min(span.end, end) - start
    }
    if (!kept.length) return text.trim() ? text : undefined
    kept.push(text.slice(cursor))
    return (
      kept
        .join('')
        .replace(/\n(?:[^\S\n]*\n)+/gu, '\n\n')
        .trim() || undefined
    )
  }
}
