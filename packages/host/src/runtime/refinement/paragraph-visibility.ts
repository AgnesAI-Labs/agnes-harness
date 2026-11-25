import { createHash } from 'node:crypto'
import type {
  MemoryParagraph,
  MemoryParagraphList,
  MemoryParagraphPort,
  MemoryParagraphValidity,
  MemorySession,
} from '@agnes/extension-api'
import {
  dependencyDeadline,
  type RefinementRegistry,
  type RegistryRecords,
} from '@agnes/host-infrastructure/refinement-registry'
import { registryView } from './registry-view.js'

/** Capture the provider revision before listing and verify it again inside the registry transaction. */
export function fileRevisionGuard(
  memory: MemorySession | undefined,
  unreadable = 'REGISTRY_REVISION_CONFLICT',
) {
  if (typeof memory?.stateRevision !== 'function') return undefined
  const before = memory.stateRevision()
  if (typeof before !== 'string') return undefined
  return () => {
    let current: string | undefined
    try {
      current = memory.stateRevision?.()
    } catch {
      throw Object.assign(new Error(unreadable), { code: unreadable })
    }
    if (current !== before)
      throw Object.assign(new Error('REGISTRY_REVISION_CONFLICT'), { code: 'REGISTRY_REVISION_CONFLICT' })
  }
}

type Layer = 'workspace' | 'user'
type Span = { start: number; end: number }
type Validity = (id: string) => MemoryParagraphValidity

async function rawIndex(memory: MemorySession, layer: Layer, listed: MemoryParagraphList) {
  let content = listed.content
  if (content === undefined) {
    if (layer === 'user' || typeof memory.readFile !== 'function') return undefined
    const stored = await memory.readFile('MEMORY.md')
    if (stored.hash !== listed.hash) return undefined
    content = stored.content
  }
  return createHash('sha256').update(content).digest('hex') === listed.hash ? content : undefined
}

type Markers = { open: Span; close: Span }

/** Only one opening and one subsequent closing line may identify a body in the raw index. */
export function paragraphMarkers(text: string): Map<string, Markers> {
  const pairs = new Map<string, Markers>()
  const markers = Array.from(text.matchAll(/[^\n]*\n|[^\n]+$/gu)).flatMap((line) => {
    const loose = /^\s*<!--\s*(\/?)\s*refinement\s*:/iu.exec(line[0])
    if (!loose) return []
    const id = /^\uFEFF?<!-- \/?refinement:(r[0-9a-z]{10}) -->\r?\n?$/u.exec(line[0])?.[1]
    return [
      {
        id,
        opening: !loose[1],
        start: line.index + Number(line[0].startsWith('\uFEFF')),
        end: line.index + line[0].length,
      },
    ]
  })
  const counts = new Map<string, number>()
  const nextClose = new Map<string, number>()
  const matching = new Map<number, number>()
  for (let i = markers.length - 1; i >= 0; i--) {
    const marker = markers[i]!
    if (!marker.id) continue
    counts.set(marker.id, (counts.get(marker.id) ?? 0) + 1)
    if (!marker.opening) nextClose.set(marker.id, i)
    else {
      const close = nextClose.get(marker.id)
      if (close !== undefined) matching.set(i, close)
    }
  }
  // Consume a nested region as a whole. An orphan opener ends at the next marker.
  for (let i = 0; i < markers.length; i++) {
    const open = markers[i]!
    if (!open.opening) continue
    const close = matching.get(i)
    if (close === undefined) {
      if (markers[i + 1]?.opening === false) i++
      continue
    }
    if (close === i + 1 && open.id && counts.get(open.id) === 2)
      pairs.set(open.id, { open, close: markers[close]! })
    i = close
  }
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
  const citations: (Span & { id: string })[] = []
  const ids = new Set<string>()
  let blockStart = 0
  let hideFrom = Infinity
  let pending: { start: number; at: number }[] = []
  const finish = (end: number) => {
    for (const id of ids) citations.push({ id, start: blockStart, end })
    ids.clear()
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
      const id = match[1] ?? match[2]!
      ids.add(id)
      const state = validity(id)
      if (state !== 'valid' && state !== 'delivered') hideFrom = blockStart
    }
    const at = annotationExpiry(trimmed)
    if (at === undefined) continue
    if (at > now) pending.push({ start: line.index, at })
    else hideFrom = Math.min(hideFrom, line.index)
  }
  finish(text.length)
  return { hidden, deadlines, citations }
}

