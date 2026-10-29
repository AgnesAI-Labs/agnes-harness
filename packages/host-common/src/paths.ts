import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, sep } from 'node:path'
import { AGH_DIR, WORKSPACE_SECRET_DIRS } from '@agnes/protocol'
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

/**
 * The Agnes home root: AGH_HOME when set, otherwise `<os home>/.agh`.
 * Relative paths are refused so clients and daemons cannot select different homes by cwd.
 * The retired AGNES_HOME variable is rejected even when AGH_HOME is also set.
 */
export function agnesHome(env: Readonly<Record<string, string | undefined>>): string {
  if (nonEmpty(env.AGNES_HOME) !== undefined)
    throw new HostError(
      'E_HOME_INVALID',
      'AGNES_HOME is no longer supported; unset it and set AGH_HOME to a new, empty private directory (clean home).',
      { detail: { variable: 'AGNES_HOME', reason: 'clean-home-required' } },
    )
  const explicit = nonEmpty(env.AGH_HOME)
  const selected = explicit ?? nonEmpty(env.HOME) ?? homedir()
  const variable = explicit !== undefined ? 'AGH_HOME' : 'HOME'
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
  return explicit ?? join(selected, AGH_DIR)
}

/** Session database, tables and audit log: always a subdirectory of home, never the root itself. */
export function dataDir(home: string): string {
  return join(home, 'data')
}

/**
 * API keys and the default file-secrets adapter. This is the directory
 * `createCredentialStore({ root: home })` writes, beside `data/`, never inside it.
 */
export function fileSecretsDir(home: string): string {
  return join(home, 'secrets')
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

/**
 * Additional write refusals under full file access, layered over the main private-state fence.
 * These roots do not grant reads: credentials and profiles remain hard-denied by privateStateRoots.
 * They sit beside `data/` in the home root, so the data fence does not cover them. The home is inferred only from the conventional layout - `<home>/profiles/<name>` for
 * the profile directory, `<home>/data` for the data directory - and never guessed from anything
 * else, so an unconventional layout narrows the guard instead of widening it to a stranger's
 * directory. A profile that pins its own secrets directory has that listed too.
 */
/** The installation homes the conventional layout implies; an unconventional layout names none. */
export function ownHomes(paths: { profileDir: string; dataDir: string }): string[] {
  const homes = new Set<string>()
  if (basename(dirname(paths.profileDir)) === 'profiles') homes.add(dirname(dirname(paths.profileDir)))
  if (basename(paths.dataDir) === 'data') homes.add(dirname(paths.dataDir))
  return [...homes]
}

export function ownStateRoots(paths: {
  profileDir: string
  dataDir: string
  secretsDir?: string | undefined
}): string[] {
  const roots = [paths.profileDir]
  for (const home of ownHomes(paths))
    roots.push(fileSecretsDir(home), join(home, 'auth'), join(home, 'profiles'))
  if (paths.secretsDir !== undefined) roots.push(paths.secretsDir)
  return [...new Set(roots)]
}

/** Host-owned private state, shared by command/PTY and confined MCP policy compilers.
 * Callers supply the actual installation home; canonicalization and alias masks belong to their fence.
 */
export function privateStateRoots(paths: {
  home: string
  dataDir: string
  workspace?: string
  profileDir?: string
  secretsDir?: string
}): string[] {
  const workspace = paths.workspace
  return [
    ...new Set([
      ...['secrets', 'auth', 'profiles', 'daemon', 'memory'].map((leaf) => join(paths.home, leaf)),
      join(paths.dataDir, 'secrets'),
      join(paths.dataDir, 'daemon'),
      ...(workspace ? WORKSPACE_SECRET_DIRS.map((leaf) => join(workspace, leaf)) : []),
      ...(paths.profileDir ? [paths.profileDir] : []),
      ...(paths.secretsDir ? [paths.secretsDir] : []),
    ]),
  ]
}
