// Adapted from dsh-superagent (MIT)
/** Trusted-backend subprocess wrapper for gh, git and bot-only lark-cli under the configured accounts. */
import { z } from 'zod'
import { runCommand } from '../app/subprocess.js'
import type { Deployment } from '../deployment.js'
import { BotInfo } from '../feishu-setup.js'
import { HOST_PLATFORM, isWindows, programName } from './platform.js'

const TIMEOUT_MS = 90_000
/** Output a command may print; `runCommand` keeps the first bytes, so reaching this size means output was lost. */
const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024
/**
 * Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, and exit status without echoing command arguments.
 * Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly exitCode?: number,
    readonly response = false,
  ) {
    super(message)
  }
}
/** A structured Feishu API refusal, not a timeout, process error or HTTP proxy diagnostic. */
export class FeishuRefusal extends CliError {}
/** A preflight failed before a write command could be invoked. */
export class FeishuNotDispatched extends Error {}
/**
 * Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. `error` is
 * shaped like the failure of `child_process.execFile`: `stderr`, a numeric exit `code` or a string error code, `killed`
 * and `signal`. The program is named as `programName` names it on `platform`.
 */
export function commandError(
  error: unknown,
  program = 'command',
  timeoutMs = TIMEOUT_MS,
  platform: string = HOST_PLATFORM,
): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const exitCode =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'number'
      ? error.code
      : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: unknown; message?: unknown } } | undefined
    try {
      parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed
    } catch {
      /* Non-JSON CLI diagnostics are retained below. */
    }
    const rawCode = parsed?.error?.code
    const code = typeof rawCode === 'number' && Number.isInteger(rawCode) ? rawCode : undefined
    if (typeof parsed?.error?.message === 'string')
      return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode, true)
    // `gh` exits non-zero on HTTP errors (such as `gh: Not Found (HTTP 404)`) and on `gh: HTTP 304`, which ETag polling relies on.
    if (stderr)
      return new CliError(
        stderr.slice(0, 2000),
        Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined,
        exitCode,
      )
  }
  return new CliError(`${programName(program, platform)} ${ended(error, timeoutMs)}`, undefined, exitCode)
}
function ended(error: unknown, timeoutMs: number): string {
  const { killed, signal, code } = (error ?? {}) as {
    killed?: boolean
    signal?: string | null
    code?: unknown
  }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // `execFile` timeout terminates the process with SIGTERM and sets `killed: true`.
  if (killed && signal === 'SIGTERM') return `timed out after ${timeoutMs / 1000} s`
  if (signal) return `was stopped by ${signal}`
  if (typeof code === 'number') return `exited with code ${code}`
  if (code === 'stopped') return 'was stopped before it finished'
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
}
export interface Tally {
  skipped: number
}
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap((value) => {
    const parsed = item.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
  if (tally) tally.skipped += list.length - items.length
  return items
}
/**
 * Executes account-bound CLI subprocesses with timeouts and abort signals.
 * Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
export class Commands {
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables added to the process environment for every command (such as isolated git settings);
   * names that look like credentials are never passed on.
   */
  constructor(
    private readonly resolved: () => Deployment,
    private readonly environment: Record<string, string>,
    private readonly signal: AbortSignal,
    /** How long one command may run before it is stopped. */
    private readonly timeoutMs = TIMEOUT_MS,
    /** The operating system the commands run on, this process's by default. */
    private readonly platform: string = HOST_PLATFORM,
  ) {}
  get deployment(): Deployment {
    return this.resolved()
  }
  get repository(): string {
    return this.deployment.repository
  }
  withSignal(signal?: AbortSignal): Commands {
    return signal
      ? new Commands(
          this.resolved,
          this.environment,
          AbortSignal.any([this.signal, signal]),
          this.timeoutMs,
          this.platform,
        )
      : this
  }
  /** Runs `program`; `input`, when given, is its standard input. */
  async run(program: string, args: string[], cwd?: string, input?: string): Promise<string> {
    const started = Date.now()
    const result = await runCommand([program, ...args], {
      ...(cwd === undefined ? {} : { cwd }),
      ...(input === undefined ? {} : { input }),
      platform: this.platform,
      signal: this.signal,
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: OUTPUT_LIMIT_BYTES,
      env: {
        ...this.environment,
        GH_PROMPT_DISABLED: '1',
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      },
    }).catch((error: unknown) => {
      throw commandError(error, program, this.timeoutMs, this.platform)
    })
    // A command stopped by the abort signal is not a failure of the command.
    if (this.signal.aborted) throw new DOMException('The command was aborted', 'AbortError')
    // `runCommand` reports a command ended by a signal or by its deadline with -1; the time it ran tells which.
    if (result.code === -1)
      throw commandError(
        Date.now() - started >= this.timeoutMs ? { killed: true, signal: 'SIGTERM' } : { code: 'stopped' },
        program,
        this.timeoutMs,
        this.platform,
      )
    if (result.code !== 0)
      throw commandError({ stderr: result.stderr, code: result.code }, program, this.timeoutMs, this.platform)
    if (Buffer.byteLength(result.stdout) >= OUTPUT_LIMIT_BYTES)
      throw commandError(
        { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
        program,
        this.timeoutMs,
        this.platform,
      )
    return result.stdout
  }
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  async gh<T>(args: string[]): Promise<T> {
    return JSON.parse(await this.run(this.deployment.github.cli, args)) as T
  }
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string')
      return this.run(this.deployment.github.cli, ['api', this.path(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.gh(['api', this.path(path), ...flags]))
  }
  /**
   * POSTs `text` as the string field `field` to a path within the configured repository and validates the answer. On
   * Windows the text goes through standard input (`-F <field>=@-`): an agent CLI that is a batch file, such as a
   * `gh-agent.cmd` wrapper, cannot receive a line break as an argument there.
   */
  async post<T>(schema: z.ZodType<T>, path: string, field: string, text: string): Promise<T> {
    if (!isWindows(this.platform)) return this.api(schema, path, '--method', 'POST', '-f', `${field}=${text}`)
    const out = await this.run(
      this.deployment.github.cli,
      ['api', this.path(path), '--method', 'POST', '-F', `${field}=@-`],
      undefined,
      text,
    )
    return schema.parse(JSON.parse(out))
  }
  /** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z
      .array(z.array(z.unknown()))
      .parse(await this.gh(['api', this.path(path), '--paginate', '--slurp']))
    return validItems(item, pages.flat(), tally)
  }
  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`
  }
  /** Runs only as the resolved bot. Rechecks its open_id before every read/write, detecting wrapper changes. */
  async lark<T>(args: string[], cwd?: string, input?: string): Promise<T> {
    const bot = this.deployment.feishu
    if (!bot) throw new Error('The Feishu Source has no verified bot CLI')
    try {
      const info = BotInfo.parse(
        JSON.parse(
          await this.run(bot.cli, [
            'api',
            'GET',
            '/open-apis/bot/v3/info',
            '--as',
            'bot',
            '--format',
            'ndjson',
          ]),
        ),
      )
      if (info.bot.open_id !== bot.botId) throw new Error('identity')
    } catch {
      throw new FeishuNotDispatched(
        'Feishu bot identity could not be verified; check the source CLI settings',
      )
    }
    let output: string
    try {
      output = await this.run(bot.cli, [...args, '--as', 'bot', '--format', 'json'], cwd, input)
    } catch (error) {
      // Never retain a wrapper's stdout/stderr, which can contain authentication material.
      if (error instanceof CliError && error.response && error.code !== undefined)
        throw new FeishuRefusal(`Feishu command refused (${error.code})`, error.code)
      throw new Error('Feishu CLI failed; delivery may be uncertain')
    }
    let value: { ok?: boolean; data?: T; error?: { code?: number } }
    try {
      value = JSON.parse(output) as typeof value
    } catch {
      throw new Error('Feishu CLI returned invalid JSON; delivery may be uncertain')
    }
    if (value.ok !== true) {
      const code =
        typeof value.error?.code === 'number' && Number.isInteger(value.error.code)
          ? value.error.code
          : undefined
      throw new FeishuRefusal(
        code === 232011
          ? 'Feishu bot is not in this chat (232011)'
          : `Feishu command refused${code ? ` (${code})` : ''}`,
        code,
      )
    }
    return value.data as T
  }
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  async git(args: string[], cwd: string): Promise<string> {
    return this.run('git', args, cwd)
  }
}
