// Adapted from dsh-superagent (MIT)
/**
 * Child-process runner for CLI invocations: no stdin unless given, bounded output, a deadline, and no credential-shaped
 * variables.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { win32 } from 'node:path'
import { HOST_PLATFORM, isWindows, mergeVariables, variable } from '../infra/platform.js'
import { GIT_LOCATION } from '../infra/worker-paths.js'
import { windowsLaunch } from './windows-launch.js'

export interface RunOptions {
  cwd?: string
  /** Variables added to the inherited environment. Credential-shaped names are dropped from the result either way. */
  env?: Record<string, string>
  /** `env` is the child's whole environment: nothing is inherited and no prompt or agent variable is added. */
  replaceEnv?: boolean
  /** Text written to the child's standard input, which is then closed; without it the child has none. */
  input?: string
  signal: AbortSignal
  timeoutMs: number
  /** How many bytes of standard output are kept (the first ones); the default is 1 MiB. */
  maxStdoutBytes?: number
  /** The operating system, this process's by default; it decides how the program starts and how it is stopped. */
  platform?: string
  /** How processes start and stop; Node's own by default. */
  processes?: Partial<Processes>
}
/** The process operations `runCommand` uses, replaceable in tests. */
export interface Processes {
  spawn: typeof spawn
  /** `process.kill`: signals a POSIX process group by its negative id. */
  kill(pid: number, signal: NodeJS.Signals): void
}
const NODE_PROCESSES: Processes = { spawn, kill: (pid, signal) => process.kill(pid, signal) }
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

/**
 * Variables of the daemon's own environment that would change which git configuration, repository, identity or `gh`
 * login the runtime's commands use: environment git configuration (a `GIT_CONFIG_COUNT` without its key even makes every
 * git fail), the repository a host started inside git names, the operator's commit identity, a `gh` configuration
 * directory or host, an XDG configuration directory (git and gh read the operator's from it), and askpass helpers. The
 * agent's identity comes from the agent's variables instead (see `setAgentVariables`).
 */
const AMBIENT = new RegExp(
  `^(GIT_CONFIG_(COUNT|PARAMETERS|GLOBAL|SYSTEM|NOSYSTEM|KEY_\\d+|VALUE_\\d+)|GIT_(AUTHOR|COMMITTER)_.*|${GIT_LOCATION.join('|')}|GH_CONFIG_DIR|GH_HOST|SSH_ASKPASS|XDG_CONFIG_HOME)$`,
)
/**
 * When git has no credential, it fails rather than asking anyone; and it reads no system configuration, whose helpers and
 * settings would apply to the agent's repositories.
 */
const NO_PROMPT = { GIT_ASKPASS: '', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }
let agent: Record<string, string> = {}

/**
 * Sets the agent's variables (its shims first on PATH and its git configuration, see `agentCommandVariables`) for every
 * command the runtime runs from now on, or clears them with `undefined`. The runtime sets them once its environment
 * check passed and clears them when it stops.
 */
export function setAgentVariables(variables: Readonly<Record<string, string>> | undefined): void {
  agent = variables ? { ...variables } : {}
}

/**
 * The environment a child receives: the process's own without the `AMBIENT` variables, no prompts, the agent's variables
 * once set, and `extra` last. Variables whose names look like credentials are dropped from the result either way.
 */
export function childEnvironment(
  extra: Record<string, string> = {},
  platform: string = HOST_PLATFORM,
): Record<string, string> {
  // Windows names compare without case: `git_dir` is GIT_DIR there.
  const ambient = (name: string) => AMBIENT.test(isWindows(platform) ? name.toUpperCase() : name)
  const inherited = Object.entries(process.env).filter(([name]) => !ambient(name))
  return withoutCredentials(
    mergeVariables([Object.fromEntries(inherited), NO_PROMPT, agent, extra], platform),
  )
}
const withoutCredentials = (env: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL_NAME.test(name)))

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
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals, processes: Processes): void {
  try {
    if (child.pid === undefined) return
    processes.kill(-child.pid, signal)
  } catch {
    // No such group (already gone, or a platform without process groups): signal the child alone.
    child.kill(signal)
  }
}
/** Windows' own `taskkill`, from its system directory, never one found on PATH or in the working directory. */
const taskkillPath = (): string => {
  const systemRoot = variable(process.env, 'SystemRoot', 'win32')
  return systemRoot ? win32.join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe'
}
/**
 * Ends the child's whole process tree on Windows with `taskkill /T /F`, which has no graceful stage: Windows has no
 * process groups to signal, and a tree a shell started would otherwise outlive it. When taskkill cannot run, or fails
 * while the child still runs, the child alone is ended.
 */
