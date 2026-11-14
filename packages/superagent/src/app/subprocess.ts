// Adapted from dsh-superagent (MIT)
/** Child-process runner for CLI invocations: no stdin, bounded output, a deadline, and no credential-shaped variables. */
import { type ChildProcess, spawn } from 'node:child_process'

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
const DRAIN_GRACE_MS = 500
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

/** Sends `signal` to the child's whole process group, so a grandchild started by `sh -c` is stopped too. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid === undefined) return
    process.kill(-child.pid, signal)
  } catch {
    // No such group (already gone, or a platform without process groups): signal the child alone.
    child.kill(signal)
  }
}

/**
 * Runs `argv` (program first, no shell) in its own process group and resolves with its exit code and output. Rejects when
 * the program cannot be started. The deadline and `signal` stop the whole group with SIGTERM, then SIGKILL after a grace
 * period; the result then has `code` -1. A grandchild that keeps the output pipes open cannot hold the call: once the
 * process has exited, the pipes get a short grace period to drain and are then closed.
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
      detached: true,
      windowsHide: true,
    })
    const out = collector(STDOUT_LIMIT)
    const err = collector(STDERR_LIMIT)
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    let killer: NodeJS.Timeout | undefined
    let drain: NodeJS.Timeout | undefined
    let settled = false
    const stop = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      signalGroup(child, 'SIGTERM')
      killer = setTimeout(() => signalGroup(child, 'SIGKILL'), KILL_GRACE_MS)
    }
    const deadline = setTimeout(stop, opts.timeoutMs)
    opts.signal.addEventListener('abort', stop, { once: true })
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(killer)
      clearTimeout(drain)
      opts.signal.removeEventListener('abort', stop)
      child.stdout.destroy()
      child.stderr.destroy()
      resolve({ code, stdout: out.text(), stderr: err.text() })
    }
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(killer)
      opts.signal.removeEventListener('abort', stop)
      reject(error)
    })
    child.once('exit', (code) => {
      // Normally `close` follows at once; a grandchild holding the pipes only delays it by the grace period.
      drain = setTimeout(() => finish(code ?? -1), DRAIN_GRACE_MS)
    })
    child.once('close', (code) => finish(code ?? -1))
  })
}
