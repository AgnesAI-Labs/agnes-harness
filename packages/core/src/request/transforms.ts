import { inspectJsonData, validateAgainst } from '@agnes/protocol'
import { BeforeRequestReturn, ContextReturn } from '@agnes/protocol/gen/hooks'
import { isLedgerPreparedRequestMedia } from '../orchestrator/request-media-surface.js'
import { CoreError } from '../types.js'
import type { PromptSection } from './contribute.js'
import { type DeriveOutput, remintAfterBeforeRequest, sanitize, sanitizeJson } from './derive.js'
import { canonicalJson, sha256Hex, utf8 } from './hash.js'
import { isLedgerRequest, type RequestBody } from './mint.js'

export type ContextResult = ContextReturn
export type BeforeRequestPatch = NonNullable<BeforeRequestReturn['patch']>
export const ADDITIONAL_CONTEXT_MAX_BYTES = 8192
function invalid(): never {
  throw new CoreError('E_ENVELOPE', 'invalid hook transformation')
}

/** Inspect once and consume the detached data snapshot through schema validation. */
function jsonData<T>(value: T): T {
  const result = inspectJsonData(value, Number.MAX_SAFE_INTEGER)
  if (!result.ok) invalid()
  return result.value as T
}
function source(ext: string): string {
  if (typeof ext !== 'string' || ext.length > 128) invalid()
  return sanitize(ext)
}
function truncate(text: string, room: number): string {
  let result = '',
    bytes = 0
  for (const char of text) {
    const size = utf8(char).length
    if (bytes + size > room) break
    result += char
    bytes += size
  }
  return result
}

export function applyContextResults(
  base: PromptSection[],
  results: Array<{ ext: string; result: ContextResult }>,
): { sections: PromptSection[]; overflow: Array<{ ext: string; bytes: number }> } {
  // Keyed by id so a participant returning only its own section leaves every other
  // already-contributed section untouched, instead of replacing the whole set.
  const sections = new Map<string, PromptSection>(
    structuredClone(base)
      .filter((s) => s.id !== 'additional-context')
      .map((s): [string, PromptSection] => [s.id, s]),
  )
  const parts: string[] = [],
    seen = new Set<string>()
  const overflow: Array<{ ext: string; bytes: number }> = []
  let bytes = 0
  for (const item of results) {
    const ext = source(item.ext)
    const result = jsonData(item.result)
    if (!validateAgainst(ContextReturn, result).ok) invalid()
    if (result.sections)
      for (const s of result.sections) {
        const id = sanitize(s.id)
        // additional-context is this function's own reserved output id, computed below from the
        // accumulated additionalContext strings -- a participant cannot claim it via sections.
        if (id === 'additional-context') continue
        sections.set(id, { id, order: s.order, text: sanitize(s.text), source: ext })
      }
    const context = sanitize(result.additionalContext?.trim() ?? '')
    if (!context) continue
    const hash = sha256Hex(context)
    if (seen.has(hash)) continue
    seen.add(hash)
    const size = utf8(context).length,
      separator = parts.length ? 1 : 0
    const room = Math.max(0, ADDITIONAL_CONTEXT_MAX_BYTES - bytes - separator)
    if (size > room) overflow.push({ ext, bytes: size })
    const part = truncate(context, room)
    if (part) {
      parts.push(part)
      bytes += utf8(part).length + separator
    }
  }
  if (parts.length)
    sections.set('additional-context', {
      id: 'additional-context',
      order: 199,
      text: parts.join('\n'),
      source: 'hooks',
    })
  return { sections: [...sections.values()].sort((a, b) => a.order - b.order), overflow }
}

export function applyBeforeRequestPatches(
  out: DeriveOutput,
  patches: Array<{ ext: string; patch: BeforeRequestPatch }>,
): DeriveOutput {
  if (!isLedgerRequest(out.request)) invalid()
  if (!patches.length) return out
  if (
    (out.header.media === undefined) !== (out.media === undefined) ||
    (out.media !== undefined &&
      (!isLedgerPreparedRequestMedia(out.media) ||
        canonicalJson(out.header.media) !== canonicalJson(out.media.header)))
  )
    invalid()
  const body: RequestBody = structuredClone(out.request)
  const transforms = structuredClone(out.header.transforms ?? [])
  for (const item of patches) {
    const ext = source(item.ext)
    const snapshot = jsonData(item.patch)
    if (!validateAgainst(BeforeRequestReturn, { patch: snapshot }).ok) invalid()
    const patch = sanitizeJson(snapshot) as BeforeRequestPatch
    if (patch.samplingParams) body.samplingParams = { ...body.samplingParams, ...patch.samplingParams }
    if (patch.maxTokens !== undefined) body.maxTokens = patch.maxTokens
    if (patch.metadata) body.metadata = { ...body.metadata, ...patch.metadata }
    transforms.push({ event: 'before_request', ext })
  }
  const { request, derivedHash } = remintAfterBeforeRequest(out.request, out.media, body)
  return {
    ...out,
    request,
    header: {
      ...out.header,
      transforms,
      derived_hash: derivedHash,
    },
  }
}
