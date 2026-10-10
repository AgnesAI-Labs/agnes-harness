import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WorktreeCreateResult, WorktreeEntry, WorktreeFinishResult } from '@agnes/git-worktree-contract'
import type { WorkspaceInvocationResolver } from './workspace-invocation-resolver.js'

/** Internal lease. Plugins never supply sessionKey. */
export type GitWorktreeOperation = { sessionKey: string; signal: AbortSignal; timeoutMs: number }
export interface GitWorktreeService {
  create(cwd: string, operation: GitWorktreeOperation): Promise<WorktreeCreateResult>
  list(operation: GitWorktreeOperation): Promise<readonly WorktreeEntry[]>
  finish(path: string, operation: GitWorktreeOperation): Promise<WorktreeFinishResult>
}

type Owned = WorktreeEntry & { stage: WorktreeEntry['stage']; creating?: boolean; removing?: boolean }
const ID = /^[0-9a-f]{8}$/
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** Trusted Host factory. No caller-supplied executable, argv, branch, root or ownership record. */
export function createGitWorktreeService(options: {
  workspaceRoot: string
  dataDir: string
  remote: boolean
}): GitWorktreeService {
  // Remote deployments must not inspect a coincidentally matching local directory.
  const workspace = options.remote ? options.workspaceRoot : realpathSync(options.workspaceRoot)
  const registry = join(options.dataDir, 'git-worktrees')
  const hooks = join(registry, 'empty-hooks')
  const key = (path: string) => createHash('sha256').update(path).digest('hex')
  const recordPath = (path: string) => join(registry, `${key(path)}.json`)
  const valid = (entry: Owned): boolean => {
    if (typeof entry.root !== 'string' || typeof entry.path !== 'string' || typeof entry.branch !== 'string')
      return false
    const id = entry.branch.slice('agnes/subagent-'.length)
    return (
      ID.test(id) &&
      entry.branch === `agnes/subagent-${id}` &&
      isAbsolute(entry.root) &&
      resolve(entry.root) === entry.root &&
      (inside(entry.root, workspace) || inside(workspace, entry.root)) &&
      entry.path === join(entry.root, '.worktrees', `agnes-${id}`) &&
      (entry.stage === 'attached' || entry.stage === 'worktree-removed')
    )
  }
  const save = (entry: Owned, initial = false): void => {
    mkdirSync(hooks, { recursive: true, mode: 0o700 })
    if (initial) {
      writeFileSync(recordPath(entry.path), JSON.stringify(entry), { mode: 0o600, flag: 'wx' })
      return
    }
    const temporary = `${recordPath(entry.path)}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, recordPath(entry.path))
  }
  const load = (path: string): Owned | undefined => {
    try {
      const entry: Owned = JSON.parse(readFileSync(recordPath(path), 'utf8'))
      return entry && valid(entry) && entry.path === path ? entry : undefined
    } catch {
      return undefined
    }
  }
  const entries = (): Owned[] => {
    try {
      return readdirSync(registry)
        .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
        .flatMap((name) => {
          const entry: Owned = JSON.parse(readFileSync(join(registry, name), 'utf8'))
          return entry && valid(entry) && name === `${key(entry.path)}.json` ? [entry] : []
        })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  const git = (
    argv: string[],
    cwd: string,
    op: GitWorktreeOperation,
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    op.signal.throwIfAborted()
    const timeout =
      Number.isFinite(op.timeoutMs) && op.timeoutMs > 0
        ? Math.min(30_000, Math.max(1, Math.floor(op.timeoutMs)))
        : 30_000
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
    return new Promise((accept, reject) => {
      execFile(
        'git',
        ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', ...argv],
        {
          cwd,
          env,
          shell: false,
          encoding: 'utf8',
          timeout,
          signal: op.signal,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') return reject(error)
          accept({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr })
        },
      )
    })
  }
  const registered = async (entry: Owned, op: GitWorktreeOperation): Promise<boolean> => {
    if (realpathSync(entry.root) !== entry.root) return false
    const result = await git(['worktree', 'list', '--porcelain', '-z'], entry.root, op)
    if (result.code !== 0) throw new Error('worktree inspection failed')
    return result.stdout.split('\0\0').some((row) => {
      const fields = row.split('\0')
      return (
        fields.includes(`worktree ${entry.path.split(sep).join('/')}`) &&
        fields.includes(`branch refs/heads/${entry.branch}`)
      )
    })
  }
  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn, fn)
    tail = result.catch(() => undefined)
    return result
  }
  return {
    create(cwd, op): Promise<WorktreeCreateResult> {
      return serial(async () => {
        if (options.remote) return { skipped: 'remote-sandbox' }
        try {
          const canonical = realpathSync(cwd)
          if (resolve(cwd) !== cwd || !inside(workspace, canonical)) return { skipped: 'git-error' }
          const top = await git(['rev-parse', '--show-toplevel'], canonical, op)
          if (top.code !== 0) return { skipped: 'not-git' }
          const root = top.stdout
            .replace(/\r?\n$/, '')
            .split('/')
            .join(sep)
          if (
            !isAbsolute(root) ||
            resolve(root) !== root ||
            /[\0\r\n]/.test(root) ||
            !inside(root, canonical) ||
            realpathSync(root) !== root
          )
            return { skipped: 'git-error' }
          const id = randomUUID().replaceAll('-', '').slice(0, 8)
          const path = join(root, '.worktrees', `agnes-${id}`)
          const branch = `agnes/subagent-${id}`
          if (existsSync(path) || existsSync(recordPath(path))) return { skipped: 'git-error' }
          const existingBranch = await git(
            ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
            root,
            op,
          )
          if (existingBranch.code !== 1) return { skipped: 'git-error' }
          const ignored = await git(['check-ignore', '--quiet', '--', `.worktrees/agnes-${id}`], root, op)
          if (ignored.code !== 0) return { skipped: 'git-error' }
          mkdirSync(join(root, '.worktrees'), { recursive: true })
          if (realpathSync(join(root, '.worktrees')) !== join(root, '.worktrees'))
            return { skipped: 'git-error' }
          const entry: Owned = { root, path, branch, stage: 'attached', creating: true }
          save(entry, true) // Crash during add retains ownership for inspection/recovery.
          const added = await git(['worktree', 'add', '-b', branch, path, 'HEAD'], root, op)
          if (added.code !== 0) return { skipped: 'git-error' }
          delete entry.creating
          save(entry)
          return { id, root, path, branch }
        } catch {
          return { skipped: 'git-error' }
        }
      })
    },
    list(op) {
      return serial(async () => {
        if (options.remote) return []
        const found: WorktreeEntry[] = []
        for (const entry of entries())
          if (entry.stage === 'attached' && (await registered(entry, op))) {
            found.push({ root: entry.root, path: entry.path, branch: entry.branch, stage: entry.stage })
          }
        return found
      })
    },
    finish(path, op): Promise<WorktreeFinishResult> {
      return serial(async () => {
        if (options.remote || !isAbsolute(path) || resolve(path) !== path)
          return { action: 'kept-inspection-failed' }
        const entry = load(path)
        let failureStage: 'worktree-remove' | 'branch-delete' | undefined
        if (!entry) return { action: 'kept-inspection-failed' }
        try {
          if (
            realpathSync(entry.root) !== entry.root ||
            realpathSync(join(entry.root, '.worktrees')) !== join(entry.root, '.worktrees')
          )
            return { action: 'kept-inspection-failed' }
          if (entry.stage === 'attached') {
            const attached = await registered(entry, op)
            if (!attached && !entry.removing) return { action: 'kept-inspection-failed' }
            if (attached) {
              if (realpathSync(path) !== path) return { action: 'kept-inspection-failed' }
              const status = await git(['status', '--porcelain=v1', '--untracked-files=all'], path, op)
              if (status.code !== 0) return { action: 'kept-inspection-failed' }
              if (status.stdout.length > 0) return { action: 'kept-dirty' }
              // No force: Git refuses raced-in changes or a locked worktree.
              failureStage = 'worktree-remove'
              entry.removing = true
              save(entry)
              const removed = await git(['worktree', 'remove', path], entry.root, op)
              if (removed.code !== 0) return { action: 'cleanup-failed', stage: 'worktree-remove' }
            }
            entry.stage = 'worktree-removed'
            delete entry.creating
            delete entry.removing
            save(entry)
          }
          // Never -D: retain child commits until the parent merges/reviews them.
          failureStage = 'branch-delete'
          const remaining = await git(
            ['show-ref', '--verify', '--quiet', `refs/heads/${entry.branch}`],
            entry.root,
            op,
          )
          if (remaining.code === 1) {
            rmSync(recordPath(path))
            return { action: 'removed' }
          }
          if (remaining.code !== 0) return { action: 'cleanup-failed', stage: 'branch-delete' }
          const branch = await git(['branch', '-d', entry.branch], entry.root, op)
          if (branch.code !== 0)
            return /not fully merged|not merged/i.test(branch.stderr)
              ? { action: 'kept-unmerged' }
              : { action: 'cleanup-failed', stage: 'branch-delete' }
          rmSync(recordPath(path))
          return { action: 'removed' }
        } catch {
          return failureStage
            ? { action: 'cleanup-failed', stage: failureStage }
            : { action: 'kept-inspection-failed' }
        }
      })
    },
  }
}

/** Resolve workspace identity under a live Host lease, never from caller cwd or session data. */
export function createSessionGitWorktreeService(options: {
  workspaceInvocationFor: WorkspaceInvocationResolver
  dataDir: string
  remote: boolean
  signal: AbortSignal
}): GitWorktreeService {
  const services = new Map<string, GitWorktreeService>()
  const withService = <T>(
    op: GitWorktreeOperation,
    invoke: (service: GitWorktreeService, operation: GitWorktreeOperation) => Promise<T>,
  ): Promise<T> =>
    options.workspaceInvocationFor(op.sessionKey).run(async (view) => {
      let service = services.get(view.root)
      if (!service) {
        service = createGitWorktreeService({
          workspaceRoot: view.root,
          dataDir: options.dataDir,
          remote: options.remote,
        })
        services.set(view.root, service)
      }
      return invoke(service, { ...op, signal: AbortSignal.any([op.signal, options.signal]) })
    })
  return {
    create: (cwd, op) => withService(op, (service, operation) => service.create(cwd, operation)),
    list: (op) => withService(op, (service, operation) => service.list(operation)),
    finish: (path, op) => withService(op, (service, operation) => service.finish(path, operation)),
  }
}
