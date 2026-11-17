// Adapted from dsh-superagent (MIT)
/** The environment of the git processes the tests start. */
import { GIT_LOCATION } from '../../src/infra/worker-paths.js'

/**
 * The process environment with `extra`, and without the variables that tell git which repository to act on (`GIT_LOCATION`):
 * the tests run inside `git rebase --exec` inherit GIT_DIR, and a `git init` there would reinitialize the repository under test.
 */
export const gitEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> => ({
  ...process.env,
  ...Object.fromEntries(GIT_LOCATION.map((name) => [name, undefined])),
  ...extra,
})
