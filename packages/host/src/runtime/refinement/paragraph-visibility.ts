import { createHash } from 'node:crypto'
import { closeSync, fstatSync, readSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { MemoryParagraphValidity, MemorySession } from '@agnes/extension-api'
import type { RefinementRegistry } from '@agnes/host-infrastructure/refinement-registry'
import { openCanonicalFileSync } from '@agnes/system-node'
import { registryView } from './registry-view.js'

const MAX_BYTES = 1024 * 1024
type Layer = 'workspace' | 'user'
type Span = { start: number; end: number }
type Validity = (id: string) => MemoryParagraphValidity

function memoryPath(memory: MemorySession | undefined, layer: Layer, name: string): string | undefined {
  if (typeof memory?.root !== 'string') return undefined
  if (layer === 'workspace') return join(memory.root, name)
  const workspaces = dirname(memory.root)
  return basename(workspaces) === 'workspaces' ? join(dirname(workspaces), 'user', name) : undefined
}

/** The native descriptor refuses symlinks in every path component and requires a regular file. */
function fileBytes(path: string | undefined): Buffer | undefined {
  if (!path) return undefined
  let fd: number | undefined
  try {
    fd = openCanonicalFileSync(path)
    const { size, nlink } = fstatSync(fd)
    if (size > MAX_BYTES || nlink !== 1) return undefined
    const bytes = Buffer.alloc(size + 1)
    let used = 0
    while (used < bytes.length) {
      const read = readSync(fd, bytes, used, bytes.length - used, null)
      if (!read) break
      used += read
    }
    return used === size ? bytes.subarray(0, used) : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function memoryFingerprint(memory: MemorySession | undefined, layer: Layer, name: string): string {
  const bytes = fileBytes(memoryPath(memory, layer, name))
  return bytes ? createHash('sha256').update(bytes).digest('hex') : 'missing'
}

async function rawIndex(memory: MemorySession | undefined, layer: Layer): Promise<string | undefined> {
  if (layer === 'user') return fileBytes(memoryPath(memory, layer, 'MEMORY.md'))?.toString('utf8')
  if (typeof memory?.readFile !== 'function') return undefined
  try {
    return (await memory.readFile('MEMORY.md')).content
  } catch {
    return undefined
  }
}

type Markers = { open: Span; close: Span }

/** Only one opening and one subsequent closing line may identify a body in the raw index. */
export function paragraphMarkers(text: string): Map<string, Markers> {
  const opens = new Map<string, Span>()
  const pairs = new Map<string, Markers>()
  const damaged = new Set<string>()
  for (const line of text.matchAll(/[^\n]*\n|[^\n]+$/gu)) {
    const marker = /^\uFEFF?<!-- (\/?)refinement:(r[0-9a-z]{10}) -->\r?\n?$/u.exec(line[0])
    const id = marker?.[2]
    if (!id) continue
    const span = {
      start: line.index + Number(line[0].startsWith('\uFEFF')),
      end: line.index + line[0].length,
    }
    const open = opens.get(id)
    if (!marker[1] && !open) opens.set(id, span)
    else if (marker[1] && open && !pairs.has(id)) pairs.set(id, { open, close: span })
    else damaged.add(id)
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
  memory: MemorySession | undefined,
  layer: Layer,
  registry: RefinementRegistry,
  clock: () => number,
  futureExpiry?: (at: number) => void,
) {
  const raw = await rawIndex(memory, layer)
  const { validity } = registryView(registry, clock)
  const now = clock()
  const markers = raw === undefined ? undefined : paragraphMarkers(raw)
  const fileSpans = raw === undefined ? undefined : visibilitySpans(raw, validity, now)
  return function visibleParagraphText(id: string, text: string): string | undefined {
    const pair = markers?.get(id)
    // Two reads raced or the supplied index has ambiguous markers. Wait for a consistent listing.
    if (
      raw !== undefined &&
      (!pair || raw.slice(pair.open.end, pair.close.start).replace(/\r?\n$/u, '') !== text)
    )
      return undefined
    const start = pair?.open.end ?? 0
    const end = start + text.length
    const { hidden, deadlines } = fileSpans ?? visibilitySpans(text, validity, now)
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
