// Adapted from dsh-superagent (MIT)
/** Child-process runner for CLI invocations: no stdin, bounded output, a deadline, and no credential-shaped variables. */
import { spawn } from 'node:child_process'

export interface RunOptions {
  cwd?: string
  /** Variables added to the inherited environment. Credential-shaped names are dropped from the result either way. */
  env?: Record<string, string>
  signal: AbortSignal
  timeoutMs: number
}
export interface RunResult {
  /** Exit code of the process, or -1 when a signal, the deadline or the abort signal ended it first. */
  code: number
  stdout: string
  stderr: string
}

const STDOUT_LIMIT = 1 << 20
const STDERR_LIMIT = 1 << 16
const KILL_GRACE_MS = 2000
const CREDENTIAL_NAME = /KEY|PASSWORD|SECRET|TOKEN/i

/** The environment a child receives: the process's own plus `extra`, without variables whose names look like credentials. */
export function childEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...process.env, ...extra }
  return Object.fromEntries(
    Object.entries(merged).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !CREDENTIAL_NAME.test(entry[0]),
    ),
  )
}

/** A bounded text collector: keeps the first `limit` bytes and discards the rest while the stream keeps draining. */
function collector(limit: number): { push(chunk: Buffer): void; text(): string } {
  const chunks: Buffer[] = []
  let size = 0
  return {
    push(chunk) {
      if (size >= limit) return
      const kept = chunk.subarray(0, limit - size)
      chunks.push(kept)
      size += kept.length
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  }
}

/**
 * Runs `argv` (program first, no shell) and resolves with its exit code and output. Rejects when the program cannot be started.
 * The deadline and `signal` stop the process with SIGTERM, then SIGKILL after a grace period; the result then has `code` -1.
 */
export function runCommand(argv: readonly string[], opts: RunOptions): Promise<RunResult> {
  const [program, ...args] = argv
  if (!program) return Promise.reject(new Error('runCommand needs a program to run'))
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      resolve({ code: -1, stdout: '', stderr: '' })
      return
    }
    const child = spawn(program, args, {
      cwd: opts.cwd,
      env: childEnvironment(opts.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = collector(STDOUT_LIMIT)
    const err = collector(STDERR_LIMIT)
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    let killer: NodeJS.Timeout | undefined
    const stop = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }
    const deadline = setTimeout(stop, opts.timeoutMs)
    opts.signal.addEventListener('abort', stop, { once: true })
    const finish = (): void => {
      clearTimeout(deadline)
      clearTimeout(killer)
      opts.signal.removeEventListener('abort', stop)
    }
    child.once('error', (error) => {
      finish()
      reject(error)
    })
    child.once('close', (code) => {
      finish()
      resolve({ code: code ?? -1, stdout: out.text(), stderr: err.text() })
    })
  })
}
