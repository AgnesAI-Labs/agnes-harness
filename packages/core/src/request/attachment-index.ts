import { type AttachmentForm, attachmentForm } from '@agnes/protocol'
import { base64DecodedBytes } from '../log/lean.js'
import type { Event } from '../types.js'

export type AttachmentKind = 'image' | 'file'

/** One user attachment, located by the row it is in and its 1-based place among that row's blocks of its kind. */
export type AttachmentEntry = Readonly<{
  seq: number
  lane: string
  kind: AttachmentKind
  index: number
  form: AttachmentForm
  sha256?: string
  bytes: number
  mimeType: string
  name?: string
  width?: number
  height?: number
  thumbnail?: Readonly<{ sha256: string; bytes: number }>
}>

type Lane = { image: AttachmentEntry[]; file: AttachmentEntry[] }

const NONE: readonly AttachmentEntry[] = Object.freeze([])

/** The first position in `entries` (ascending by seq) whose seq is at least `seq`. */
function lowerBound(entries: readonly AttachmentEntry[], seq: number): number {
  let lo = 0
  let hi = entries.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((entries[mid] as AttachmentEntry).seq < seq) lo = mid + 1
    else hi = mid
  }
  return lo
}

function entryOf(
  event: Event,
  kind: AttachmentKind,
  index: number,
  block: Record<string, unknown>,
): AttachmentEntry | undefined {
  const form = attachmentForm(block)
  if (!form) return undefined
  const ref = form === 'reference' ? (block.attachment as { sha256?: unknown; bytes?: unknown }) : undefined
  const bytes =
    form === 'reference'
      ? ref?.bytes
      : form === 'inline'
        ? base64DecodedBytes(block.data as string)
        : (block.dataOmitted as { bytes?: unknown }).bytes
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) return undefined
  if (ref && typeof ref.sha256 !== 'string') return undefined
  const thumb = block.thumbnail as { sha256?: unknown; bytes?: unknown } | undefined
  return Object.freeze({
    seq: event.seq,
    lane: event.lane ?? 'main',
    kind,
    index,
    form,
    ...(ref ? { sha256: ref.sha256 as string } : {}),
    bytes,
    mimeType: String(block.mimeType),
    ...(typeof block.name === 'string' ? { name: block.name } : {}),
    ...(typeof block.width === 'number' && typeof block.height === 'number'
      ? { width: block.width, height: block.height }
      : {}),
    ...(thumb && typeof thumb.sha256 === 'string' && typeof thumb.bytes === 'number'
      ? { thumbnail: Object.freeze({ sha256: thumb.sha256, bytes: thumb.bytes }) }
      : {}),
  })
}

/**
 * Every user attachment of a session by (seq, kind, index), folded from `user/message` rows as they are
 * replayed or appended, so listing and locating one never rescans the ledger. An entry holds the
 * block's metadata only (a few hundred bytes), never its data; rows without attachments add nothing.
 * Rows arrive in ascending seq order, which keeps each lane's lists sorted for lookup by seq; a row at
 * or below the last one folded is ignored, so feeding the same row twice cannot number it twice.
 *
 * The numbering is the one the `session-image://` and `session-file://` paths use: the n-th block of
 * that type in the message, counted from 1. A block that no form describes keeps its number but has
 * no entry.
 */
export class AttachmentIndex {
  readonly #lanes = new Map<string, Lane>()
  readonly #refs = new Set<string>()
  #refBytes = 0
  #lastSeq = 0
  #size = 0

  /** Entries held, across lanes and kinds. */
  get size(): number {
    return this.#size
  }

  apply(events: readonly Event[]): void {
    for (const event of events) {
      if (event.seq <= this.#lastSeq) continue
      this.#lastSeq = event.seq
      if (event.type !== 'user/message') continue
      const content = (event.data as { content?: unknown } | null)?.content
      if (!Array.isArray(content)) continue
      const counters = { image: 0, file: 0 }
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const kind = (block as { type?: unknown }).type
        if (kind !== 'image' && kind !== 'file') continue
        const entry = entryOf(event, kind, ++counters[kind], block as Record<string, unknown>)
        if (entry) this.#add(entry)
      }
    }
  }

  /**
   * Starts this (empty) index as a fork of `parent` at `throughSeq`: the parent's entries up to that
   * seq are shared, not copied. Rows after it are folded by `apply` as the fork reads them.
   */
  inherit(parent: AttachmentIndex, throughSeq: number): void {
    if (this.#lastSeq !== 0 || this.#size !== 0)
      throw new Error('an attachment index inherits only while empty')
    for (const [lane, lists] of parent.#lanes)
      for (const kind of ['image', 'file'] as const) {
        const list = lists[kind]
        for (const entry of list.slice(0, lowerBound(list, throughSeq + 1))) this.#add(entry, lane)
      }
    this.#lastSeq = throughSeq
  }

  /** The lane's attachments of one kind in ledger order. The array is live and must not be changed. */
  list(kind: AttachmentKind, lane: string): readonly AttachmentEntry[] {
    return this.#lanes.get(lane)?.[kind] ?? NONE
  }

  get(seq: number, kind: AttachmentKind, index: number): AttachmentEntry | undefined {
    for (const lists of this.#lanes.values()) {
      const list = lists[kind]
      for (let at = lowerBound(list, seq); at < list.length; at++) {
        const entry = list[at] as AttachmentEntry
        if (entry.seq !== seq) break
        if (entry.index === index) return entry
      }
    }
    return undefined
  }

  /** Whether a row of this session already references the object. */
  referenced(sha256: string): boolean {
    return this.#refs.has(sha256)
  }

  /** Bytes of the distinct objects this session references, each counted once. */
  referencedBytes(): number {
    return this.#refBytes
  }

  #add(entry: AttachmentEntry, lane = entry.lane): void {
    let lists = this.#lanes.get(lane)
    if (!lists) {
      lists = { image: [], file: [] }
      this.#lanes.set(lane, lists)
    }
    lists[entry.kind].push(entry)
    this.#size++
    if (entry.sha256 !== undefined && !this.#refs.has(entry.sha256)) {
      this.#refs.add(entry.sha256)
      this.#refBytes += entry.bytes
    }
  }
}
