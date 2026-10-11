import type { FsEntry, ToolContext, ToolMeta, ToolResult } from '@agnes/extension-api'
import { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'
import { normalizeWorkspacePath } from '../../../tools-core/src/paths.js'
import { MAX_READ_BYTES } from '../../../tools-core/src/tools/read.js'

// Directory names a search walks past. They hold build output and dependency trees: matches in
// them are almost never what was asked for, and they are usually the bulk of the tree. Which ones
// were passed over is reported with the results, because a search that quietly skips a directory
// tells the caller there was nothing in it.
export const DEFAULT_SKIP = new Set(['node_modules', '.git', 'dist', '.agnes-tmp'])

// Workspace-relative paths a deployment's defaults refuse to open: the secret store, the seam
// tables, the audit log and the session database. A tool that walks a tree has to keep out of them
// by itself. The kernel's own check compares the string it was handed against these names, so a
// walker that reaches them by absolute path never meets it, and one denial there is a credential
// or an audit trail handed to a model.
export const DENIED_PATHS = ['.git', ...WORKSPACE_SECRET_DIRS, 'secrets', 'tables', 'audit', 'sessions.db']

// The meta the three search tools share. All eight keys are written out here rather than in each
// tool, because they genuinely are the same answer: reading a tree changes nothing, costs nothing
// worth quoting, and accesses local files through the Host's filesystem port.
export const SEARCH_META: ToolMeta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe',
  costHint: {},
  deferLoading: false,
  requiresApproval: 'never',
}

export function toolError(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** Lexical precheck only; the filesystem port independently enforces the session's access scope. */
export function allowed(ctx: ToolContext, abs: string): boolean {
  const w = normalizeWorkspacePath(abs, ctx.cwd)
  if (!w.inside) return ctx.session.fullAccess === true
  return !DENIED_PATHS.some((d) => w.rel === d || w.rel.startsWith(`${d}/`))
}

export function searchPathError(ctx: ToolContext, tool: string, path: string): ToolResult | undefined {
  if (allowed(ctx, path)) return undefined
  if (!normalizeWorkspacePath(path, ctx.cwd).inside)
    return toolError(
      `${tool} refused: ${path} is outside the workspace. Switch to Full permissions (完全权限) or select the target directory as the workspace (选择目标目录作为工作区).`,
    )
  return toolError(`${tool} refused: ${path} is denied by policy`)
}

export type WalkEntry = { rel: string; abs: string; kind: FsEntry['kind'] }

/** What a walk passed over. Every field turns into a line of the result, so nothing is lost silently. */
export type WalkReport = {
  truncated: boolean
  skipped: Set<string>
  denied: number
  /** Each path that could not be opened and why, so the result can name it rather than count it. */
  unreadable: { path: string; reason: string }[]
  /** The path the search was given could not be opened, so nothing under it was looked at. */
  rootUnreadable: boolean
  oversize: number
  binary: number
}

export function newWalkReport(): WalkReport {
  return {
    truncated: false,
    skipped: new Set(),
    denied: 0,
    unreadable: [],
    rootUnreadable: false,
    oversize: 0,
    binary: 0,
  }
}

// What the codes a walk meets mean to the caller. The message they come with repeats the path the
// note already names, and an unknown one is shown as its first line.
const REASONS: Record<string, string> = {
  ENOENT: 'not found',
  ENOTDIR: 'not a directory',
  EISDIR: 'a directory',
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  EBUSY: 'in use by another process',
  ELOOP: 'too many symbolic links',
  E_FS_DENIED: 'outside the workspace or denied by policy',
}

export function unreadableReason(e: unknown): string {
  const code = (e as { code?: unknown } | undefined)?.code
  if (typeof code === 'string' && REASONS[code] !== undefined) return REASONS[code]
  const first = String((e as Error | undefined)?.message ?? e).split('\n')[0] || 'unknown error'
  return first.length > 80 ? `${first.slice(0, 77)}...` : first
}

// A tree with a locked directory in every package would otherwise turn the note into the result.
const MAX_NAMED_UNREADABLE = 10

export function walkNotes(report: WalkReport, maxEntries: number): string[] {
  const out: string[] = []
  if (report.skipped.size > 0) out.push(`[not searched: ${[...report.skipped].sort().join(', ')}]`)
  if (report.denied > 0)
    out.push(`[${report.denied} path(s) skipped: outside the workspace or denied by policy]`)
  if (report.unreadable.length > 0) {
    const named = report.unreadable.slice(0, MAX_NAMED_UNREADABLE).map((u) => `${u.path} (${u.reason})`)
    const more = report.unreadable.length - named.length
    if (more > 0) named.push(`and ${more} more`)
    out.push(`[${report.unreadable.length} path(s) could not be read: ${named.join('; ')}]`)
  }
  if (report.oversize > 0)
    out.push(`[${report.oversize} file(s) skipped: larger than ${MAX_READ_BYTES} bytes]`)
  if (report.binary > 0) out.push(`[${report.binary} binary file(s) not searched]`)
  if (report.truncated) out.push(`[stopped after ${maxEntries} entries; the tree was not fully walked]`)
  return out
}

export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` may also match nothing at all, so `**/*.ts` finds a file at the top level as well
        // as one nested; a bare `**` at the end of a pattern spans separators.
        const slash = glob[i + 2] === '/'
        re += slash ? '(?:.*/)?' : '.*'
        i += slash ? 2 : 1
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/**
 * Breadth-first walk of a tree through the context's filesystem, yielding every entry it is allowed
 * to see and recording everything it passed over in `report`.
 *
 * Symlinks are yielded but never descended: a link is the ordinary way out of a workspace, and
 * following one by name would walk a tree the fence never cleared.
 *
 * A root that names a file is yielded as that one file, under its own name: the file `read` opens
 * for the same path. A listing refuses a file, and a search that took the refusal for an empty tree
 * would answer "no matches" about a file it never opened. A root that cannot be listed at all is
 * named with the reason.
 */
