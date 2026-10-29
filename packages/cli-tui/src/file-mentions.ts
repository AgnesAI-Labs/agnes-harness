import { execFile } from 'node:child_process'
import { type Dirent, statSync } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  AGH_DIR,
  type ContentBlock,
  fileReferenceBrowse,
  type ReferenceSearchResult,
  type SessionWorkspaceListResult,
  WORKSPACE_SECRET_DIRS,
} from '@agnes/protocol'
import { gitCommand } from './git-command.js'
import type { Locale } from './locale.js'
import { tt } from './locale-extended.js'

/** A workspace path the `@` menu offers, relative to the working directory. */
export type MentionItem = { id: string; directory: boolean }
export type MentionState = {
  status: 'loading' | 'ready' | 'failed'
  items: readonly MentionItem[]
  /** One line saying why a search failed; shown in place of the generic failure note. */
  reason?: string
}

// `@` opens a mention only at the start of a word, so `a@b.com` is not one. A quoted form carries
// paths with spaces; the quote stays open while the path is still being chosen.
const TOKEN = /(?:^|\s)@((?:file\s+)?(?:"[^"\n]*|[^\s"]*))$/u

/** The mention being typed just before the cursor: where its `@` stands and what follows it. */
export function mentionToken(before: string): { start: number; query: string } | undefined {
  const raw = TOKEN.exec(before)?.[1]
  if (raw === undefined) return undefined
  return { start: before.length - raw.length - 1, query: raw }
}

/** What accepting an item writes: a file closes the mention, a folder stays open to choose inside it. */
export function mentionText(item: MentionItem): string {
  // The bare form stops at whitespace; a quoted form carries spaces.
  // ponytail: a `"` in a name has no quoted form, so such a file stays unmentionable.
  const quote = /[\s@]/u.test(item.id) ? '"' : ''
  return item.directory ? `@${quote}${item.id}/` : `@${quote}${item.id}${quote} `
}

const MAX_ENTRIES = 50_000
// A walk outside git reads one directory at a time; a home directory would take many seconds.
const MAX_WALKED = 20_000
// How many ranked entries the menu can scroll through; it shows five at a time.
const SHOWN = 50
// An index older than this is rebuilt in the background the next time the menu asks.
const STALE_MS = 5_000
// Never worth offering, and the reason a walk outside git would take forever.
const SKIPPED = new Set(['node_modules'])

/** One fixed-argument git call without a shell; any failure or timeout reads as no answer. */
function gitFiles(cwd: string, args: string[]): Promise<string[] | undefined> {
  // A bare `git` on Windows would first run any git.exe in the folder being listed.
  const program = gitCommand(cwd)
  if (!program) return Promise.resolve(undefined)
  return new Promise((done) => {
    execFile(
      program,
      ['ls-files', '-z', ...args],
      { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
      (error, out) => done(error ? undefined : out.split('\0').filter(Boolean)),
    )
  })
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/**
 * The files under `cwd`, relative to it with `/` separators, filtered as the workspace file service
 * filters them: never the installation home (`~/.agh` or `AGH_HOME`), `.git`, the workspace secret
 * folders or a symbolic link, and inside git nothing `.gitignore` or `.aghignore` hides. Git answers
 * inside a repository; elsewhere a bounded walk does, without ignore files. Runs without a shell.
 */
export async function listWorkspaceFiles(cwd: string): Promise<string[]> {
  if (process.env.AGNES_HOME?.trim())
    throw new Error(
      'AGNES_HOME is no longer supported; unset it and select a new, empty AGH_HOME (clean home).',
    )
  const root = await realpath(cwd)
  const home = resolve(process.env.AGH_HOME || join(process.env.HOME || homedir(), AGH_DIR))
  const homes = [home, await realpath(home).catch(() => home)]
  const hidden = (rel: string): boolean =>
    rel.split('/').includes('.git') ||
    WORKSPACE_SECRET_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`)) ||
    homes.some((path) => inside(path, join(root, rel)))
  // Git applies one per-directory ignore file and lists tracked files whatever they match, so the
  // tracked files either ignore file matches, and the untracked ones `.aghignore` matches (whole
  // folders as `dir/`), are taken out afterwards.
  const [listed, ignored, aghTracked] = await Promise.all([
    gitFiles(root, ['--cached', '--others', '--exclude-standard']),
    gitFiles(root, ['--cached', '--ignored', '--exclude-standard']),
    gitFiles(root, ['--cached', '--ignored', '--exclude-per-directory=.aghignore']),
  ])
  // Walking untracked files against `.aghignore` alone descends into everything `.gitignore` hides,
  // so it runs only where a `.aghignore` exists, and never into node_modules.
  const aghUntracked = listed?.some((rel) => rel === '.aghignore' || rel.endsWith('/.aghignore'))
    ? await gitFiles(root, [
        '--others',
        '--ignored',
        '--directory',
        '--exclude-per-directory=.aghignore',
        '--exclude=node_modules',
      ])
    : []
  if (listed) {
    const drop = new Set([...(ignored ?? []), ...(aghTracked ?? []), ...(aghUntracked ?? [])])
    const folders = [...drop].filter((rel) => rel.endsWith('/'))
    const dropped = (rel: string) => drop.has(rel) || folders.some((folder) => rel.startsWith(folder))
    const kept = listed.filter((rel) => !dropped(rel) && !hidden(rel)).slice(0, MAX_ENTRIES)
    const links = await Promise.all(
      kept.map((rel) =>
        lstat(join(root, rel)).then(
          (info) => !info.isFile(),
          () => true,
        ),
      ),
    )
    return kept.filter((_rel, index) => !links[index])
  }
  const files: string[] = []
  const pending = ['']
  while (pending.length && files.length < MAX_WALKED) {
    const dir = pending.shift() as string
    let entries: Dirent[]
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true })
    } catch (error) {
      if (dir === '') throw error
      continue
    }
    for (const entry of entries) {
      const id = dir ? `${dir}/${entry.name}` : entry.name
      if (hidden(id) || SKIPPED.has(entry.name)) continue
      // A symbolic link is neither: it is never offered or followed.
      if (entry.isDirectory()) pending.push(id)
      else if (entry.isFile()) files.push(id)
    }
  }
  return files
}

type Entry = MentionItem & { path: string; name: string; depth: number }

/** Every file and every folder above one, lower-cased once for matching. */
function indexOf(files: readonly string[]): Entry[] {
  const folders = new Set<string>()
  for (const file of files)
    for (let at = file.indexOf('/'); at > 0; at = file.indexOf('/', at + 1)) folders.add(file.slice(0, at))
  const entry = (id: string, directory: boolean): Entry => {
    const path = (directory ? `${id}/` : id).toLowerCase()
    const name = path.slice(path.lastIndexOf('/', path.length - 2) + 1)
    return { id, directory, path, name, depth: id.split('/').length }
  }
  return [...[...folders].map((id) => entry(id, true)), ...files.map((id) => entry(id, false))]
}

/**
 * The entries holding every character of the query in order. A name starting with the query ranks
 * first, then a name containing it, then a path containing it, then a scattered match; within a
 * rank fewer skipped characters, then the shallower and the shorter path. No query lists the top level, folders first.
 */
export function rankMentions(entries: readonly Entry[], query: string): MentionItem[] {
  const wanted = query.toLowerCase()
  if (!wanted)
    return entries
      .filter((entry) => !entry.id.includes('/'))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.id.localeCompare(b.id))
      .slice(0, SHOWN)
      .map(({ id, directory }) => ({ id, directory }))
  const scored: Array<{ entry: Entry; tier: number; gaps: number }> = []
  for (const entry of entries) {
    let at = -1
    let gaps = 0
    for (const char of wanted) {
      const next = entry.path.indexOf(char, at + 1)
      if (next < 0) {
        gaps = -1
        break
      }
      gaps += next - at - 1
      at = next
    }
    // The folder already typed out is where the user is, not a choice; an exact file still is.
    if (gaps < 0 || (entry.directory && entry.path === wanted)) continue
    const tier = entry.name.startsWith(wanted)
      ? 0
      : entry.name.includes(wanted)
        ? 1
        : entry.path.includes(wanted)
          ? 2
          : 3
    scored.push({ entry, tier, gaps })
  }
  return scored
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        (a.tier === 3 ? a.gaps - b.gaps : 0) ||
        a.entry.depth - b.entry.depth ||
        a.entry.path.length - b.entry.path.length ||
        a.entry.id.localeCompare(b.entry.id),
    )
    .slice(0, SHOWN)
    .map(({ entry: { id, directory } }) => ({ id, directory }))
}

/**
 * Answers the editor synchronously from an in-memory index of the workspace, so every keystroke
 * filters at once. The index is built on first use and rebuilt in the background once stale; until
 * the first build lands the menu reads "loading". A failure is a state, never a throw: the editor
 * calls this from the terminal's input callback.
 */
export class FileMentionSource {
  private entries: Entry[] | undefined
  private failed = false
  private loading = false
  private loadedAt = Number.NEGATIVE_INFINITY
  private disposed = false
  private ranked: { query: string; state: MentionState } | undefined

  constructor(
    private readonly list: () => Promise<readonly string[]>,
    private readonly changed: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  get(query: string): MentionState {
    if (!this.loading && this.now() - this.loadedAt > STALE_MS) this.refresh()
    if (!this.entries) return { status: this.failed ? 'failed' : 'loading', items: [] }
    if (this.ranked?.query !== query)
      this.ranked = { query, state: { status: 'ready', items: rankMentions(this.entries, query) } }
    return this.ranked.state
  }

  dispose(): void {
    this.disposed = true
  }

  private refresh(): void {
    this.loading = true
    Promise.resolve()
      .then(() => this.list())
      .then(
        (files) => {
          this.entries = indexOf(files)
          this.ranked = undefined
          this.failed = false
        },
        () => {
          this.failed = !this.entries
        },
      )
      .finally(() => {
        this.loading = false
        this.loadedAt = this.now()
        if (!this.disposed) this.changed()
      })
  }
}

/** Daemon text is untrusted: no control or escape characters, one line, bounded. */
export function oneLine(text: string, max = 120): string {
  const clean = text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

const noControls = (text: string): boolean => oneLine(text, Number.POSITIVE_INFINITY) === text

/** A workspace-relative path: not absolute, no `~`, no `..` step out of the workspace. */
const relativeInside = (id: string): boolean =>
  !isAbsolute(id) && !/^[A-Za-z]:/u.test(id) && !id.startsWith('~') && !id.split(/[\\/]/u).includes('..')

const unavailable = (error: unknown): boolean => {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code
  return code === 'METHOD_NOT_FOUND' || code === 'CAPABILITY_DENIED'
}

/**
 * Completes `@` through the daemon's `session.references.search`, so the files offered belong to the
 * session's workspace wherever the daemon runs. Answers synchronously from the cache. The daemon
 * cancels the preceding request when the query changes. `fallback` (local embedded daemon only)
 * takes over when the daemon lacks the method;
 * with none (a remote connection) this never reads the local disk, and the failure is the answer.
 */
export class ReferenceMentionSource {
  private readonly cache = new Map<string, { at: number; state: MentionState }>()
  private active: AbortController | undefined
  private wanted: string | undefined
  // Bumped by reset: an answer from the previous session is dropped, not cached.
  private generation = 0
  private disposed = false

  constructor(
    private readonly search: (query: string, signal: AbortSignal) => Promise<ReferenceSearchResult>,
    private readonly changed: () => void,
    private readonly describe: (error: unknown) => string,
    private readonly fallback?: { get(query: string): MentionState; dispose(): void },
    private readonly now: () => number = Date.now,
    private readonly browse?: (path: string, signal: AbortSignal) => Promise<SessionWorkspaceListResult>,
  ) {}

  get(query: string): MentionState {
    if (this.fallback && this.latched) return this.fallback.get(query)
    if (this.wanted !== query) {
      this.wanted = query
      this.active?.abort()
      this.active = undefined
    }
    const hit = this.cache.get(query)
    if (hit && this.now() - hit.at <= STALE_MS) return hit.state
    if (!this.active) this.fetch(query)
    if (hit) return hit.state
    return { status: 'loading', items: [] }
  }

  cancel(): void {
    this.active?.abort()
    this.active = undefined
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
    this.fallback?.dispose()
  }

  /** Forget what the previous session answered; the next `get` asks the current one. */
  reset(): void {
    this.cache.clear()
    this.latched = false
    this.generation++
    this.cancel()
  }

  private latched = false

  private fetch(query: string): void {
    const controller = new AbortController()
    this.active = controller
    const generation = this.generation
    Promise.resolve()
      .then(async () => {
        controller.signal.throwIfAborted()
        const fileQuery = fileReferenceBrowse(query)
        const [found, listed] = await Promise.all([
          this.search(query, controller.signal),
          fileQuery && this.browse
            ? this.browse(fileQuery.path, controller.signal)
            : Promise.resolve(undefined),
        ])
        return { found, listed, fileQuery }
      })
      .then(
        ({ found, listed, fileQuery }) => {
          if (generation !== this.generation || controller.signal.aborted || this.disposed) return
          // Only workspace files are completed here; other sources have no `@path` form.
          const items = found.items
            .filter(
              (item) => item.source === 'file' && item.id && noControls(item.id) && relativeInside(item.id),
            )
            .map((item) => ({ id: item.id, directory: false }))
          if (listed && fileQuery)
            items.unshift(
              ...listed.entries
                .filter(
                  (entry) =>
                    entry.kind === 'directory' &&
                    entry.name.toLowerCase().includes(fileQuery.filter.toLowerCase()),
                )
                .map((entry) => ({
                  id: fileQuery.path ? `${fileQuery.path}/${entry.name}` : entry.name,
                  directory: true,
                }))
                .filter((item) => noControls(item.id) && relativeInside(item.id)),
            )
          this.store(query, { status: 'ready', items })
        },
        (error: unknown) => {
          if (generation !== this.generation || controller.signal.aborted || this.disposed) return
          if (this.fallback && unavailable(error)) this.latched = true
          else this.store(query, { status: 'failed', items: [], reason: oneLine(this.describe(error)) })
        },
      )
      .finally(() => {
        if (this.active !== controller) return
        this.active = undefined
        if (this.disposed) return
        this.changed()
      })
  }

  private store(query: string, state: MentionState): void {
    if (this.cache.size >= 200) this.cache.clear()
    this.cache.set(query, { at: this.now(), state })
  }
}

/**
 * The `@` source for a session. `remote` is true for `--connect`: the daemon's workspace is not this
 * machine's, so the local disk is never consulted. An embedded daemon shares the disk and may fall back.
 */
type MentionSession = {
  searchReferences(query: string, options?: { signal?: AbortSignal }): Promise<ReferenceSearchResult>
  workspaceBrowse?(path: string, options?: { signal?: AbortSignal }): Promise<SessionWorkspaceListResult>
}

export function createMentionSource(o: {
  session: MentionSession | (() => MentionSession)
  cwd: string
  remote: boolean
  locale: Locale
  changed: () => void
}): ReferenceMentionSource {
  const current = () => (typeof o.session === 'function' ? o.session() : o.session)
  const workspaceBrowse = current().workspaceBrowse
  const describe = (error: unknown): string => {
    if (unavailable(error)) return tt('composer.mentionUnavailable', o.locale)
    const message = error instanceof Error ? error.message : String(error)
    return tt('composer.mentionFailedReason', o.locale, { reason: oneLine(message) })
  }
  return new ReferenceMentionSource(
    (query, signal) => current().searchReferences(query, { signal }),
    o.changed,
    describe,
    o.remote ? undefined : new FileMentionSource(() => listWorkspaceFiles(o.cwd), o.changed),
    Date.now,
    workspaceBrowse
      ? (path, signal) => {
          const session = current()
          if (!session.workspaceBrowse) throw new Error('Workspace browsing unavailable')
          return session.workspaceBrowse(path, { signal })
        }
      : undefined,
  )
}

// `@` at the start of a word, then a quoted path or a run of non-space characters.
const MENTION = /(^|\s)@(?:"([^"\n]+)"|([^\s@"]+))/gu

/**
 * Turns every `@path` naming an existing file or folder under `cwd` into a `resource_link` with its
 * absolute `file://` URI (folders marked `inode/directory`, as the Web composer sends them) and
 * strips the `@` from the text left behind. Only the location travels; nothing is read. A mention
 * that names nothing (`@alice`) stays as typed.
 */
export function attachmentsFrom(text: string, cwd: string, remote = false): ContentBlock[] {
  // Over --connect this machine's disk is not the session's workspace: send the text as typed, never a
  // local file:// location.
  if (remote) return [{ type: 'text', text }]
  const links: ContentBlock[] = []
  const cleaned = text.replace(MENTION, (match, lead: string, quoted?: string, bare?: string) => {
    const path = quoted ?? bare ?? ''
    const absolute = resolve(cwd, path)
    let directory: boolean
    try {
      directory = statSync(absolute).isDirectory()
    } catch {
      return match
    }
    links.push({
      type: 'resource_link',
      uri: pathToFileURL(absolute).href,
      name: path,
      ...(directory ? { mimeType: 'inode/directory' } : {}),
    })
    return `${lead}${path}`
  })
  return [{ type: 'text', text: cleaned }, ...links]
}
