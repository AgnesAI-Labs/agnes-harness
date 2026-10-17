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
export const MAX_REFERENCE_PATH_BYTES = 1024

export type FoundPath = { abs: string; kind: ToolPathReference['kind'] }

/**
 * `found` is every path the tool found, in display order; `shown` how many of them its text shows.
 * Only shown paths inside the workspace, at most 1024 bytes long, are listed, at most 100 of them;
 * `total` is `found.length`.
 */
export function pathReferences(
  ctx: Pick<ToolContext, 'session'>,
  found: readonly FoundPath[],
  shown: number,
  partial: boolean,
): ToolPathReferences {
  const references: ToolPathReference[] = []
  for (const f of found.slice(0, shown)) {
    if (references.length >= MAX_REFERENCES) break
    const w = normalizeWorkspacePath(f.abs, ctx.session.workspaceRoot)
    if (!w.inside || w.rel === '' || w.rel === '.') continue
    if (Buffer.byteLength(w.rel) > MAX_REFERENCE_PATH_BYTES) continue
    references.push({ kind: f.kind, path: w.rel })
  }
  return {
    schema: TOOL_PATH_REFERENCES,
    references,
    total: found.length,
    truncated: partial || references.length < found.length,
  }
}
