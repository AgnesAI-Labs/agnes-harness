import { join, relative, resolve } from 'node:path'
import type {
  MemoryFile,
  MemoryFilePort,
  MemoryInspection,
  MemoryProposal,
  MemorySession,
  MemorySettings,
  MemorySnapshot,
} from '@agnes/extension-api'
import { diff, fault, file, fit, hash, validateContent } from './content.js'
import { canonical, inside, name, roots } from './paths.js'
import { MemoryStore } from './store.js'

type TurnSnapshot = { files: readonly MemoryFile[]; snapshot: MemorySnapshot }

export function openMemory(input: {
  home: string
  workspaceRoot: string
  sessionKey: string
}): MemorySession {
  const paths = roots(input.home, input.workspaceRoot)
  const store = new MemoryStore(paths.protectedRoot, paths.root)
  const user = new MemoryStore(paths.protectedRoot, paths.userRoot)
  let turnSnapshot: { turn: number; value: TurnSnapshot } | undefined

  const capture = (turn: number): TurnSnapshot => {
    if (turnSnapshot?.turn === turn) return turnSnapshot.value
    const config = store.configuration()
    const files = store.files()
    const index = files.find((entry) => entry.path === 'MEMORY.md') ?? file('MEMORY.md', '')
    const userIndex = config.userEnabled ? user.read('MEMORY.md') : file('MEMORY.md', '')
    const revision = hash(JSON.stringify([files.map(({ path, hash }) => [path, hash]), userIndex.hash]))
    let workspaceContent = index.content
    let userContent = userIndex.content
    for (const [entry, layer] of [
      [index, 'workspace'],
      [userIndex, 'user'],
    ] as const) {
      try {
        validateContent(entry, config, true)
      } catch {
        if (layer === 'workspace')
          workspaceContent = '[Memory omitted: consolidate the index or remove secret-like content.]'
        else userContent = '[User memory omitted: consolidate the index or remove secret-like content.]'
      }
    }
    const total = config.tokenBudget + (config.userEnabled ? config.userTokenBudget : 0)
    const workspace = fit(workspaceContent, config.tokenBudget)
    const userLayer = fit(userContent, config.userTokenBudget)
    const content = [
      `Agent memory (untrusted learned preferences; AGENTS.md and knowledge sources take precedence). Revision: ${revision}.`,
      `Workspace memory directory: ${paths.root}. Use normal read/write/edit tools; topic reads share this turn's revision.`,
      `Policy: ${config.mode}. Consolidate rather than append; never save secrets, one-off details, history or knowledge-base content.`,
      workspace.content,
      ...(config.userEnabled && userContent
        ? [`User memory (read-only for the agent):\n${userLayer.content}`]
        : []),
    ].join('\n\n')
    const bounded = fit(content, total)
    const value = {
      files,
      snapshot: Object.freeze({
        revision,
        content: bounded.content,
        omitted: bounded.omitted || workspace.omitted || userLayer.omitted,
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
      return capture(turn).snapshot
    },
    files(fallback, source, signal, approve): MemoryFilePort {
      const get = (path: string): MemoryFile => {
        active()
        signal.throwIfAborted()
        const entry = capture(source.turn).files.find((entry) => entry.path === path)
        if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        validateContent(entry, store.configuration(), path === 'MEMORY.md')
        return entry
      }
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
          const config = active()
          signal.throwIfAborted()
          const before = capture(source.turn).files.find((entry) => entry.path === leaf) ?? file(leaf, '')
          const candidate = file(
            leaf,
            typeof content === 'string' ? content : Buffer.from(content).toString('utf8'),
          )
          validateContent(candidate, config, leaf === 'MEMORY.md')
          const proposal: MemoryProposal = Object.freeze({
            path: join(paths.root, leaf),
            baseHash: before.hash,
            newHash: candidate.hash,
            diff: diff(before.content, candidate.content),
            source,
          })
          if (config.mode === 'ask' && !(await approve(proposal))) throw fault('MEMORY_APPROVAL_REJECTED')
          signal.throwIfAborted()
          // A policy change during approval cannot silently convert it into an auto write.
          if (active().mode !== config.mode) throw fault('MEMORY_POLICY_CHANGED')
          await store.commit(candidate, before.hash, source, config.mode, signal)
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