export async function* walk(
  ctx: ToolContext,
  root: string,
  report: WalkReport,
  opts: { maxEntries: number },
): AsyncGenerator<WalkEntry> {
  const base = root.replace(/\/+$/, '')
  const asFile: WalkEntry = { rel: base.split(/[\\/]/).at(-1) || root, abs: root, kind: 'file' }
  // Only asked whether the root is a file. A root this cannot describe is still listed, and a
  // listing that fails says why.
  const top = await ctx.fs.stat(root).then(
    (s) => s.kind,
    () => undefined,
  )
  if (top === 'file') {
    yield asFile
    return
  }
  const queue: string[] = ['']
  let seen = 0
  while (queue.length > 0) {
    const rel = queue.shift() as string
    let entries: FsEntry[]
    try {
      entries = await ctx.fs.list(rel === '' ? root : `${base}/${rel}`)
    } catch (e) {
      // A link given as the root is listed through, as one to a directory always was; one that
      // leads to a file is that file.
      if (rel === '' && top === 'symlink' && (e as { code?: string }).code === 'ENOTDIR') {
        yield asFile
        return
      }
      report.unreadable.push({ path: rel === '' ? root : rel, reason: unreadableReason(e) })
      if (rel === '') report.rootUnreadable = true
      continue
    }
    // Code points, not the machine's collation: a listing whose order moves with the host's locale
    // cannot be compared between two runs of the same search.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (DEFAULT_SKIP.has(e.name)) {
        report.skipped.add(e.name)
        continue
      }
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      const abs = `${base}/${childRel}`
      if (!allowed(ctx, abs)) {
        report.denied++
        continue
      }
      // Counted before it is handed out, and the ceiling is reported rather than returned into:
      // a walk that stops early without saying so reads as "there is nothing more to find".
      if (++seen > opts.maxEntries) {
        report.truncated = true
        return
      }
      yield { rel: childRel, abs, kind: e.kind }
      if (e.kind === 'dir') queue.push(childRel)
    }
  }
}
