import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { failureCode } from '../guards/feedback.js'
import { editFailure } from './edit-feedback.js'

/** What a managed memory file raises for a whole-file write while it hides paragraphs from the agent. */
export const HIDDEN_PARAGRAPHS = 'MEMORY_HIDDEN_PARAGRAPHS'
/** What it raises for a whole-file write that changes the text of a managed paragraph. */
export const PARAGRAPH_TEXT_CHANGED = 'MEMORY_PARAGRAPH_TEXT_CHANGED'
/** Protected human-edit / preference refusals that abort before any file write. */
export const HUMAN_EDITED = 'MEMORY_HUMAN_EDITED'
export const PARAGRAPH_EDITED = 'MEMORY_PARAGRAPH_EDITED'
export const PREFERENCE_CONFLICT = 'MEMORY_PREFERENCE_CONFLICT'
const COMMITTED_METADATA_FAILED = 'MEMORY_COMMITTED_METADATA_FAILED'

/** Preserve the error object for Core to verify. The name alone grants no authority. */
export const isAttestedPreEffect = (error: unknown): boolean =>
  error instanceof Error && error.name === 'ToolPreEffectRefusal'

/** The refusals after which a change must go through as single exact replacements. */
export const isHiddenParagraphs = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code
  return isAttestedPreEffect(error) && (code === HIDDEN_PARAGRAPHS || code === PARAGRAPH_TEXT_CHANGED)
}

export const refusalCode = (error: unknown): string =>
  (error as { code?: unknown } | null)?.code === PARAGRAPH_TEXT_CHANGED
    ? PARAGRAPH_TEXT_CHANGED
    : HIDDEN_PARAGRAPHS

const PROTECTED_TEXT: Readonly<Record<string, string>> = {
  [HUMAN_EDITED]:
    'This block was edited by a human and is protected. Ask the user to update it on the Memory page, or append new text outside human-edited blocks.',
  [PARAGRAPH_EDITED]:
    'The managed paragraph text was edited since last recorded. Read the file and leave human changes intact.',
  [PREFERENCE_CONFLICT]:
    'This preference key conflicts with a human-authored preference. Ask the user to update it on the Memory page.',
}

export const EDIT_UNSUPPORTED_TEXT =
  'edit refused: this memory file has managed paragraphs and offers no replacement of single passages. Nothing was written.'

type Planned = { oldText: string; newText: string }
type Failure = { index: number | null; code: string }

export type ExactOutcome = {
  /** Zero-based indexes of the edits that were applied, in order. */
  applied: number[]
  failure?: Failure
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Applies already validated edits to a file that hides paragraphs, one exact replacement each, in the
 * order given. Every edit has matched the visible content, in order, before this runs; the file is read
 * again first, so a change made since the read stops the batch before the first replacement. Each
 * replacement is its own change in the backend (its own approval when memory asks), so a later one can
 * still fail: the outcome says which edits were applied. Only a code is reported for a failure, never
 * the backend's message, which may quote text the agent is not allowed to see.
 */
export async function replaceOneByOne(
  ctx: ToolContext,
  path: string,
  edits: readonly Planned[],
  readBytes: Uint8Array,
): Promise<ExactOutcome> {
  const replaceExact = ctx.fs.replaceExact
  if (!replaceExact) return { applied: [], failure: { index: null, code: HIDDEN_PARAGRAPHS } }
  try {
    if (!sameBytes(await ctx.fs.read(path), readBytes))
      return { applied: [], failure: { index: null, code: 'FS_EDIT_STALE' } }
  } catch (e) {
    if (ctx.signal.aborted) throw e
    return { applied: [], failure: { index: null, code: failureCode(e, 'FS_OPERATION_FAILED') } }
  }
  const applied: number[] = []
  for (const [index, edit] of edits.entries()) {
    try {
      await replaceExact.call(ctx.fs, path, edit.oldText, edit.newText)
    } catch (e) {
      const code = failureCode(e, 'FS_EDIT_REPLACE_FAILED')
      if (code === COMMITTED_METADATA_FAILED) applied.push(index)
      else if (!isAttestedPreEffect(e))
        throw Object.assign(new Error(`${code}: exact edit outcome unknown`), { code })
      else if (ctx.signal.aborted || !applied.length) throw e
      return { applied, failure: { index, code } }
    }
    applied.push(index)
  }
  return { applied }
}

const nth = (indexes: readonly number[]) => indexes.map((i) => i + 1).join(', ')

/** The error result for a batch that stopped partway; the text says what stayed applied. */
export function exactFailure(ctx: ToolContext, outcome: ExactOutcome, total: number): Promise<ToolResult> {
  const { applied, failure } = outcome
  const index = failure?.index ?? null
  const code = failure?.code ?? HIDDEN_PARAGRAPHS
  const rest = index === null ? [] : Array.from({ length: total - index - 1 }, (_, k) => index + 1 + k)
  if (index !== null && applied.includes(index)) {
    const parts = [
      `Memory edit ${index + 1} was written to the file, but the metadata update failed (${code}).`,
    ]
    if (applied.length > 1) parts.push('Earlier edits stay applied.')
    if (rest.length === 1) parts.push(`Remaining edit ${nth(rest)} was not attempted.`)
    if (rest.length > 1) parts.push(`Remaining edits ${nth(rest)} were not attempted.`)
    const hint = rest.length
      ? `Read the file again and resend only ${rest.length === 1 ? 'edit' : 'edits'} ${nth(rest)}.`
      : 'All edits from this call are already in the file.'
    parts.push(hint)
    return editFailure(ctx, code, 'write_failed', index, true, parts.join(' '), {
      applied,
      notApplied: rest,
      hint,
    })
  }
  const notApplied = index === null ? Array.from({ length: total }, (_, k) => k) : [index, ...rest]
  const hint = Object.hasOwn(PROTECTED_TEXT, code)
    ? PROTECTED_TEXT[code]
    : index === null
      ? 'Read the file again before retrying the batch.'
      : `Review the failure before retrying ${notApplied.length === 1 ? 'edit' : 'edits'} ${nth(notApplied)}.`
  const parts =
    index === null
      ? [
          code === 'FS_EDIT_STALE'
            ? 'edit refused: the memory file changed since you read it'
            : `edit failed before changing the memory file (${code})`,
          'No edits from this call were written; read the file again and resend the whole batch.',
        ]
      : [
          `edit ${index + 1} failed (${code})`,
          applied.length === 0
            ? 'no edit from this call was written'
            : applied.length === 1
              ? `edit ${nth(applied)} was applied and stays applied`
              : `edits ${nth(applied)} were applied and stay applied`,
          ...(rest.length === 0
            ? []
            : [
                rest.length === 1
                  ? `edit ${nth(rest)} was not attempted`
                  : `edits ${nth(rest)} were not attempted`,
              ]),
          hint,
        ]
  const message = parts.join(index === null ? '. ' : '; ')
  return editFailure(ctx, code, 'write_failed', index, applied.length > 0, message, {
    applied,
    notApplied,
    hint,
  })
}
