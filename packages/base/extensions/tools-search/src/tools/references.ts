import {
  TOOL_PATH_REFERENCES,
  type ToolContext,
  type ToolPathReference,
  type ToolPathReferences,
} from '@agnes/extension-api'
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

export type FoundPath = { abs: string; kind: ToolPathReference['kind'] }

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
  // Where the separator is `/`, a backslash is an ordinary filename character, but the workspace
  // fold reads it as a separator, so `a\b` would come back as the different path `a/b`.
  const literalBackslash = ctx.platform.fs.pathSep !== '\\'
  const references: ToolPathReference[] = []
  let bytes = jsonBytes({
    schema: TOOL_PATH_REFERENCES,
    references: [],
    total: found.length,
    truncated: true,
  })
  for (const f of found.slice(0, shown)) {
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
    total: found.length,
    truncated: partial || references.length < found.length,
  }
}
