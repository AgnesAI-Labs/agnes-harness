// Adapted from dsh-superagent (MIT)
/** Paths and process-environment names the worker environment shares with deployment and policy checks. */
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { HOST_PLATFORM, isWindows } from './platform.js'

/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
/** The git configuration Superagent's sessions and commands use in place of the operator's global and system ones. */
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')

/** A PATH entry without the quotes Windows allows around it. */
export const unquoted = (entry: string): string => entry.replace(/^"(.*)"$/, '$1')

/** Whether `a` and `b` are one directory, following links; on Windows names compare without case. */
export function sameDirectory(a: string, b: string, platform: string = HOST_PLATFORM): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  return isWindows(platform)
    ? real(unquoted(a)).toLowerCase() === real(unquoted(b)).toLowerCase()
    : real(a) === real(b)
}
export function withoutDirectory(
  path: string,
  dir: string,
  separator: string = delimiter,
  platform: string = HOST_PLATFORM,
): string {
  return path
    .split(separator)
    .filter((entry) => !sameDirectory(entry, dir, platform))
    .join(separator)
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
