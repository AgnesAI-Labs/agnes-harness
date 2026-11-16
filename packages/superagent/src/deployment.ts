// Adapted from dsh-superagent (MIT)
/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { runCommand } from './app/subprocess.js'
import { findWindowsProgram } from './app/windows-launch.js'
import { HOST_PLATFORM, isAbsolutePath, isWindows, pathDelimiter, variable } from './infra/platform.js'
import { sameDirectory, withoutDirectory, workerBin } from './infra/worker-paths.js'
import { LIMITS } from './limits.js'
import { SetupError } from './setup.js'

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
/** An absolute path, on POSIX or, with its drive, on Windows; `machineOf` checks it against this platform. */
const absolute = (description: string) =>
  z.string().regex(/^(\/|[A-Za-z]:[\\/])/, `${description} Absolute path.`)
const bounded = (limits: { min: number; max: number }, fallback: number) =>
  z.number().int().min(limits.min).max(limits.max).default(fallback)
/**
 * Machine-level configuration of the plugin. `stateDir` is required; the limits are read on each use, so a changed
 * value applies without a restart.
 */
export const ConfigSchema = z.object({
  stateDir: absolute(
    "Directory for the database, locks, worker shims, the agent's git configuration and, by default, the ticket directories.",
  ),
  promptMaxChars: bounded(LIMITS.promptMaxChars, 100000),
  admissionContextMaxPages: bounded(LIMITS.admissionContextMaxPages, 10),
  admissionContextTimeoutMs: bounded(LIMITS.admissionContextTimeoutMs, 15000),
})
export type DeploymentConfig = z.infer<typeof ConfigSchema>
/** A setting read when used, so a later change to its source applies without a restart. */
export interface Volatile<T> {
  get(): T
}
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source',
  branchPrefix: 'in the prepare command of the Execution settings',
  github: 'on the GitHub Source',
  feishu: 'on the Feishu Source',
  author: 'prompt text',
  repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings',
  blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(raw: unknown, platform: string = HOST_PLATFORM): Machine {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const unknown = Object.keys(input).filter((key) => !(key in ConfigSchema.shape))
  if (unknown.length) {
    const named = unknown.map((key) => (MOVED[key] ? `${key} (now ${MOVED[key]})` : key)).join(', ')
    throw new Error(
      `Superagent configuration has keys it does not use: ${named}; the configuration schema lists the keys`,
    )
  }
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } =
    ConfigSchema.parse(input)
  if (!isAbsolutePath(stateDir, platform))
    throw new Error(
      `Superagent configuration names a stateDir that is not an absolute path here: ${stateDir}`,
    )
  const fixed = <T>(value: T): Volatile<T> => ({ get: () => value })
  return {
    stateDir,
    promptMaxChars: fixed(promptMaxChars),
    admissionContextMaxPages: fixed(admissionContextMaxPages),
    admissionContextTimeoutMs: fixed(admissionContextTimeoutMs),
  }
}

export const GithubAccountsSchema = z.object({
  repository: z
    .string()
    .trim()
    .regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name')
    .default(''),
  cli: z.string().trim().default(''),
})
/**
 * Source configuration keys that affect deployment setup and trigger a restart when changed; the Feishu Source follows
 * a changed channel instance without one.
 */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  github: Object.keys(GithubAccountsSchema.shape),
  feishu: [],
}

export interface Deployment extends Machine {
  repository: string
  github: { cli: string; login: string; noreply: string }
  feishu?: FeishuBot
}
export interface FeishuBot {
  cli: string
  appId: string
  brand: 'feishu' | 'lark'
  botId: string
  name: string
}

/**
 * Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. On Windows the name
 * is found as a shell finds it, with the extensions PATHEXT in `env` lists (`gh-agent` is `gh-agent.cmd`).
 */
export function executable(
  name: string,
  path: string,
  exclude?: string,
  platform: string = HOST_PLATFORM,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (isWindows(platform)) return windowsExecutable(name, path, exclude, env)
  if (name.includes('/') && !isAbsolute(name))
    throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name)
    ? [name]
    : path
        .split(delimiter)
        .filter((dir) => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude)))
        .map((dir) => join(dir, name))
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK)
        return candidate
      }
    } catch {
      /* Not an executable file here; try the next PATH directory. */
    }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}
function windowsExecutable(
  name: string,
  path: string,
  exclude: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const named = /[\\/]/.test(name)
  if (named && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const dirs = path.split(';').filter((dir) => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude)))
  const found = findWindowsProgram(name, {
    PATH: named ? '' : dirs.join(';'),
    PATHEXT: variable(env, 'PATHEXT', 'win32'),
  })
  if (found) return found
  throw new Error(`${name} is not an executable file${named ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/**
 * Run startup checks as a child process with worker shims removed from PATH so a `gh` wrapper script reaches the real
 * binary. A failing command throws with its trimmed stderr as the message.
 */
export function workerProbe(
  stateDir: string,
  cwd: string,
  signal: AbortSignal,
  platform: string = HOST_PLATFORM,
): Probe {
  const path = withoutDirectory(
    variable(process.env, 'PATH', platform) ?? '',
    workerBin(stateDir),
    pathDelimiter(platform),
  )
  return async (argv) => {
    const { code, stdout, stderr } = await runCommand(argv, {
      cwd,
      env: { PATH: path },
      platform,
      signal,
      timeoutMs: 60_000,
    })
    if (code === 0) return stdout
    const ended = code === -1 ? 'was stopped before it finished' : `exited with ${code}`
    throw new Error(stderr.trim() || `${argv.join(' ')} ${ended}`)
  }
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  push: z.boolean().nullable(),
})
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined /* Non-JSON output; the caller surfaces the setup failure. */
  }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(
  machine: Machine,
  github: unknown,
  probe: Probe,
  path = process.env.PATH ?? '',
  platform: string = HOST_PLATFORM,
): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try {
    cli = executable(accounts.cli, path, workerBin(stateDir), platform)
  } catch (error) {
    throw new SetupError('agentCliMissing', { output: reason(error) })
  }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => {
    throw new SetupError('agentCliSignedOut', { output: reason(error) })
  })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(
    RepositoryAccess,
    await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch(
      (error: unknown) => {
        throw new SetupError('repositoryUnreadable', {
          account: agent.login,
          repository: remote,
          output: reason(error),
        })
      },
    ),
  )
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  // The GitHub Source receives requests through the agent's notifications, which GitHub refuses to a fine-grained
  // token (401 or 403); any other failure, such as a network error, is left to the Source's polling to report.
  await probe([cli, 'api', `repos/${repository}/notifications?per_page=1`, '--silent']).catch(
    (error: unknown) => {
      if (/\bHTTP 40[13]\b/.test(reason(error)))
        throw new SetupError('agentTokenNoNotifications', { account: agent.login, output: reason(error) })
    },
  )
  return {
    ...machine,
    repository,
    github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` },
  }
}
