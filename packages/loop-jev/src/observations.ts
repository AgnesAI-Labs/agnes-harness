// Portions adapted from JevLoop (https://github.com/parkavenue9639/jevloop, 61e7994), Apache-2.0; modified.
import type { JsonObject, JsonValue, ObservationView, ReferenceKind, ViewReference } from './types.js'
import { clip, digest16, pyJson } from './util.js'

/*
 * Bounded historical views of tool results. A reference is a shortcut to a whole, safe,
 * workspace-relative path, never an authority: shell output and any other text stay evidence.
 * Every size is `pyJson(x).length` in UTF-16 units: Python's `json.dumps(ensure_ascii=False)`
 * text, counted never more loosely than Python counts it.
 */

export const VIEW_CAP = 4
export const VIEW_CHARS = 3500
export const WINDOW_CHARS = 6000
export const FILE_REF_CAP = 20
export const DIRECTORY_REF_CAP = 8
export const EVIDENCE_CHARS = 1600

const SCOPE_CHARS = 512
const PATH_CHARS = 512
const INVOCATION_CHARS = 256
const MIN_EVIDENCE_CHARS = 256
const INVOCATION_KEYS = ['path', 'pattern', 'glob', 'offset', 'limit'] as const

const size = (value: JsonValue): number => pyJson(value).length
const capOf = (kind: ReferenceKind): number => (kind === 'file' ? FILE_REF_CAP : DIRECTORY_REF_CAP)
const refKey = (ref: ViewReference): string => `${ref.kind}\u0000${ref.value}`

/** A whole, safe, workspace-relative POSIX path, or null. */
export function viewPath(value: unknown, kind: ReferenceKind): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > PATH_CHARS) return null
  if (value.startsWith('/') || value.startsWith('\\') || value.includes('\\') || value.includes('\u0000'))
    return null
  const segments = value.split('/')
  if (segments.includes('..')) return null
  const normalized = segments.filter((part) => part !== '' && part !== '.').join('/') || '.'
  return kind === 'directory' || normalized !== '.' ? normalized : null
}

export type RawObservation = {
  operation: string
  callId: string
  scope: string
  evidence: string
  references: readonly ViewReference[]
  truncated: boolean
  invocation?: JsonObject
}

/** The scope-describing arguments of a call, strings clipped; `clipped` when any was longer. */
function invocationOf(args: JsonObject): { invocation: JsonObject; clipped: boolean } {
  const invocation: JsonObject = {}
  let clipped = false
  for (const key of INVOCATION_KEYS) {
    const value = args[key]
    if (typeof value === 'string') {
      invocation[key] = clip(value, INVOCATION_CHARS)
      clipped ||= value.length > INVOCATION_CHARS
    } else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value)))
      invocation[key] = value
  }
  return { invocation, clipped }
}

/**
 * The bounded view of one tool result. Never throws: over VIEW_CHARS it halves evidence (not
 * below 256), then drops references from the end, then the invocation; if the view is still too
 * large, it keeps only the evidence that still fits, possibly none.
 */
export function normalizeView(raw: RawObservation): ObservationView {
  const view: ObservationView = {
    id: digest16([raw.operation, raw.scope]),
    kind: raw.operation,
    scope: clip(raw.scope, SCOPE_CHARS),
    source: { operation: raw.operation, call_id: raw.callId },
    trust: 'untrusted_evidence',
    historical: true,
    evidence: clip(raw.evidence, EVIDENCE_CHARS),
    references: [],
    truncated: raw.truncated || raw.evidence.length > EVIDENCE_CHARS || raw.scope.length > SCOPE_CHARS,
  }
  if (raw.invocation !== undefined) {
    const { invocation, clipped } = invocationOf(raw.invocation)
    if (Object.keys(invocation).length > 0) view.invocation = invocation
    if (clipped) view.truncated = true
  }
  const seen = new Set<string>()
  const counts: Record<ReferenceKind, number> = { file: 0, directory: 0 }
  for (const ref of raw.references) {
    if (ref.kind !== 'file' && ref.kind !== 'directory') {
      view.truncated = true
      continue
    }
    const value = viewPath(ref.value, ref.kind)
    if (value === null) {
      view.truncated = true
      continue
    }
    const kept: ViewReference = { kind: ref.kind, value }
    if (seen.has(refKey(kept))) continue
    seen.add(refKey(kept))
    if (counts[kept.kind] >= capOf(kept.kind)) {
      view.truncated = true
      continue
    }
    counts[kept.kind]++
    view.references.push(kept)
  }
  // Paths stay whole: a reference that does not fit is dropped and the view marked partial.
  while (size(view) > VIEW_CHARS && view.evidence.length > MIN_EVIDENCE_CHARS) {
    view.evidence = clip(view.evidence, Math.max(MIN_EVIDENCE_CHARS, Math.floor(view.evidence.length / 2)))
    view.truncated = true
  }
  while (size(view) > VIEW_CHARS && view.references.length > 0) {
    view.references.pop()
    view.truncated = true
  }
  if (size(view) > VIEW_CHARS) {
    delete view.invocation
    view.truncated = true
  }
  // By now no references are left. Escaping can make the overflow larger than the evidence
  // itself, so cut at most half of it at a time until it fits or is empty.
  while (size(view) > VIEW_CHARS && view.evidence.length > 0) {
    const overflow = size(view) - VIEW_CHARS
    view.evidence = clip(
      view.evidence,
      view.evidence.length - Math.min(overflow, Math.ceil(view.evidence.length / 2)),
    )
  }
  return view
}

/**
 * The views after `incoming`, as copies: it replaces the view with the same id, the last
 * VIEW_CAP are kept, the global reference caps apply newest first, then the oldest views leave
 * until the window fits.
 */
export function updateViews(
  previous: readonly ObservationView[],
  incoming: ObservationView,
): ObservationView[] {
  const views = previous.filter((view) => view.id !== incoming.id).map((view) => structuredClone(view))
  views.push(structuredClone(incoming))
  views.splice(0, Math.max(0, views.length - VIEW_CAP))
  const counts: Record<ReferenceKind, number> = { file: 0, directory: 0 }
  const seen = new Set<string>()
  for (const view of [...views].reverse()) {
    const kept: ViewReference[] = []
    for (const ref of view.references) {
      if (seen.has(refKey(ref)) || counts[ref.kind] >= capOf(ref.kind)) {
        view.truncated = true
        continue
      }
      seen.add(refKey(ref))
      counts[ref.kind]++
      kept.push(ref)
    }
    view.references = kept
  }
  while (size(views) > WINDOW_CHARS && views.length > 1) views.shift()
  return views
}

/**
 * Cuts the evidence of `view` to its first half (rounded up), never inside a surrogate pair, and
 * marks the view partial when that shortened it. Changes `view` in place.
 */
export function halveEvidence(view: ObservationView): void {
  const { evidence } = view
  let keep = Math.ceil(evidence.length / 2)
  if (keep < evidence.length && (evidence.charCodeAt(keep - 1) & 0xfc00) === 0xd800) keep--
  if (keep >= evidence.length) return
  view.evidence = evidence.slice(0, keep)
  view.truncated = true
}

/** Paths of `kind`, newest view first, deduplicated, at most the cap of that kind. */
export function referencePaths(views: readonly ObservationView[], kind: ReferenceKind): string[] {
  const result: string[] = []
  const cap = capOf(kind)
  for (let i = views.length - 1; i >= 0 && result.length < cap; i--)
    for (const ref of views[i]?.references ?? []) {
      if (result.length >= cap) break
      if (ref.kind === kind && !result.includes(ref.value)) result.push(ref.value)
    }
  return result
}
