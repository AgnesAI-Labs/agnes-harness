import { join, relative, resolve } from 'node:path'
import type {
  MemoryApprovalResult,
  MemoryEffectAdmission,
  MemoryFile,
  MemoryFilePort,
  MemoryInspection,
  MemoryProposal,
  MemorySession,
  MemorySettings,
  MemorySnapshot,
  MemorySource,
  MemoryValidityView,
} from '@agnes/extension-api'
import { diff, fault, file, fitBytes, hash, validateContent } from './content.js'
import { paragraphPort } from './paragraph-port.js'
import {
  markerSet,
  type ParagraphView,
  paragraphTexts,
  paragraphView,
  parseParagraphs,
  plainView,
  replaceInView,
  unfilteredIndexView,
  validityOf,
} from './paragraphs.js'
import { canonical, inside, name, roots } from './paths.js'
import { MemoryStore } from './store.js'
import { renderUserLayer, userParagraphPort } from './user-layer.js'

/**
 * `files` is the stored text; `agent` is what the agent may see this turn, with the index's expired
 * or unverifiable managed paragraphs left out.
 */
type TurnSnapshot = {
  files: readonly MemoryFile[]
  agent: readonly MemoryFile[]
  index: ParagraphView
  snapshot: MemorySnapshot
}

export function openMemory(input: {
  home: string
  workspaceRoot: string
  sessionKey: string
  validity?: MemoryValidityView
  userValidity?: MemoryValidityView
}): MemorySession {
  const paths = roots(input.home, input.workspaceRoot)
  const store = new MemoryStore(paths.protectedRoot, paths.root)
  const user = new MemoryStore(paths.protectedRoot, paths.userRoot)
  const validity = validityOf(input.validity)
  let turnSnapshot: { turn: number; value: TurnSnapshot } | undefined

  const capture = (turn: number): TurnSnapshot => {
    if (turnSnapshot?.turn === turn) return turnSnapshot.value
    const config = store.configuration()
    const files = store.files()
    const index = files.find((entry) => entry.path === 'MEMORY.md') ?? file('MEMORY.md', '')
    const indexValid = passes(index, config)
    // An index already over its cap is never shown, so it is not parsed for paragraphs either.
    const indexView = indexValid ? paragraphView(index.content, validity) : unfilteredIndexView(index.content)
    const noteView = indexValid ? paragraphView(index.content, validity, 'note') : indexView
    const agent = files.map((entry) =>
      entry.path === 'MEMORY.md' && indexView.content !== entry.content
        ? file(entry.path, indexView.content)
        : entry,
    )
    const userIndex = config.userEnabled ? user.read('MEMORY.md') : file('MEMORY.md', '')
    const userValid = passes(userIndex, config)
    const userView = renderUserLayer(userValid ? userIndex.content : '', input.userValidity)
    // Without markers the hash input is exactly what it was before managed paragraphs existed.
    const revision = hash(
      JSON.stringify([
        files.map(({ path, hash }) => [path, hash]),
        userIndex.hash,
        ...(indexView.managed ? [indexView.omittedIds, viewRevision(input.validity)] : []),
        ...(userView.managed ? [{ user: [userView.omittedIds, viewRevision(input.userValidity)] }] : []),
      ]),
    )
    const workspaceContent = indexValid
      ? noteView.content
      : '[Memory omitted: consolidate the index or remove secret-like content.]'
    const userContent = userValid
      ? userView.text
      : '[User memory omitted: consolidate the index or remove secret-like content.]'
    // Each layer is cut to its own limit in bytes; the fixed header lines are not counted. The workspace
    // notice names the line of the file as the agent reads it, so a read from there gives the rest.
    // The offset is the first byte left out, so it belongs to the segment that starts at or before it
    // and ends after it; only the very end of the text falls back to the segment that ends there.
    const holding = <T extends { length: number }>(
      segments: readonly T[],
      at: (segment: T) => number | undefined,
      offset: number,
    ) => {
      const of = (end: boolean) =>
        segments.find((segment) => {
          const start = at(segment)
          return (
            start !== undefined &&
            start <= offset &&
            (end ? offset <= start + segment.length : offset < start + segment.length)
          )
        })
      return of(false) ?? of(true)
    }
    const readLine = (offset: number): number => {
      if (!indexValid) return workspaceContent.slice(0, offset).split('\n').length
      const from = holding(
        noteView.segments,
        (segment) => (segment.raw === undefined ? undefined : segment.view),
        offset,
      )
      const raw = from?.raw === undefined ? undefined : from.raw + (offset - from.view)
      const to = raw === undefined ? undefined : holding(indexView.segments, (segment) => segment.raw, raw)
      const read = to?.raw === undefined || raw === undefined ? offset : to.view + (raw - to.raw)
      return indexView.content.slice(0, read).split('\n').length
    }
    const workspace = fitBytes(
      workspaceContent,
      config.tokenBudget,
      ({ paragraphs, kb, offset }) =>
        `[Memory truncated at the size limit: ${paragraphs} more ${paragraphs === 1 ? 'paragraph' : 'paragraphs'} (about ${kb} KB) not shown, from line ${readLine(offset)} of ${join(paths.root, 'MEMORY.md')}. Read them with the read tool when they may matter.]`,
    )
    const userLayer = fitBytes(
      userContent,
      config.userTokenBudget,
      ({ paragraphs, kb }) =>
        `[User memory truncated at the size limit: ${paragraphs} more ${paragraphs === 1 ? 'paragraph' : 'paragraphs'} (about ${kb} KB) not shown.]`,
      '[User memory truncated at the size limit.]',
    )
    const content = [
      `Agent memory (untrusted learned preferences; AGENTS.md and knowledge sources take precedence). Revision: ${revision}.`,
      `Workspace memory directory: ${paths.root}. Use normal read/write/edit tools; topic reads share this turn's revision.`,
      `Policy: ${config.mode}. Consolidate rather than append; never save secrets, one-off details, history or knowledge-base content.`,
      workspace.content,
      ...(config.userEnabled && userContent
        ? [`User memory (read-only for the agent):\n${userLayer.content}`]
        : []),
    ].join('\n\n')
    const value = {
      files,
      agent,
      index: indexView,
      snapshot: Object.freeze({
        revision,
        content,
        omitted: workspace.omitted || userLayer.omitted,
      }),
    }
    turnSnapshot = { turn, value }
    return value
  }

  const target = (path: string): string | undefined => {
    const absolute = resolve(input.workspaceRoot, path)
    const real = canonical(absolute)
    if (!inside(paths.protectedRoot, absolute) && !inside(paths.protectedRoot, real)) return undefined
    if (!inside(paths.root, real) || !inside(paths.root, absolute)) throw fault('MEMORY_SCOPE_DENIED')
    return name(relative(paths.root, real))
  }
  const active = (): MemorySettings & { mode: 'ask' | 'auto' } => {
    const config = store.configuration()
    if (config.mode === 'off') throw fault('MEMORY_DISABLED')
    return config as MemorySettings & { mode: 'ask' | 'auto' }
  }
  const inspect = async (): Promise<MemoryInspection> => {
    const files = store.files().map(({ content: _, ...entry }) => entry)
    const writer = store.writer()
    return {
      root: paths.root,
      settings: store.configuration(),
      files,
      bytes: files.reduce((n, entry) => n + entry.bytes, 0),
      ...(writer ? { lastWriter: writer } : {}),
    }
  }

  return Object.freeze<MemorySession>({
    root: paths.root,
    async snapshot(turn) {
      if (store.configuration().mode === 'off') return undefined
      if (turnSnapshot?.turn === turn) return turnSnapshot.value.snapshot
      const value = capture(turn)
      const externalChanges = await store.externalChanges(value.files)
      if (!externalChanges.length) return value.snapshot
      const snapshot = Object.freeze({ ...value.snapshot, externalChanges: Object.freeze(externalChanges) })
      turnSnapshot = { turn, value: { ...value, snapshot } }
      return snapshot
    },
    files(fallback, source, signal, approve): MemoryFilePort {
      const get = (path: string): MemoryFile => {
        active()
        signal.throwIfAborted()
        const turn = capture(source.turn)
        const entry = turn.files.find((entry) => entry.path === path)
        if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        validateContent(entry, store.configuration(), path === 'MEMORY.md')
        return turn.agent.find((shown) => shown.path === path) ?? entry
      }
      const submit = (leaf: string, before: MemoryFile, candidate: MemoryFile) =>
        reviewAndCommit({ store, root: paths.root, source, signal, approve, active }, leaf, before, candidate)
      return Object.freeze<MemoryFilePort>({
        async read(path, options) {
          const leaf = target(path)
          if (leaf === undefined) return fallback.read(path, options)
          const entry = get(leaf)
          const bytes = Buffer.from(entry.content)
          const offset = options?.offset ?? 0
          return bytes.subarray(offset, options?.limit === undefined ? undefined : offset + options.limit)
        },
        async revision(path) {
          const leaf = target(path)
          if (leaf === undefined) return fallback.revision?.(path)
          get(leaf)
          return capture(source.turn).snapshot.revision
        },
        async stat(path) {
          const leaf = target(path)
          if (leaf === undefined) return fallback.stat(path)
          const entry = get(leaf)
          return { size: entry.bytes, mtimeMs: 0, kind: 'file' }
        },
        async list(path) {
          const absolute = canonical(resolve(input.workspaceRoot, path))
          if (!inside(paths.protectedRoot, absolute)) return fallback.list(path)
          active()
          if (absolute !== paths.root) throw fault('MEMORY_SCOPE_DENIED')
          return capture(source.turn).files.map((entry) => ({ name: entry.path, kind: 'file' as const }))
        },
        async write(path, content) {
          const leaf = target(path)
          if (leaf === undefined) return fallback.write(path, content)
          active()
          signal.throwIfAborted()
          const turn = capture(source.turn)
          const before = turn.files.find((entry) => entry.path === leaf) ?? file(leaf, '')
          // A whole file written from a view that leaves text out would silently drop that text.
          if (leaf === 'MEMORY.md' && turn.index.hidden) throw fault('MEMORY_HIDDEN_PARAGRAPHS')
          const candidate = file(
            leaf,
            typeof content === 'string' ? content : Buffer.from(content).toString('utf8'),
          )
          if (
            markerSet(candidate.content) !== markerSet(before.content) ||
            (leaf === 'MEMORY.md' && parseParagraphs(candidate.content).anomalies.length)
          )
            throw fault('MEMORY_MARKER_CHANGED')
          // A managed paragraph's text changes only by exact replacement or the paragraph port, so a
          // rewrite cannot pull other lines inside a paragraph (they would expire with it).
          if (leaf === 'MEMORY.md' && paragraphTexts(candidate.content) !== paragraphTexts(before.content))
            throw fault('MEMORY_PARAGRAPH_TEXT_CHANGED')
          await submit(leaf, before, candidate)
        },
        /**
         * Exact replacement re-reads the stored file, so several replacements in one turn compose and a
         * concurrent change is kept: the match must still be unique in the current view.
         */
        async replaceExact(path, oldText, newText) {
          const leaf = target(path)
          if (leaf === undefined) {
            if (fallback.replaceExact) return fallback.replaceExact(path, oldText, newText)
            throw fault('MEMORY_SCOPE_DENIED')
          }
          active()
          signal.throwIfAborted()
          const before = store.read(leaf)
          const view =
            leaf === 'MEMORY.md' ? paragraphView(before.content, validity) : plainView(before.content)
          await submit(leaf, before, file(leaf, replaceInView(before.content, view, oldText, newText)))
        },
      })
    },
    inspect,
    async configure(config) {
      await store.configure(config)
      return inspect()
    },
    async readFile(path) {
      return store.read(name(path))
    },
    paragraphs(source, signal) {
      return paragraphPort(store, paths.root, input.validity, source, signal)
    },
    userParagraphs(source, signal) {
      return userParagraphPort(user, store, input.userValidity, source, signal)
    },
    async editFile(path, content, baseHash) {
      return store.commit(
        file(name(path), content),
        baseHash,
        { sessionKey: input.sessionKey, turn: 0 },
        false,
      )
    },
  })
}

