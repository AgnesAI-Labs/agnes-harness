import { utf8 } from '@agnes/core-common/request/hash'
import { CoreError } from '@agnes/core-common/types'
import type { SurfaceNode } from '@agnes/core-ledger/project/surface'
import type { LoopRequestOptions } from '@agnes/extension-api'
import type { Merged } from '../request/contribute.js'
import {
  type DeriveInput,
  type DeriveOutput,
  RESERVED_NOTE_PREFIXES,
  remintAfterBeforeRequest,
  sanitize,
} from '../request/derive.js'
import type { SessionImpl } from '../step/session.js'
import { loopRequestSurface } from './request-surface.js'

/** The largest tail note a loop may send, in UTF-8 bytes. */
export const TAIL_NOTE_MAX_BYTES = 32_768

/**
 * A loop's tail note, checked before request preparation reads or writes anything, in the shape
 * derivation takes. Undefined when the loop sent none. A committed note becomes part of the visible
 * history, so it is refused on a request whose history the loop supplied itself.
 */
export function loopTailNote(options: LoopRequestOptions): DeriveInput['tailNote'] {
  const note: unknown = options.tailNote
  if (note === undefined) return undefined
  const { text, commit } = (typeof note === 'object' && note !== null ? note : {}) as {
    text?: unknown
    commit?: unknown
  }
  if (typeof text !== 'string' || text.length === 0)
    throw new CoreError('E_ENVELOPE', 'a tail note needs non-empty text')
  if (utf8(text).length > TAIL_NOTE_MAX_BYTES)
    throw new CoreError('E_ENVELOPE', `a tail note is limited to ${TAIL_NOTE_MAX_BYTES} UTF-8 bytes`)
  if (commit !== undefined && typeof commit !== 'boolean')
    throw new CoreError('E_ENVELOPE', 'a tail note commit flag must be a boolean')
  // Checked on the scrubbed text, which is what a later derivation reads back.
  const scrubbed = sanitize(text)
  if (RESERVED_NOTE_PREFIXES.some((prefix) => scrubbed.startsWith(prefix)))
    throw new CoreError('E_ENVELOPE', 'a tail note cannot begin with a Core note prefix')
  if (commit === true && options.messages)
    throw new CoreError('E_ENVELOPE', 'a committed tail note needs the visible history, not custom messages')
  return { text, commit: commit === true }
}

/** Adds the loop's system section to the prefix and returns the history the request is derived from. */
export function loopRequestHistory(
  s: SessionImpl,
  merged: Merged,
  options: LoopRequestOptions,
): readonly SurfaceNode[] {
  if (options.system !== undefined)
    merged.sections.push({ id: 'loop:system', order: 1000, source: 'loop', text: options.system })
  return options.messages ? loopRequestSurface(s, options.messages) : s.surface()
}

/** The derived request with the loop's sampling applied; without sampling it is returned as it is. */
export function withLoopSampling(out: DeriveOutput, options: LoopRequestOptions): DeriveOutput {
  if (!options.sampling) return out
  const { maxTokens, ...samplingParams } = options.sampling
  const reminted = remintAfterBeforeRequest(out.request, out.media, {
    ...out.request,
    samplingParams: { ...out.request.samplingParams, ...samplingParams },
    ...(maxTokens === undefined ? {} : { maxTokens }),
  })
  return { ...out, request: reminted.request, header: { ...out.header, derived_hash: reminted.derivedHash } }
}
