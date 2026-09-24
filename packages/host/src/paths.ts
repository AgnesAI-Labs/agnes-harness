import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, sep } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'
import { HostError } from './errors.js'

/**
 * The one place in this package that knows the on-disk shape of an Agnes home directory. Two call
 * sites once computed dataDir differently -- one treated the home root itself as the default, the
 * other defaulted to `home/data` -- and a machine that hit both ended up with two parallel session
 * trees, neither one aware the other existed. Routing every caller through here instead of letting
 * each one join its own strings is what keeps that from happening again: nobody downstream has
 * enough of the layout in view to reconstruct it, so nobody can reconstruct it differently.
 *
 * The home root is a container, not a workspace. `dataDir` and `cacheDir` are always one level
 * below it, never the root itself. This design prevents accidental parallel session trees when
 * different processes compute paths differently.
 */

/** An empty string counts as unset for every home variable, matching the CLI's existing rule. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}

let legacyHomeNoticeSent = false

/**
 * The Agnes home root: AGH_HOME when set, else the legacy AGNES_HOME, else `<os home>/.agh`. A
 * relative value is refused rather than resolved against the current working directory -- a daemon
 * and the one-shot CLI invocations that talk to it rarely share a cwd, so a relative value would
 * silently pick a different home depending on where a process happened to start. This is rejected
 * to prevent configuration divergence.
 *
 * AGNES_HOME still works during the rename but says so once per process. Nothing here ever falls
 * back to `~/.agnes`: that directory may belong to another product, so it is reached only when a
 * user names it explicitly.
 */
export function agnesHome(env: Readonly<Record<string, string | undefined>>): string {
  const current = nonEmpty(env.AGH_HOME)
  const explicit = current ?? nonEmpty(env.AGNES_HOME)
  const selected = explicit ?? nonEmpty(env.HOME) ?? homedir()
  const variable = current !== undefined ? 'AGH_HOME' : explicit !== undefined ? 'AGNES_HOME' : 'HOME'
  // On Windows /foo is rooted but still depends on the launching process's current drive.
  const invalidWindowsHome = sep === '\\' && (!isAbsolute(selected) || parse(selected).root.length <= 1)
  if (invalidWindowsHome || (explicit !== undefined && !isAbsolute(explicit)))
    throw new HostError(
      'E_HOME_INVALID',
      `${variable} must be ${invalidWindowsHome ? 'a fully qualified' : 'an'} absolute path, got ${JSON.stringify(selected)}`,
      {
        detail: { variable, value: selected },
      },
    )
  if (variable === 'AGNES_HOME' && !legacyHomeNoticeSent) {
    legacyHomeNoticeSent = true
    process.emitWarning(`AGNES_HOME is deprecated; set AGH_HOME instead (using ${selected}).`, {
      type: 'DeprecationWarning',
      code: 'AGH_DEP_AGNES_HOME',
    })
  }
  return explicit ?? join(selected, AGH_DIR)
}

/** Session database, tables and audit log: always a subdirectory of home, never the root itself. */
export function dataDir(home: string): string {
  return join(home, 'data')
}

/** Downloaded and compiled artifacts (the jiti loader cache, etc.): also always a subdirectory. */
export function cacheDir(home: string): string {
  return join(home, 'cache')
}

/** One path inside dataDir, for a caller that wants a file or child directory, not the root. */
export function inDataDir(home: string, sub: string): string {
  return join(dataDir(home), sub)
}

/**
 * Where a pre-fix installation -- or any profile that left dataDir unset before the default moved
 * -- would have written its session database: directly under the home root instead of under
 * `data/`. This is detection only. Nothing in this module reads the file, moves it or deletes it;
 * whether a database sitting here still matters is a call only the person who owns the data can
 * make, so the most this function does is make the question answerable.
 */
export function legacySessionsDbPath(home: string): string {
  return join(home, 'sessions.db')
}

/** True when a database from the old home-root default is still sitting where doctor can find it. */
export function hasLegacySessionsDb(home: string): boolean {
  return existsSync(legacySessionsDbPath(home))
}
