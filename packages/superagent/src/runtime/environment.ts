// Adapted from dsh-superagent (MIT)
/**
 * The agent's identity for Superagent's sessions, set up as dsh-superagent does. Superagent writes the shims directory
 * (`<stateDir>/worker-bin`: a `gh` that runs the agent's GitHub CLI, and a failing shim per blocked command) and the
 * agent's git configuration (`<stateDir>/worker-gitconfig`), and opens every session it runs with its own environment
 * (`agentSessionEnvironment`): the shims first on PATH, that git configuration in place of the operator's global and
 * system ones, no git prompts and no ambient GitHub tokens. The daemon starts as usual; the operator's own identity
 * stays out of those sessions. These are default-path guardrails, not isolation: a full-access session runs as the
 * operator's OS user.
 */
import { existsSync, realpathSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { SessionEnvironment } from '@agnes/protocol'
import { runCommand } from '../app/subprocess.js'
import { executable } from '../deployment.js'
import { retryBusy } from '../infra/busy.js'
import { HOST_PLATFORM, isWindows, mergeVariables, pathDelimiter, variable } from '../infra/platform.js'
import { workerBin, workerGitConfig } from '../infra/worker-paths.js'
import { SetupError } from '../setup.js'
import { checkWindowsShim, windowsBlockedShim, windowsGhShim } from './windows-shims.js'

const MARKER = '# Written by Superagent on every start; edits are lost.'
/** The marker of a Windows shim, a batch comment. */
const WINDOWS_SHIM_MARKER = `rem ${MARKER}`
/** Commands sessions need, which the blocked commands cannot shadow. */
const NEEDED: ReadonlySet<string> = new Set(['gh', 'git'])
/** The variables the platform passes to a session's commands before the session's own environment applies. */
const SESSION_VARIABLES = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'] as const
/** On Windows the platform's floor also holds what Windows programs need to start and find the user's profile. */
const WINDOWS_SESSION_VARIABLES = [
  ...SESSION_VARIABLES,
  'TEMP',
  'TMP',
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
] as const
/** Variables that would make `gh` act with a token instead of the agent's login. */
const GH_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST']
const CHECK_MS = 60_000

/** What the agent's environment is written from. */
export interface EnvironmentConfig {
  /** The agent's GitHub login, which commits are authored as and `gh` must act as. */
  login: string
  /** The agent's commit email. */
  email: string
  /** Commands sessions must not run; each gets a shim that fails. */
  blocked: readonly string[]
  /**
   * The agent's GitHub CLI, such as a `gh-agent` wrapper that runs `gh` with the agent's own configuration directory:
   * a command name resolved on PATH without the shims, or an absolute path. Defaults to `gh`.
   */
  cli?: string
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`
const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
/** Windows paths compare without case, and git names a file with forward slashes there. */
const samePath = (a: string, b: string, platform: string): boolean =>
  isWindows(platform) ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b)
const within = (path: string, directory: string): boolean => {
  const rest = relative(real(directory), real(path))
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest))
}

/**
 * The agent's GitHub CLI, resolved from `name` on `path` without the shims. A CLI inside the shims directory, such as
 * the `gh` shim itself named by its path, would run itself forever, so it is refused.
 * @throws SetupError `agentCliInShims` for such a CLI, `agentCliMissing` when it is not an executable.
 */
function agentCli(name: string, env: NodeJS.ProcessEnv, shimsDir: string, platform: string): string {
  if (isAbsolute(name) && within(name, shimsDir))
    throw new SetupError('agentCliInShims', { cli: name, shims: shimsDir })
  let cli: string
  try {
    cli = executable(name, variable(env, 'PATH', platform) ?? '', shimsDir, platform, env)
  } catch (error) {
    throw new SetupError('agentCliMissing', { output: reason(error) })
  }
  if (within(cli, shimsDir)) throw new SetupError('agentCliInShims', { cli: name, shims: shimsDir })
  return cli
}

/**
 * The `.netrc` (or `_netrc`) in `home` that holds a github.com or a default entry, if any. git's HTTP transport reads
 * it before it asks any credential helper, so such an entry would sign the agent's pushes in as whoever wrote it.
 */
async function githubNetrc(home: string | undefined): Promise<string | undefined> {
  if (!home) return undefined
  for (const name of ['.netrc', '_netrc']) {
    const file = join(home, name)
    const text = await readFile(file, 'utf8').catch(() => undefined)
    if (text === undefined) continue
    const tokens = text.replace(/#.*$/gm, '').split(/\s+/)
    if (
      tokens.some(
        (token, at) =>
          token === 'default' || (token === 'machine' && tokens[at + 1]?.toLowerCase() === 'github.com'),
      )
    )
      return file
  }
  return undefined
}

/**
 * The environment Superagent opens each of its sessions with, and its own commands run with: the shims first on PATH,
 * the agent's git configuration in place of the operator's global and system ones, git never prompting, and no ambient
 * GitHub token. The platform applies it after its own reduction of the daemon's environment.
 */
export function agentSessionEnvironment(stateDir: string): SessionEnvironment {
  return {
    pathPrepend: [workerBin(stateDir)],
    set: {
      GIT_CONFIG_GLOBAL: workerGitConfig(stateDir),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
    },
    unset: ['GH_TOKEN', 'GITHUB_TOKEN'],
  }
}

/**
 * `environment` over `base`, as the platform applies a session's environment to a command's. On Windows, where
 * variable names compare without case, the directories go first on an existing `Path` rather than into a second key.
 */
export function withEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  environment: SessionEnvironment,
  platform: string = HOST_PLATFORM,
): Record<string, string> {
  const removed = Object.fromEntries((environment.unset ?? []).map((name) => [name, undefined]))
  const env = mergeVariables([base, removed, environment.set ?? {}], platform)
  if (environment.pathPrepend?.length) {
    const fold = (name: string) => (isWindows(platform) ? name.toUpperCase() : name)
    const key = Object.keys(env).find((name) => fold(name) === 'PATH') ?? 'PATH'
    env[key] = [...environment.pathPrepend, ...(env[key] ? [env[key]] : [])].join(pathDelimiter(platform))
  }
  return env
}

/**
 * The variables Superagent's own commands (the prepare command, its git and `gh`) run with once the environment check
 * passed: the shims first on PATH and the agent's git configuration, as in its sessions.
 */
export function agentCommandVariables(
  stateDir: string,
  path = process.env.PATH ?? '',
  platform: string = HOST_PLATFORM,
): Record<string, string> {
  return withEnvironment({ PATH: path }, agentSessionEnvironment(stateDir), platform)
}

/**
 * The credential helper git runs for github.com: the agent's GitHub CLI. Git runs a `!` helper with a POSIX shell, Git
 * for Windows' own too, so on Windows the path is written with forward slashes, which that shell reads as a path.
 */
export const credentialHelper = (cli: string, platform: string = HOST_PLATFORM): string =>
  `!${shellQuote(isWindows(platform) ? cli.replaceAll('\\', '/') : cli)} auth git-credential`

/**
 * True when `file` is a regular file with `marker` as one of its first two lines (without a carriage return); a link
 * or directory never counts.
 */
async function written(file: string, marker = MARKER): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const lines = (await readFile(file, 'utf8')).split('\n', 2)
  return marker === MARKER ? lines.includes(MARKER) : lines.some((line) => line.replace(/\r$/, '') === marker)
}
/** Refuses a file that exists and was not written here. */
async function claim(file: string): Promise<void> {
  let foreign = false
  try {
    foreign = !(await written(file))
  } catch {
    /* The file does not exist yet. */
  }
  if (foreign) throw new SetupError('foreignFile', { file })
}
/**
 * Writes through a temporary file and a rename, so a concurrent reader never sees a partial file. A file another
 * program holds, as a running shim on Windows, is retried a few times.
 */
async function replace(file: string, text: string, mode: number, platform: string): Promise<void> {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`)
  await writeFile(temporary, text, { mode })
  await retryBusy(() => rename(temporary, file), platform)
}

