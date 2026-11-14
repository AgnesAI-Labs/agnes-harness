// Adapted from dsh-superagent (MIT)
/** Subprocess wrapper for running gh and git commands under the deployment's configured accounts. */
import { basename } from 'node:path'
import { z } from 'zod'
import { runCommand } from '../app/subprocess.js'
import type { Deployment } from '../deployment.js'

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
  ) {
    super(message)
  }
}
/**
 * Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. `error` is
 * shaped like the failure of `child_process.execFile`: `stderr`, a numeric exit `code` or a string error code, `killed`
 * and `signal`.
 */
export function commandError(error: unknown, program = 'command', timeoutMs = TIMEOUT_MS): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const exitCode =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'number'
      ? error.code
      : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try {
      parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed
    } catch {
      /* Non-JSON CLI diagnostics are retained below. */
    }
    const code = parsed?.error?.code
    if (parsed?.error?.message)
      return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode)
    // `gh` exits non-zero on HTTP errors (such as `gh: Not Found (HTTP 404)`) and on `gh: HTTP 304`, which ETag polling relies on.
    if (stderr)
      return new CliError(
        stderr.slice(0, 2000),
        Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined,
        exitCode,
      )
  }
  return new CliError(`${basename(program)} ${ended(error, timeoutMs)}`, undefined, exitCode)
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
 * Executes gh and git subprocesses with deployment account credentials, timeouts, and abort signals.
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
  ) {}
  get deployment(): Deployment {
    return this.resolved()
  }
  get repository(): string {
    return this.deployment.repository
  }
  withSignal(signal?: AbortSignal): Commands {
    return signal
      ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal]), this.timeoutMs)
      : this
  }
  async run(program: string, args: string[], cwd?: string): Promise<string> {
    const started = Date.now()
    const result = await runCommand([program, ...args], {
      ...(cwd === undefined ? {} : { cwd }),
      signal: this.signal,
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: OUTPUT_LIMIT_BYTES,
      env: {
        ...this.environment,
        GH_PROMPT_DISABLED: '1',
      },
    }).catch((error: unknown) => {
      throw commandError(error, program, this.timeoutMs)
    })
    // A command stopped by the abort signal is not a failure of the command.
    if (this.signal.aborted) throw new DOMException('The command was aborted', 'AbortError')
    // `runCommand` reports a command ended by a signal or by its deadline with -1; the time it ran tells which.
    if (result.code === -1)
      throw commandError(
        Date.now() - started >= this.timeoutMs ? { killed: true, signal: 'SIGTERM' } : { code: 'stopped' },
        program,
        this.timeoutMs,
      )
    if (result.code !== 0) throw commandError({ stderr: result.stderr, code: result.code }, program)
    if (Buffer.byteLength(result.stdout) >= OUTPUT_LIMIT_BYTES)
      throw commandError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, program, this.timeoutMs)
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
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  async git(args: string[], cwd: string): Promise<string> {
    return this.run('git', args, cwd)
  }
}
