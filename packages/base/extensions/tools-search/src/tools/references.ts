import {
  TOOL_PATH_REFERENCES,
  type ToolContext,
  type ToolPathReference,
  type ToolPathReferences,
  type ToolResult,
} from '@agnes/extension-api'
import { guardOutput, refBlock } from '../../../tools-core/src/guards/output.js'
import { normalizeWorkspacePath } from '../../../tools-core/src/paths.js'

/** The most paths one result lists; a larger result is counted in `total` and marked truncated. */
export const MAX_REFERENCES = 100

// A path can be 4096 bytes long, and a hundred of those would push the structured result past the
// size limit the kernel enforces, which replaces it and adds a line to the text the model reads.
// Leaving out the rare long path keeps the result well under that limit and the text untouched.
// The length is the path's size once encoded as a JSON string, because that is what the kernel
// measures: escaping makes a control character six times its raw size.
export const MAX_REFERENCE_PATH_BYTES = 1024

/** The encoded size above which the kernel replaces a structured result; it mirrors the kernel's own limit. */
export const STRUCTURED_MAX_BYTES = 262_144

// Half the kernel's limit, so the kernel's slightly larger way of counting an object never reaches
// it. The two caps above already keep a result far below this; the running count makes that hold
// whatever the caps become.
const REFERENCES_BUDGET_BYTES = STRUCTURED_MAX_BYTES / 2

/** A row of a tool's text that names a path: its index, and how many leading characters name it. */
export type Row = { row: number; label: number }

/** A path a tool found, and the rows of its text that name it, if it shows any. */
export type FoundPath = { abs: string; kind: ToolPathReference['kind']; rows?: readonly Row[] }

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

/**
 * `found` is every path the tool found, in display order; `shown` how many of them its text shows.
 * Only shown paths inside the workspace, at most 1024 bytes long once JSON-encoded, are listed, at
 * most 100 of them; `total` is `found.length`.
 */
export function pathReferences(
  ctx: Pick<ToolContext, 'session' | 'platform'>,
  found: readonly FoundPath[],
  shown: number,
  partial: boolean,
): ToolPathReferences {
  return listReferences(ctx, found.slice(0, shown), found.length, partial)
}

function listReferences(
  ctx: Pick<ToolContext, 'session' | 'platform'>,
  candidates: readonly FoundPath[],
  total: number,
  partial: boolean,
): ToolPathReferences {
  // Where the separator is `/`, a backslash is an ordinary filename character, but the workspace
  // fold reads it as a separator, so `a\b` would come back as the different path `a/b`.
  const literalBackslash = ctx.platform.fs.pathSep !== '\\'
  const references: ToolPathReference[] = []
  let bytes = jsonBytes({
    schema: TOOL_PATH_REFERENCES,
    references: [],
    total,
    truncated: true,
  })
  for (const f of candidates) {
    if (references.length >= MAX_REFERENCES) break
    if (literalBackslash && f.abs.includes('\\')) continue
    const w = normalizeWorkspacePath(f.abs, ctx.session.workspaceRoot)
    if (!w.inside || w.rel === '' || w.rel === '.') continue
    if (jsonBytes(w.rel) - 2 > MAX_REFERENCE_PATH_BYTES) continue
    const reference: ToolPathReference = { kind: f.kind, path: w.rel }
    bytes += jsonBytes(reference) + 1
    if (bytes > REFERENCES_BUDGET_BYTES) break
    references.push(reference)
  }
  return {
    schema: TOOL_PATH_REFERENCES,
    references,
    total,
    truncated: partial || references.length < total,
  }
}

/**
 * The guarded text of a result, as `guardedResult` gives it, with the references of the paths it
 * shows. `text` starts with `rows` joined by newlines, and each shown path names the rows that name
 * it. When the guard cuts the middle out of the text, a path keeps its reference only while one of
 * its rows still shows the whole of its name in the head or the tail, and the references are marked
 * truncated, as the text itself says it is.
 */
export async function referencedResult(
  ctx: ToolContext,
  text: string,
  rows: readonly string[],
  found: readonly FoundPath[],
  shown: number,
  partial: boolean,
): Promise<ToolResult> {
  const g = await guardOutput(ctx, text)
  const block = { type: 'text' as const, text: g.text }
  const content = g.ref ? [block, refBlock(g.ref)] : [block]
  if (!g.kept) return { content, structured: pathReferences(ctx, found, shown, partial) }
  const starts: number[] = []
  let at = 0
  for (const row of rows) {
    starts.push(at)
    at += row.length + 1
  }
  const head = g.kept.head
  const tail = text.length - g.kept.tail
  const visible = (r: Row): boolean => {
    const start = starts[r.row]
    return start !== undefined && (start + r.label <= head || start >= tail)
  }
  const candidates = found.slice(0, shown).filter((f) => f.rows?.some(visible) === true)
  return { content, structured: listReferences(ctx, candidates, found.length, true) }
}