/**
 * Writes the agent's environment into the state directory: in `worker-bin` a `gh` that runs the agent's GitHub CLI
 * without ambient tokens, and a failing shim per blocked command; and `worker-gitconfig`, which names the agent, resets
 * every credential helper before adding the agent's GitHub CLI for github.com only, rewrites SSH GitHub URLs to HTTPS,
 * turns askPass off and defines the LFS filters. Nothing is written when either place holds a file this program did
 * not write.
 * @throws SetupError `foreignFile` for such a file, `agentCliMissing` when the agent's GitHub CLI is not an executable,
 * `agentCliInShims` when it is inside the shims directory.
 */
export async function writeEnvironment(
  stateDir: string,
  cfg: EnvironmentConfig,
  platform: string = HOST_PLATFORM,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const shimsDir = workerBin(stateDir)
  const windows = isWindows(platform)
  const cli = agentCli(cfg.cli ?? 'gh', env, shimsDir, platform)
  // The sessions' PATH: the shims first on the daemon's.
  if (windows) checkWindowsShim(shimsDir, cli, `${shimsDir};${variable(env, 'PATH', platform) ?? ''}`)
  await mkdir(shimsDir, { recursive: true })
  const before = await readdir(shimsDir)
  for (const name of before) {
    const file = join(shimsDir, name)
    if (!(await written(file, windows ? WINDOWS_SHIM_MARKER : MARKER)))
      throw new SetupError('foreignFile', { file })
  }
  const gitconfig = workerGitConfig(stateDir)
  await claim(gitconfig)

  const kept = new Set<string>()
  if (windows) {
    // `.cmd` files, which PowerShell and cmd find on PATH by PATHEXT; see `windows-shims.ts`.
    const shim = async (name: string, text: string): Promise<void> => {
      await replace(join(shimsDir, `${name}.cmd`), text, 0o755, platform)
      kept.add(`${name}.cmd`)
    }
    await shim('gh', windowsGhShim(WINDOWS_SHIM_MARKER, cli, GH_TOKENS))
    // File names compare without case on Windows: `GH` would be the gh shim's file.
    const names = new Set(cfg.blocked.map((command) => command.toLowerCase()))
    for (const name of [...names].filter((command) => !NEEDED.has(command))) {
      const message = `${name} is blocked in this installation; use gh, which acts as ${cfg.login}.`
      await shim(name, windowsBlockedShim(WINDOWS_SHIM_MARKER, message))
    }
  } else await writePosixShims(shimsDir, cli, cfg, kept)
  // The Windows shims are kept in lower case, and a file there keeps the case it had.
  for (const name of before)
    if (!kept.has(windows ? name.toLowerCase() : name))
      await retryBusy(() => unlink(join(shimsDir, name)), platform)
  await replace(gitconfig, gitConfigText(cfg, cli, platform), 0o644, platform)
}