/** Project the same file ranges into each paragraph, including blocks crossing its marker lines. */
export async function paragraphVisibility(
  memory: MemorySession,
  layer: Layer,
  listed: MemoryParagraphList,
  registry: RefinementRegistry,
  clock: () => number,
) {
  const legacy = listed.paragraphs.some((p) => p.visibleText === undefined)
  const raw = legacy ? await rawIndex(memory, layer, listed) : listed.content
  const markers = raw === undefined ? undefined : paragraphMarkers(raw)
  const spans =
    raw === undefined ? undefined : visibilitySpans(raw, registryView(registry, clock).validity, clock())
  return function projection({ id, text, visibleText, nextExpiry }: MemoryParagraph) {
    const pair = markers?.get(id)
    const refs = [
      ...new Set(
        pair && spans
          ? spans.citations
              .filter((c) => c.start < pair.close.start && c.end > pair.open.end)
              .map((c) => c.id)
          : Array.from(text.matchAll(reference), (m) => m[1] ?? m[2]!),
      ),
    ]
    if (visibleText !== undefined) return { visibleText, nextExpiry, refs }
    if (!pair || !spans || raw?.slice(pair.open.end, pair.close.start).replace(/\r?\n$/u, '') !== text)
      return undefined
    const { hidden, deadlines } = spans
    const start = pair.open.end
    const end = start + text.length
    for (const deadline of deadlines) {
      if (deadline.start < end && deadline.end > start)
        nextExpiry = Math.min(nextExpiry ?? deadline.at, deadline.at)
    }
    let cursor = 0
    const kept: string[] = []
    for (const span of hidden) {
      if (span.start >= end) break
      if (span.end <= start) continue
      kept.push(text.slice(cursor, Math.max(span.start - start, 0)))
      cursor = Math.min(span.end, end) - start
    }
    if (!kept.length) return { visibleText: text.trim() ? text : null, nextExpiry, refs }
    kept.push(text.slice(cursor))
    return {
      visibleText:
        kept
          .join('')
          .replace(/\n(?:[^\S\n]*\n)+/gu, '\n\n')
          .trim() || null,
      nextExpiry,
      refs,
    }
  }
}

export type Projection = ReturnType<Awaited<ReturnType<typeof paragraphVisibility>>>

export function targetDeadline(
  records: RegistryRecords,
  entry: MemoryParagraph | undefined,
  projection: Projection,
) {
  if (!entry || (entry.validity !== 'valid' && entry.validity !== 'delivered') || !projection?.visibleText)
    return -Infinity
  return Math.min(
    projection.nextExpiry ?? Infinity,
    dependencyDeadline(records, [entry.id, ...projection.refs]),
  )
}

/** Re-evaluate file filters, including topic summaries that may change without touching the index. */
export function liveTargetDeadline(
  memory: MemorySession,
  layer: Layer,
  port: MemoryParagraphPort,
  registry: RefinementRegistry,
  id: string,
  clock: () => number,
) {
  return async () => {
    try {
      const listed = await port.list()
      const visible = await paragraphVisibility(memory, layer, listed, registry, clock)
      const entry = listed.paragraphs.find((p) => p.id === id)
      return targetDeadline(registry.read(), entry, entry && visible(entry))
    } catch {
      return -Infinity
    }
  }
}
