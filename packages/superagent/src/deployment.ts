// Adapted from dsh-superagent (MIT)
/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { runCommand } from './app/subprocess.js'
import { sameDirectory, withoutDirectory, workerBin } from './infra/worker-paths.js'
import { LIMITS } from './limits.js'
import { SetupError } from './setup.js'

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const absolute = (description: string) => z.string().regex(/^\//, `${description} Absolute path.`)
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
export function machineOf(raw: unknown): Machine {
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
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  github: Object.keys(GithubAccountsSchema.shape),
  feishu: Object.keys(FeishuBotSchema.shape),
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

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
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

export type Probe = (argv: string[]) => Promise<string>
/**
 * Run startup checks as a child process with worker shims removed from PATH so a `gh` wrapper script reaches the real
 * binary. A failing command throws with its trimmed stderr as the message.
 */
export function workerProbe(stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return async (argv) => {
    const { code, stdout, stderr } = await runCommand(['env', `PATH=${path}`, ...argv], {
      cwd,
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
): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try {
    cli = executable(accounts.cli, path, workerBin(stateDir))
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
  return {
    ...machine,
    repository,
    github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` },
  }
}

const AuthStatus = z.object({
  appId: z.string().regex(/^cli_[A-Za-z0-9]+$/),
  brand: z.enum(['feishu', 'lark']).default('feishu'),
  identities: z.object({ bot: z.object({ status: z.string() }) }),
})
const BotInfo = z.object({
  bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }),
})
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(
  machine: Machine,
  feishu: unknown,
  probe: Probe,
  path = process.env.PATH ?? '',
): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => {
    throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) })
  }
  let cli = ''
  try {
    cli = executable(name, path, workerBin(machine.stateDir))
  } catch (error) {
    fail(error)
  }
  const run = (...args: string[]): Promise<string> =>
    probe([
      'env',
      'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1',
      'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1',
      cli,
      ...args,
    ]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready')
    fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(
    BotInfo,
    (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ??
      '',
  )
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
