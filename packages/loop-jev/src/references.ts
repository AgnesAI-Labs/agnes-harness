// Portions adapted from JevLoop (https://github.com/parkavenue9639/jevloop, 61e7994), Apache-2.0; modified.
/**
 * The workspace paths a tool result points at. References are shortcuts, never authority: only the
 * structured result of a profiled search tool, the path argument of a file tool, or (when a search
 * tool gave no structured result) its listing text yield them. Shell output is evidence only.
 */
import { TOOL_PATH_REFERENCES, type ToolPathReferences, type ToolResult } from '@agnes/extension-api'
import { normalizePath, resultText } from './profile.js'
import type { JsonValue, ReferenceKind, ReferenceSource, ViewReference } from './types.js'

export const SEARCH_TOOLS = ['ls', 'find', 'grep'] as const
type SearchTool = (typeof SEARCH_TOOLS)[number]
const ARGUMENT_TOOLS: readonly string[] = ['read', 'write', 'edit']
const PATH_CHARS = 512
// The lines a search tool prints in place of an empty result.
const EMPTY_LINES: Readonly<Record<SearchTool, readonly string[]>> = {
  ls: ['(no entries)'],
  find: ['no matches', 'nothing could be searched'],
  grep: ['no matches', 'nothing could be searched'],
}

export type Extracted = { source: ReferenceSource; references: ViewReference[]; truncated: boolean }

const none = (): Extracted => ({ source: 'none', references: [], truncated: false })
const isSearchTool = (name: string): name is SearchTool => (SEARCH_TOOLS as readonly string[]).includes(name)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether `value` is a path-references payload of the shared schema. */
export function isPathReferences(value: unknown): value is ToolPathReferences {
  return (
    isRecord(value) &&
    value.schema === TOOL_PATH_REFERENCES &&
    Array.isArray(value.references) &&
    typeof value.total === 'number' &&
    typeof value.truncated === 'boolean'
  )
}

/**
 * A path that can be bound, workspace-relative and normalized, or `null`. A name with a backslash or
 * a control character, or longer than the bound, stays evidence: it would not survive a later call.
 */
function referencePath(path: unknown, kind: ReferenceKind, cwd: string): string | null {
  const value = normalizePath(path, cwd)
  if (value === null || value.length > PATH_CHARS || value.includes('\\')) return null
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  return kind === 'file' && value === '.' ? null : value
}

/** Collects references once each, in the order first seen. */
function collector() {
  const references: ViewReference[] = []
  const seen = new Set<string>()
  return {
    references,
    add(kind: ReferenceKind, value: string) {
      if (seen.has(value)) return
      seen.add(value)
      references.push({ kind, value })
    },
  }
}

const join = (base: string, line: string) => (base === '.' ? line : `${base}/${line}`)

function listing(
  name: SearchTool,
  text: string,
  base: string | null,
): { references: ViewReference[]; truncated: boolean } {
  const out = collector()
  let truncated = false
  // Lines are relative to the search root; the root is already workspace-relative.
  const take = (kind: ReferenceKind, relative: string) => {
    const absolute = relative.startsWith('/') || relative.startsWith('\\')
    // The root itself (`.`) is not a reference, but neither is it a name that failed to bind.
    const value = base === null || absolute ? null : referencePath(join(base, relative), 'directory', '/')
    if (value === null) truncated = true
    else if (value !== '.') out.add(kind, value)
  }
  const searched = base === null || base === '.' ? null : base.split('/').pop()
  text.split('\n').forEach((line, index) => {
    if (line === '') return
    if (line.startsWith('[')) {
      truncated = true
      return
    }
    if (index === 0 && EMPTY_LINES[name].includes(line)) return
    if (name === 'ls') {
      if (line.endsWith('@') || line.endsWith('?')) return
      if (line.endsWith('/')) take('directory', line.slice(0, -1))
      else take('file', line)
      return
    }
    if (name === 'find') {
      take('file', line)
      return
    }
    const match = /^(.+?):(\d+):/.exec(line)
    if (match === null) return
    const path = match[1] as string
    // A search of one file names it by its last segment.
    if (path === searched) take('file', '.')
    else take('file', path)
  })
  return { references: out.references, truncated }
}

/** Text fallback for a search tool whose result has no structured references. `base` is the normalized search root. */
export function parseListing(
  name: 'ls' | 'find' | 'grep',
  text: string,
  base: string,
): { references: ViewReference[]; truncated: boolean } {
  return listing(name, text, base)
}

function fromStructured(payload: ToolPathReferences, cwd: string): Extracted {
  const out = collector()
  let dropped = false
  for (const entry of payload.references as readonly unknown[]) {
    if (!isRecord(entry) || (entry.kind !== 'file' && entry.kind !== 'directory')) continue
    const value = referencePath(entry.path, entry.kind, cwd)
    if (value === null) dropped = true
    else out.add(entry.kind, value)
  }
  return { source: 'structured', references: out.references, truncated: dropped || payload.truncated }
}

/** The references of one tool result: structured first, then the call's path argument, then the listing text. */
export function extractReferences(input: {
  name: string
  args: JsonValue
  result: ToolResult
  cwd: string
}): Extracted {
  const { name, args, result, cwd } = input
  if (result.isError === true) return none()
  const path = isRecord(args) ? args.path : undefined
  if (isSearchTool(name)) {
    if (isPathReferences(result.structured)) return fromStructured(result.structured, cwd)
    if (name === 'grep' && typeof path === 'string' && path.startsWith('artifact://')) return none()
    const root = path === undefined ? '.' : path
    const base = normalizePath(root, cwd)
    return { source: 'text', ...listing(name, resultText(result), base) }
  }
  if (ARGUMENT_TOOLS.includes(name)) {
    const value = referencePath(path, 'file', cwd)
    return value === null
      ? none()
      : { source: 'arguments', references: [{ kind: 'file', value }], truncated: false }
  }
  return none()
}