export function killTree(child: ChildProcess, processes: Processes): void {
  if (child.pid === undefined) return
  const running = () => child.exitCode === null && child.signalCode === null
  try {
    const taskkill = processes.spawn(taskkillPath(), ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    taskkill.once('error', () => child.kill('SIGKILL'))
    taskkill.once('exit', (code) => {
      if (code !== 0 && running()) child.kill('SIGKILL')
    })
  } catch {
    child.kill('SIGKILL')
  }
}

/**
 * Runs `argv` (program first, no shell) in its own process group and resolves with its exit code and output. Rejects when
 * the program cannot be started. The deadline and `signal` stop the whole group with SIGTERM, then SIGKILL after a grace
 * period; the result then has `code` -1. A grandchild that keeps the output pipes open cannot hold the call: once the
 * process has exited, the pipes get a short grace period to drain and are then closed. On Windows the program is found
 * as a shell finds it (PATH with PATHEXT), a batch file runs through `cmd.exe`, and a stop ends the whole process tree
 * with `taskkill` at once; the result has `code` -1 there too.
 */
export function runCommand(argv: readonly string[], opts: RunOptions): Promise<RunResult> {
  const [name, ...rest] = argv
  if (!name) return Promise.reject(new Error('runCommand needs a program to run'))
  const platform = opts.platform ?? HOST_PLATFORM
  const windows = isWindows(platform)
  const processes = { ...NODE_PROCESSES, ...opts.processes }
  const env = opts.replaceEnv ? withoutCredentials(opts.env ?? {}) : childEnvironment(opts.env, platform)
  let launch: ReturnType<typeof windowsLaunch>
  try {
    launch = windows ? windowsLaunch(name, rest, env) : { program: name, args: rest, verbatim: false }
  } catch (error) {
    return Promise.reject(error)
  }
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      resolve({ code: -1, stdout: '', stderr: '' })
      return
    }
    const child = processes.spawn(launch.program, launch.args, {
      cwd: opts.cwd,
      env,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      // Windows has no process groups; a stop ends the tree with taskkill instead.
      detached: !windows,
      windowsHide: true,
      ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
    })
    if (opts.input !== undefined) {
      // A child that exits without reading its input closes the pipe; that is not a failure of the call.
      child.stdin?.on('error', () => {})
      child.stdin?.end(opts.input)
    }
    const out = collector(opts.maxStdoutBytes ?? STDOUT_LIMIT)
    const err = collector(STDERR_LIMIT)
    child.stdout!.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr!.on('data', (chunk: Buffer) => err.push(chunk))
    let killer: NodeJS.Timeout | undefined
    let drain: NodeJS.Timeout | undefined
    let settled = false
    // A tree taskkill ended exits with code 1, not by a signal: a Windows command it stopped reads -1 all the same, and
    // one that ended by itself while the stop was under way keeps any other code it gave.
    let ended = false
    const stop = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (windows) {
        ended = true
        killTree(child, processes)
        // Should taskkill hang, the child is still ended by its deadline.
        killer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
        return
      }
      signalGroup(child, 'SIGTERM', processes)
      killer = setTimeout(() => signalGroup(child, 'SIGKILL', processes), KILL_GRACE_MS)
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
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({ code: ended && code === 1 ? -1 : code, stdout: out.text(), stderr: err.text() })
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
