// Adapted from dsh-superagent (MIT)
/**
 * The agent's identity for execution sessions. A session's shell inherits only HOME and PATH (and the locale and temporary
 * directory) from the daemon, so the identity lives in the agent home this AGH starts with — its `.gitconfig` and the
 * agent's `gh` configuration — and in the shims directory first on its PATH. These are default-path guardrails, not
 * isolation: a full-access session runs as the operator's OS user.
 */
import { existsSync, realpathSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { runCommand } from '../app/subprocess.js'
import { executable } from '../deployment.js'
import { SetupError } from '../setup.js'

const MARKER = '# Written by Superagent on every start; edits are lost.'
/** Commands sessions need, which the blocked commands cannot shadow. */
const NEEDED: ReadonlySet<string> = new Set(['gh', 'git'])
/** The variables the daemon passes to a session's shell; everything else of its environment stays behind. */
const SESSION_VARIABLES = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'] as const
/** Variables that would make `gh` act with a token instead of the agent's login. */
const GH_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST']
const CHECK_MS = 60_000

/** What the agent's environment is written from. */
export interface EnvironmentConfig {
  /** The agent's GitHub login, which commits are authored as and `gh` must act as. */
  login: string
  /** The agent's commit email. */
  email: string
  /** The directory holding the agent's `gh` login; `gh` runs with it as `GH_CONFIG_DIR`. */
  ghConfigDir: string
  /** Commands sessions must not run; each gets a shim that fails. */
  blocked: readonly string[]
  /** The real `gh`: a command name resolved on PATH without the shims, or an absolute path. Defaults to `gh`. */
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
const samePath = (a: string, b: string): boolean => real(a) === real(b)

/** The credential helper git runs for github.com: the agent's `gh`, through its shim. */
export const credentialHelper = (shimsDir: string): string =>
  `!${shellQuote(join(shimsDir, 'gh'))} auth git-credential`

/** True when `file` is a regular file with the marker in its first two lines; a link or directory never counts. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  return (await readFile(file, 'utf8')).split('\n', 2).includes(MARKER)
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
/** Writes through a temporary file and a rename, so a concurrent reader never sees a partial file. */
async function replace(file: string, text: string, mode: number): Promise<void> {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`)
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * Writes the agent's environment: in the shims directory a `gh` that runs the real `gh` with the agent's configuration
 * directory and without ambient tokens, and a failing shim per blocked command; in the agent home a `.gitconfig` that names
 * the agent, resets every credential helper (such as a system `osxkeychain`) before adding the agent's `gh` for github.com
 * only, rewrites SSH GitHub URLs to HTTPS and turns askPass off. Nothing is written when either place holds a file this
 * program did not write.
 * @throws SetupError `foreignFile` for such a file, `agentCliMissing` when the real `gh` is not an executable.
 */
export async function writeEnvironment(
  home: string,
  shimsDir: string,
  cfg: EnvironmentConfig,
): Promise<void> {
  let cli: string
  try {
    cli = executable(cfg.cli ?? 'gh', process.env.PATH ?? '', shimsDir)
  } catch (error) {
    throw new SetupError('agentCliMissing', { output: reason(error) })
  }
  await mkdir(shimsDir, { recursive: true })
  const before = await readdir(shimsDir)
  for (const name of before) {
    const file = join(shimsDir, name)
    if (!(await written(file))) throw new SetupError('foreignFile', { file })
  }
  const gitconfig = join(home, '.gitconfig')
  await claim(gitconfig)

  const kept = new Set<string>()
  const shim = async (name: string, body: string): Promise<void> => {
    await replace(join(shimsDir, name), `#!/bin/sh\n${MARKER}\n${body}\n`, 0o755)
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
  await shim(
    'gh',
    [
      withoutShims,
      `unset ${GH_TOKENS.join(' ')}`,
      `GH_CONFIG_DIR=${shellQuote(cfg.ghConfigDir)}`,
      'export GH_CONFIG_DIR',
      `exec ${shellQuote(cli)} "$@"`,
    ].join('\n'),
  )
  for (const name of new Set(cfg.blocked.filter((command) => !NEEDED.has(command)))) {
    const message = `${name} is blocked in this installation; use gh, which acts as ${cfg.login}.`
    await shim(name, `echo ${shellQuote(message)} >&2\nexit 1`)
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(shimsDir, name))

  await mkdir(cfg.ghConfigDir, { recursive: true, mode: 0o700 })
  const text = [
    MARKER,
    '[user]',
    `\tname = ${gitQuote(cfg.login)}`,
    `\temail = ${gitQuote(cfg.email)}`,
    '\tuseConfigOnly = true',
    // The empty value drops every helper configured before this file, such as the system osxkeychain.
    '[credential]',
    '\thelper =',
    '[credential "https://github.com"]',
    `\thelper = ${gitQuote(credentialHelper(shimsDir))}`,
    '[url "https://github.com/"]',
    '\tinsteadOf = git@github.com:',
    '\tinsteadOf = ssh://git@github.com/',
    // When the agent's helper has no answer, git fails rather than asking anyone.
    '[core]',
    '\taskPass =',
    // The operator's own git configuration, which usually holds the LFS filters, is not read.
    '[filter "lfs"]',
    '\tclean = git-lfs clean -- %f',
    '\tsmudge = git-lfs smudge -- %f',
    '\tprocess = git-lfs filter-process',
    '\trequired = true',
  ].join('\n')
  await replace(gitconfig, `${text}\n`, 0o644)
}

/** Runs `argv` with only the variables a session's shell inherits from `env`, so `GIT_CONFIG_*` and tokens stay out. */
function asSession(env: NodeJS.ProcessEnv, argv: string[], cwd: string) {
  const pairs = SESSION_VARIABLES.flatMap((name) => (env[name] === undefined ? [] : [`${name}=${env[name]}`]))
  return runCommand(['env', '-i', ...pairs, ...argv], {
    cwd,
    signal: AbortSignal.timeout(CHECK_MS),
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
 * The setup self-check, in the environment sessions inherit (`env`, the daemon's own by default): HOME is the agent home,
 * `gh` resolves to the shim, git asks only the agent's helper for github.com credentials, and `gh` acts as `login`.
 * @throws SetupError naming the first check that failed.
 */
export async function verifyEnvironment(
  home: string,
  shimsDir: string,
  cfg: { login: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!env.HOME || !samePath(env.HOME, home))
    throw new SetupError('agentHomeMismatch', { home, actual: env.HOME ?? '(unset)' })

  const gh = await asSession(env, ['/bin/sh', '-c', 'command -v gh'], home)
  const actual = gh.stdout.trim()
  if (gh.code !== 0 || !samePath(actual, join(shimsDir, 'gh')))
    throw new SetupError('agentGhNotShim', { actual: actual || '(none)', shims: shimsDir })

  // `-z` separates entries with NUL and never quotes paths: origin, then `key\nvalue`.
  const listed = await asSession(
    env,
    ['git', 'config', '-z', '--show-origin', '--get-regexp', '^credential\\..*helper$'],
    home,
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
    !samePath(own.origin.slice('file:'.length), join(home, '.gitconfig')) ||
    own.value !== credentialHelper(shimsDir)
  )
    throw new SetupError('agentCredentialMixed', {
      helpers: helpers.map((helper) => `${helper.origin} ${helper.value}`).join('; ') || '(none)',
    })

  const user = await asSession(env, ['gh', 'api', 'user', '--jq', '.login'], home)
  if (user.code !== 0) throw new SetupError('agentCliSignedOut', { output: user.stderr.trim() })
  const account = user.stdout.trim()
  if (account !== cfg.login) throw new SetupError('agentLoginMismatch', { account, login: cfg.login })
}

/**
 * Fails a ticket whose repository's own (local or worktree) git configuration defines `credential.*` or
 * `http.*extraheader` keys, which the agent's git would read and act on. Checks `directory` and, when present, the
 * repository the ticket directory holds in `repo/`.
 */
export async function verifyDirectory(directory: string): Promise<void> {
  const places = [directory, ...(existsSync(join(directory, 'repo')) ? [join(directory, 'repo')] : [])]
  for (const place of places) {
    const listed = await asSession(
      process.env,
      ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$'],
      place,
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