/** The POSIX shims: `#!/bin/sh` scripts, as the original writes them. */
async function writePosixShims(
  shimsDir: string,
  cli: string,
  cfg: EnvironmentConfig,
  kept: Set<string>,
): Promise<void> {
  const shim = async (name: string, body: string): Promise<void> => {
    await replace(join(shimsDir, name), `#!/bin/sh\n${MARKER}\n${body}\n`, 0o755, 'posix')
    kept.add(name)
  }
  // Without the shims on PATH, a wrapper that calls `gh` by name reaches the real one rather than this shim again.
  const withoutShims = [
    `self=${shellQuote(shimsDir)}`,
    'rest=',
    'IFS=:',
    'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f',
    'unset IFS',
    'PATH=$rest',
    'export PATH',
  ].join('\n')
  await shim('gh', [withoutShims, `unset ${GH_TOKENS.join(' ')}`, `exec ${shellQuote(cli)} "$@"`].join('\n'))
  for (const name of new Set(cfg.blocked.filter((command) => !NEEDED.has(command)))) {
    const message = `${name} is blocked in this installation; use gh, which acts as ${cfg.login}.`
    await shim(name, `echo ${shellQuote(message)} >&2\nexit 1`)
  }
}

/** The agent's git configuration; Windows adds `core.longpaths`, as checkouts there reach the 260-character limit. */
function gitConfigText(cfg: EnvironmentConfig, cli: string, platform: string): string {
  const text = [
    MARKER,
    '[user]',
    `\tname = ${gitQuote(cfg.login)}`,
    `\temail = ${gitQuote(cfg.email)}`,
    '\tuseConfigOnly = true',
    // The empty value drops every helper configured before this file.
    '[credential]',
    '\thelper =',
    '[credential "https://github.com"]',
    `\thelper = ${gitQuote(credentialHelper(cli, platform))}`,
    '[url "https://github.com/"]',
    '\tinsteadOf = git@github.com:',
    '\tinsteadOf = ssh://git@github.com/',
    // When the agent's helper has no answer, git fails rather than asking anyone.
    '[core]',
    '\taskPass =',
    ...(isWindows(platform) ? ['\tlongpaths = true'] : []),
    // The operator's own git configuration, which usually holds the LFS filters, is not read.
    '[filter "lfs"]',
    '\tclean = git-lfs clean -- %f',
    '\tsmudge = git-lfs smudge -- %f',
    '\tprocess = git-lfs filter-process',
    '\trequired = true',
  ].join('\n')
  return `${text}\n`
}

