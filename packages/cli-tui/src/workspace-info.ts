import { homedir } from 'node:os'
import { basename, dirname, sep } from 'node:path'
import { execGit } from './git-command.js'

/** What the composer rail says about where the CLI runs. Raw text: the renderer sanitizes it. */
export type WorkspaceInfo = {
  /** Main repository root, or the directory itself outside git, with the home directory as `~`. */
  root: string
  /** The directory below `root`, `''` at the root. */
  subpath: string
  /** Linked worktree name, only inside a linked worktree. */
  worktree?: string
  branch?: string
  /** Short commit id while HEAD is detached. */
  detached?: string
  /** Commits on the branch that its upstream does not have; absent without an upstream or on error. */
  ahead?: number
}

/** `signal` aborts when the asker stops; a probe should end its child processes then. */
export type WorkspaceProbe = (cwd: string, signal?: AbortSignal) => Promise<WorkspaceInfo>

const TIMEOUT_MS = 1_000

export function tildePath(path: string, home = homedir()): string {
  // Display paths only: Git uses '/', including on Windows; filesystem callers retain native paths.
  const display = path.split(sep).join('/')
  const base = home.split(sep).join('/')
  return base && (display === base || display.startsWith(`${base}/`))
    ? `~${display.slice(base.length)}`
    : display
}

/** One fixed-argument git call without a shell; any failure, timeout or missing git reads as no answer. */
function git(cwd: string, args: string[], signal: AbortSignal): Promise<string | undefined> {
  // A bare `git` on Windows would first run any git.exe in the folder being shown.
  return execGit(cwd, args, { signal, maxBuffer: 64 * 1024 })
}

/** Reads the repository facts for `cwd`, degrading to the bare directory whenever git cannot answer. */
export async function readWorkspaceInfo(
  cwd: string,
  options: { home?: string; signal?: AbortSignal } = {},
): Promise<WorkspaceInfo> {
  const home = options.home ?? homedir()
  // A caller's signal (the app stopping) ends the probe early; the timeout always applies.
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const fallback = { root: tildePath(cwd, home), subpath: '' }
  // Absolute paths make the git dirs comparable; --show-prefix stays relative, which is what we show.
  const paths = await git(
    cwd,
    [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-dir',
      '--git-common-dir',
      '--show-prefix',
    ],
    signal,
  )
  const [top, gitDir, commonDir, prefix = ''] = paths?.split('\n') ?? []
  if (!top || !gitDir || !commonDir) return fallback
  const linked = gitDir !== commonDir
  const root = linked && basename(commonDir) === '.git' ? dirname(commonDir) : top
  // Separate from rev-parse above: a repository without commits has a branch but no HEAD commit.
  const branch = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal))?.trim()
  const detached = branch ? undefined : (await git(cwd, ['rev-parse', '--short', 'HEAD'], signal))?.trim()
  // Fixed arguments, no shell; no upstream, a timeout or any other failure leaves the field out.
  const count = branch
    ? Number((await git(cwd, ['rev-list', '--count', '@{upstream}..HEAD'], signal))?.trim())
    : Number.NaN
  return {
    root: tildePath(root, home),
    subpath: prefix.replace(/\/$/, ''),
    ...(linked ? { worktree: basename(top) } : {}),
    ...(branch ? { branch } : {}),
    ...(detached ? { detached } : {}),
    ...(Number.isSafeInteger(count) && count >= 0 ? { ahead: count } : {}),
  }
}

/** The real probe, as the app runs it. */
export const probeWorkspace: WorkspaceProbe = (cwd, signal) =>
  readWorkspaceInfo(cwd, signal ? { signal } : {})

/**
 * Keeps at most one probe in flight. A refresh asked for mid-read runs once more after it, so the
 * last request always sees the state it was asked about. `dispose` stops the probe in flight and
 * settles once its git children have exited: they run in the workspace, and Windows cannot remove a
 * folder some process runs in.
 */
export function workspaceRefresher(
  cwd: string | (() => string),
  probe: WorkspaceProbe,
  apply: (info: WorkspaceInfo) => void,
): (() => void) & { dispose(): Promise<void> } {
  const stopping = new AbortController()
  let running: Promise<void> | undefined
  let again = false
  const run = (): void => {
    running = probe(typeof cwd === 'string' ? cwd : cwd(), stopping.signal)
      .then(
        (info) => {
          if (!stopping.signal.aborted) apply(info)
        },
        () => {},
      )
      .finally(() => {
        running = undefined
        if (again && !stopping.signal.aborted) {
          again = false
          run()
        }
      })
  }
  const refresh = () => {
    if (stopping.signal.aborted) return
    if (running) again = true
    else run()
  }
  return Object.assign(refresh, {
    dispose: async () => {
      stopping.abort()
      await running
    },
  })
}