function passes(entry: MemoryFile, config: MemorySettings): boolean {
  try {
    validateContent(entry, config, true)
    return true
  } catch {
    return false
  }
}

function viewRevision(view: MemoryValidityView | undefined): string | null {
  if (!view) return null
  try {
    return String(view.revision())
  } catch {
    return 'unavailable'
  }
}

/** The shared agent write path: validate, review under ask, then compare-and-swap commit. */
async function reviewAndCommit(
  context: {
    store: MemoryStore
    root: string
    source: MemorySource
    signal: AbortSignal
    approve: (proposal: MemoryProposal) => Promise<MemoryApprovalResult>
    active: () => MemorySettings & { mode: 'ask' | 'auto' }
  },
  leaf: string,
  before: MemoryFile,
  candidate: MemoryFile,
): Promise<void> {
  const { store, source, signal, approve, active } = context
  const config = active()
  validateContent(candidate, config, leaf === 'MEMORY.md')
  const proposal: MemoryProposal = Object.freeze({
    path: join(context.root, leaf),
    baseHash: before.hash,
    newHash: candidate.hash,
    diff: diff(before.content, candidate.content),
    source,
  })
  let admission: MemoryEffectAdmission | undefined
  if (config.mode === 'ask') {
    const result = await approve(proposal)
    if (result.status === 'approved') admission = result.admission
    if (result.status === 'rejected') throw fault('MEMORY_APPROVAL_REJECTED')
    if (result.status !== 'approved')
      throw Object.assign(fault('MEMORY_APPROVAL_UNANSWERED'), {
        reason: result.reason,
        message: `MEMORY_APPROVAL_UNANSWERED: ${result.reason}`,
      })
  }
  signal.throwIfAborted()
  // A policy change during approval cannot silently convert it into an auto write.
  if (active().mode !== config.mode) throw fault('MEMORY_POLICY_CHANGED')
  await store.commit(candidate, before.hash, source, config.mode, signal, admission)
}