/**
 * Runs `argv` with only what a session's command gets from `env`: the variables the platform passes, then `session`,
 * the session's own environment, as the platform applies it. The daemon's `GIT_CONFIG_*` and tokens stay out.
 */
function asSession(
  env: NodeJS.ProcessEnv,
  argv: string[],
  cwd: string,
  signal?: AbortSignal,
  session?: SessionEnvironment,
  platform: string = HOST_PLATFORM,
) {
  const names = isWindows(platform) ? WINDOWS_SESSION_VARIABLES : SESSION_VARIABLES
  const floor = Object.fromEntries(names.map((name) => [name, variable(env, name, platform)]))
  return runCommand(argv, {
    cwd,
    // The child gets exactly this environment, found on its PATH, as a session's command would.
    env: session ? withEnvironment(floor, session, platform) : mergeVariables([floor], platform),
    replaceEnv: true,
    platform,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CHECK_MS)]) : AbortSignal.timeout(CHECK_MS),
    timeoutMs: CHECK_MS,
  })
}

/** Whether a `credential.<url>.helper` key applies to github.com. */
function forGithub(key: string): boolean {
  if (key === 'credential.helper') return true
  const url = key.slice('credential.'.length, -'.helper'.length)
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname === 'github.com'
  } catch {
    return url.includes('github.com')
  }
}

/**
 * The setup self-check, as dsh-superagent makes it, in the environment Superagent's sessions get (the daemon's own,
 * `env`, reduced as the platform reduces it, then `agentSessionEnvironment`): git asks only the agent's GitHub CLI for
 * github.com credentials, from the agent's git configuration, no `.netrc` in the sessions' HOME (the daemon's) signs in
 * to github.com first, and `gh` acts as `login`. `signal` stops the checks, as when the runtime stops while it starts.
 * @throws SetupError naming the first check that failed.
 */
