import { homedir } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { findTsserver } from './resolve.js'

/** The workspace directory holding language server caches. */
export const CACHE_DIR = '.agnes-lsp'

export type ServerDef = Readonly<{
  id: string
  /** Extension (with dot) -> LSP languageId. */
  languages: Readonly<Record<string, string>>
  rootMarkers: readonly string[]
  /** A marker met before any root marker means this server does not apply (for example Deno). */
  excludeMarkers?: readonly string[]
  /** Tried in order; the first that starts and initializes wins. Bare names, resolved on PATH. */
  commands: readonly (readonly string[])[]
  /** Launch options that keep the server from executing workspace code; `unavailable` if that cannot be arranged. */
  settings?: (where: { workspaceRoot: string; binary: string }) => LaunchSettings
  /** Set when the server cannot be started in an untrusted workspace; the text is the reason shown. */
  needsTrust?: string
}>
export type LaunchSettings =
  | {
      initializationOptions?: unknown
      env?: Record<string, string>
      /** A workspace directory the server writes its caches to; it is made to ignore itself for git before launch. */
      cacheDir?: string
    }
  | { unavailable: string }

// Workspace-local binaries (node_modules/.bin, .venv/bin) are deliberately not searched: running one
// is running repository code, and a tool context carries no Host signal that the workspace is
// trusted. Until it does, only what is on PATH is started, and even those are started so they run no
// workspace code: tsserver is pinned to the copy installed beside the server (no workspace
// typescript, no plugins), rust-analyzer runs no build scripts, proc macros or cargo check, and gopls
// downloads nothing and rewrites no go.mod. pyright is static and needs no change.
export const SERVERS: readonly ServerDef[] = [
  {
    id: 'typescript',
    languages: {
      '.ts': 'typescript',
      '.mts': 'typescript',
      '.cts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.jsx': 'javascriptreact',
    },
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    excludeMarkers: ['deno.json', 'deno.jsonc'],
    commands: [['typescript-language-server', '--stdio']],
    settings: ({ workspaceRoot, binary }) => {
      const path = findTsserver(binary, workspaceRoot)
      return path
        ? {
            initializationOptions: {
              tsserver: { path },
              plugins: [],
              disableAutomaticTypingAcquisition: true,
            },
          }
        : {
            unavailable:
              'typescript: no non-workspace tsserver found next to the typescript-language-server on PATH',
          }
    },
  },
  {
    id: 'python',
    languages: { '.py': 'python', '.pyi': 'python' },
    rootMarkers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'pyrightconfig.json'],
    commands: [
      ['pyright-langserver', '--stdio'],
      ['basedpyright-langserver', '--stdio'],
    ],
  },
  {
    id: 'go',
    languages: { '.go': 'go' },
    rootMarkers: ['go.work', 'go.mod'],
    commands: [['gopls']],
    // gopls exits at startup when it cannot create its cache, and a sandboxed session may write only inside
    // the workspace, where the real cache directories are read-only. So just the two writable caches move to
    // `.agnes-lsp` in the workspace, which ignores itself for git. HOME stays the user's own and is never
    // pointed at repository content: a planted go env file, .gitconfig or toolchain would be run by the go
    // command. GOENV=off ignores the go env file, an explicit GOFLAGS replaces any other, cgo and the
    // user's git config are off, and the module cache is the real one, read only.
    settings: ({ workspaceRoot }) => {
      const gopath = process.env.GOPATH ?? join(process.env.HOME ?? homedir(), 'go')
      const cache = join(workspaceRoot, CACHE_DIR)
      return {
        cacheDir: cache,
        env: {
          GOENV: 'off',
          GOTOOLCHAIN: 'local',
          GOPROXY: 'off',
          GOFLAGS: '-mod=readonly',
          CGO_ENABLED: '0',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GOPLSCACHE: join(cache, 'gopls'),
          GOCACHE: join(cache, 'go-build'),
          GOPATH: gopath,
          GOMODCACHE: process.env.GOMODCACHE ?? join(gopath.split(delimiter)[0] ?? gopath, 'pkg', 'mod'),
        },
      }
    },
  },
  {
    id: 'rust',
    languages: { '.rs': 'rust' },
    rootMarkers: ['Cargo.toml'],
    commands: [['rust-analyzer']],
    // Cargo config (rustc-wrapper, build overrides), rust-analyzer.toml and rust-toolchain.toml can all run
    // or select workspace code, so it only starts in a trusted workspace; even then nothing is built.
    needsTrust: 'Rust analysis needs a trusted workspace (it runs Cargo)',
    settings: () => ({
      initializationOptions: {
        cargo: { buildScripts: { enable: false } },
        procMacro: { enable: false },
        checkOnSave: false,
      },
      env: { RUSTC_WRAPPER: '' },
    }),
  },
]

export function serverFor(path: string): { def: ServerDef; languageId: string } | undefined {
  const ext = extname(path).toLowerCase()
  for (const def of SERVERS) {
    const languageId = def.languages[ext]
    if (languageId) return { def, languageId }
  }
  return undefined
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * The nearest directory above `file` holding a root marker, never above `boundary`. No marker means
 * the boundary itself; an exclude marker met first means the server does not apply (undefined). A
 * file outside the boundary (an admitted extra directory) is rooted at its own directory.
 */
export async function findRoot(
  exists: (path: string) => Promise<boolean>,
  file: string,
  boundary: string,
  def: ServerDef,
): Promise<string | undefined> {
  if (!inside(boundary, file)) return dirname(file)
  for (let dir = dirname(file); inside(boundary, dir); dir = dirname(dir)) {
    for (const marker of def.excludeMarkers ?? []) if (await exists(join(dir, marker))) return undefined
    for (const marker of def.rootMarkers) if (await exists(join(dir, marker))) return dir
    if (dir === boundary || dirname(dir) === dir) break
  }
  return boundary
}
