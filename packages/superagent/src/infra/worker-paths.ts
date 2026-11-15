// Adapted from dsh-superagent (MIT)
/** Paths and process-environment names the worker environment shares with deployment and policy checks. */
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path
    .split(delimiter)
    .filter((entry) => !sameDirectory(entry, dir))
    .join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
]