export async function verifyEnvironment(
  stateDir: string,
  cfg: { login: string; cli?: string },
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  platform: string = HOST_PLATFORM,
): Promise<void> {
  const session = agentSessionEnvironment(stateDir)
  const cli = agentCli(cfg.cli ?? 'gh', env, workerBin(stateDir), platform)
  // `-z` separates entries with NUL and never quotes paths: origin, then `key\nvalue`.
  const listed = await asSession(
    env,
    ['git', 'config', '-z', '--show-origin', '--get-regexp', '^credential\\..*helper$'],
    stateDir,
    signal,
    session,
    platform,
  )
  if (listed.code !== 0 && listed.code !== 1)
    throw new SetupError('environmentFailed', { output: listed.stderr.trim() })
  const fields = listed.stdout.split('\0')
  let helpers: { origin: string; value: string }[] = []
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const entry = fields[at + 1]!
    const split = entry.indexOf('\n')
    const key = split < 0 ? entry : entry.slice(0, split)
    const value = split < 0 ? '' : entry.slice(split + 1)
    if (!forGithub(key)) continue
    if (value === '') helpers = []
    else helpers.push({ origin: fields[at]!, value })
  }
  const own = helpers.length === 1 && helpers[0]!
  if (
    !own ||
    !own.origin.startsWith('file:') ||
    !samePath(own.origin.slice('file:'.length), workerGitConfig(stateDir), platform) ||
    own.value !== credentialHelper(cli, platform)
  )
    throw new SetupError('agentCredentialMixed', {
      helpers: helpers.map((helper) => `${helper.origin} ${helper.value}`).join('; ') || '(none)',
    })
  // Git for Windows reads the netrc in the user's profile when HOME is not set.
  const home =
    variable(env, 'HOME', platform) ||
    (isWindows(platform) ? variable(env, 'USERPROFILE', platform) : undefined)
  const netrc = await githubNetrc(home)
  if (netrc) throw new SetupError('agentNetrc', { file: netrc })

  // `gh` is found on the sessions' PATH as their shell finds it: the shim, which runs the agent's CLI.
  const user = await asSession(
    env,
    ['gh', 'api', 'user', '--jq', '.login'],
    stateDir,
    signal,
    session,
    platform,
  )
  if (user.code !== 0) throw new SetupError('agentCliSignedOut', { output: user.stderr.trim() })
  const account = user.stdout.trim()
  if (account !== cfg.login) throw new SetupError('agentLoginMismatch', { account, login: cfg.login })
  // On macOS a session's commands run inside the Seatbelt sandbox, which cannot reach the keychain: a token kept there
  // leaves gh signed out in every session, while this check, which runs outside the sandbox, still reads it. gh says
  // where its token comes from, never the token itself; a gh without `auth status --json` cannot say, and passes.
  if (platform === 'darwin') {
    const status = await asSession(
      env,
      ['gh', 'auth', 'status', '--hostname', 'github.com', '--json', 'hosts'],
      stateDir,
      signal,
      session,
      platform,
    )
    if (status.code === 0 && activeTokenInKeychain(status.stdout))
      throw new SetupError('agentTokenInKeychain', { account })
  }
}

/** Whether `gh auth status --json hosts` output names the keychain as the active github.com account's token source. */
function activeTokenInKeychain(text: string): boolean {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return false
  }
  const entries = (value as { hosts?: Record<string, unknown> } | null)?.hosts?.['github.com']
  return (
    Array.isArray(entries) &&
    entries.some(
      (entry: { active?: unknown; tokenSource?: unknown } | null) =>
        entry?.active === true && entry.tokenSource === 'keyring',
    )
  )
}

/**
 * Fails a ticket whose repository's own (local or worktree) git configuration defines `credential.*` or
 * `http.*extraheader` keys, which the agent's git would read and act on. Checks `directory` and, when present, the
 * repository the ticket directory holds in `repo/`.
 */
export async function verifyDirectory(directory: string, platform: string = HOST_PLATFORM): Promise<void> {
  const places = [directory, ...(existsSync(join(directory, 'repo')) ? [join(directory, 'repo')] : [])]
  for (const place of places) {
    const listed = await asSession(
      process.env,
      ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$'],
      place,
      undefined,
      undefined,
      platform,
    )
    // `git config --get-regexp` exits with 1 when no key matches.
    if (listed.code !== 0 && listed.code !== 1)
      throw new Error(listed.stderr.trim() || `git config failed in ${place} with ${listed.code}`)
    const fields = listed.stdout.split('\0')
    const local = fields.flatMap((scope, index) =>
      index % 2 === 0 && (scope === 'local' || scope === 'worktree')
        ? [fields[index + 1]!.split('\n')[0]!]
        : [],
    )
    if (local.length)
      throw new Error(
        `The git configuration of the repository in ${place} sets ${local.join(', ')}, which the agent's git would also read; remove them.`,
      )
  }
}
