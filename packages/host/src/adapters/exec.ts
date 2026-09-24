import { type ChildProcess, spawn } from 'node:child_process'
import { createExecOutput } from './exec-output.js'
import { createWindowsExec } from './exec-win32.js'
import type { PowerShellDescriptor } from './powershell.js'

export type ExecResult = {
  code: number
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  signal?: string
}

/**
 * The binding a sandbox seam's exec request carries: the digest of the policy it decided the
 * request under, and the backend it believes it has. createPolicyExec checks both against the
 * host's own bound state; a request that names a policy the host is not enforcing, or a backend
 * the seam did not declare, is refused.
 */
export type SandboxExecBinding = { policyDigest: string; backend: 'none' | 'l1' | 'remote' }

/** The process-isolation posture the sandbox seam declared at init. Host-owned once declared. */
export type ExecGateState = { backend: 'none' | 'l1' | 'remote'; onUnavailable: 'deny' | 'allow' }

export type ExecAdapter = {
  run(
    argv: string[],
    opts: {
      cwd: string
      env?: Record<string, string>
      stdin?: string
      timeoutMs?: number
      signal?: AbortSignal
      maxOutputBytes?: number
      sandbox?: SandboxExecBinding
    },
  ): Promise<ExecResult>
  killAll(): Promise<void>
}

/** The per-stream byte cap a command's output is held to when the caller names none. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
/** How long a command may run when neither the caller nor the deployment names a deadline. */
export const DEFAULT_TIMEOUT_MS = 120_000

// A child gets a floor, not the host's whole environment. Empty is not the floor: with no PATH,
// execvp falls back to confstr(_CS_PATH) = /bin:/usr/bin and a homebrew / nvm / volta `node` is
// simply not found, so every test in this file that spawns bare `node` fails on a normal machine.
// Handing over process.env is the other wrong answer — it carries AGNES_SECRET_* straight into the
// child. These are the variables a program needs to run at all.
const INHERITED_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
]

/**
 * B-9: an already-aborted signal was only ever consulted through addEventListener, which never
 * fires for a signal that aborted before the listener was added - so a cancelled turn still started
 * the command and killed it a moment later, after it had run. Every runner asks this before it
 * starts anything, and the signal's own reason is preferred so a caller that aborted with a reason
 * gets it back rather than a generic error.
 */
export function abortedBeforeStart(signal: AbortSignal | undefined): Error | undefined {
  if (signal?.aborted !== true) return undefined
  const why: unknown = signal.reason
  return why instanceof Error ? why : new Error('exec: aborted before start')
}

export function baseEnvironment(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of INHERITED_ENV) {
    const v = process.env[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

export function createExec(
  opts: {
    defaultTimeoutMs?: number
    killTree?: (pid: number) => void
    baseEnv?: Record<string, string>
    /** Host disables detachment on Windows; POSIX needs its own process group for tree cleanup. */
    detached?: boolean
    /** Trusted Node runtime enables the owned Windows Job execution path. */
    windowsNodeExecutable?: string
    windowsPowerShell?: PowerShellDescriptor
  } = {},
): ExecAdapter {
  const live = new Set<ChildProcess>()
  const base = opts.baseEnv ?? baseEnvironment()
  if (opts.windowsNodeExecutable)
    return createWindowsExec({
      nodeExecutable: opts.windowsNodeExecutable,
      baseEnv: base,
      defaultTimeoutMs: opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(opts.windowsPowerShell ? { powerShell: opts.windowsPowerShell } : {}),
    })

  // One kill, by one route. `opts.killTree?.(pid) ?? process.kill(-pid, 'SIGKILL')` reads as "try
  // the injected one, else the group kill", but killTree returns void, so `undefined ?? x` always
  // evaluates the right-hand side too: the tree is killed twice, and on the second pass the pid has
  // usually been reaped (ESRCH) or, on win32, `-pid` was never a legal argument in the first place.
  function killGroup(child: ChildProcess): void {
    const pid = child.pid
    if (pid === undefined) return
    try {
      if (opts.killTree) opts.killTree(pid)
      else process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }

  return {
    run(argv, o) {
      return new Promise<ExecResult>((resolve, reject) => {
        const [cmd, ...args] = argv
        if (!cmd) {
          reject(new Error('exec: empty argv'))
          return
        }
        // B-9, and it stays before `spawn`: a turn cancelled before this call must not start a
        // process at all. See `abortedBeforeStart` for why addEventListener alone was not enough.
        const alreadyAborted = abortedBeforeStart(o.signal)
        if (alreadyAborted) {
          reject(alreadyAborted)
          return
        }
        const max = o.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
        const child = spawn(cmd, args, {
          cwd: o.cwd,
          env: { ...base, ...(o.env ?? {}) },
          detached: opts.detached ?? true,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        live.add(child)
        let timedOut = false
        let sig: string | undefined
        const output = createExecOutput(max)
        child.stdout?.on('data', output.stdout)
        child.stderr?.on('data', output.stderr)
        const timer = setTimeout(
          () => {
            timedOut = true
            killGroup(child)
          },
          o.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        )
        const onAbort = () => {
          sig = 'SIGKILL'
          killGroup(child)
        }
        o.signal?.addEventListener('abort', onAbort, { once: true })
        child.on('error', (e) => {
          clearTimeout(timer)
          o.signal?.removeEventListener('abort', onAbort)
          live.delete(child)
          reject(e)
        })
        child.on('close', (code, signal) => {
          clearTimeout(timer)
          o.signal?.removeEventListener('abort', onAbort)
          live.delete(child)
          // Narrowed to a string before the spread: `signal ?? sig` is `string | undefined`, and an
          // optional property may not be handed an explicit undefined under this repo's settings.
          const ended: string | undefined = signal ?? sig
          resolve({
            code: code ?? -1,
            ...output.result(),
            timedOut,
            ...(ended === undefined ? {} : { signal: ended }),
          })
        })
        // A child that exits without draining stdin makes this write fail with EPIPE on the stream.
        // A stream error is not the child's `error` event, so unhandled it becomes an
        // uncaughtException - a daemon crash on any `head` or `grep -q`. Nothing is lost by
        // swallowing it: the child chose not to read, and its exit is reported by `close` as usual.
        child.stdin?.on('error', () => {})
        if (o.stdin !== undefined) child.stdin?.end(o.stdin)
        else child.stdin?.end()
      })
    },
    async killAll() {
      for (const c of live) killGroup(c)
      live.clear()
    },
  }
}

const unavailable = (why: string): Error =>
  Object.assign(new Error(`SANDBOX_UNAVAILABLE: ${why}`), { code: 'SANDBOX_UNAVAILABLE' })

/**
 * The spawn-side half of the sandbox contract. Every process a seam creates goes through this
 * wrapper, which independently - not trusting the request - canonicalizes the cwd against the
 * bound file policy, pins the request to the policy digest the host bound, and applies the
 * no-backend gate the seam declared. Before any policy is bound, or when the binding a request
 * carries does not match what is bound, the answer is deny: an assembly that has not finished
 * wiring the sandbox is not one processes get to start in.
 */
export function createPolicyExec(
  inner: ExecAdapter,
  gate: {
    /** The digest of the policy currently bound to the host FsOps, or null before binding. */
    boundDigest(): string | null
    /** The posture the sandbox seam declared; defaults to the closed one before it does. */
    state(): ExecGateState
    /** Canonicalizes a cwd against the live filesystem and applies the bound file policy; rejects E_FS_DENIED. */
    authorizeCwd(cwd: string): Promise<string>
  },
): ExecAdapter['run'] {
  return async (argv, opts) => {
    const bound = gate.boundDigest()
    const request = opts.sandbox
    // Only the sandbox seam can attest that it compiled/wrapped this argv under the active
    // policy. A package calling its raw SeamAdapters.exec handle must not inherit permission just
    // because some other caller successfully initialized an L1 or degraded backend.
    if (request === undefined) throw unavailable('the request carries no sandbox binding')
    // A request that names a binding must name the live one: a stale seam holding a superseded
    // policy's digest, or a caller inventing one, is refused rather than debated.
    if (bound === null || request.policyDigest !== bound || request.backend !== gate.state().backend)
      throw unavailable('the request carries no valid sandbox binding')
    if (bound === null) throw unavailable('no sandbox policy is bound')
    const cwd = await gate.authorizeCwd(opts.cwd)
    const state = gate.state()
    // Only 'none' means "there is no backend". A remote posture has one - it is simply not this
    // machine, so the preset's unconfined-execution allowance has nothing to say about it. A dead
    // connection surfaces as an error from the remote runner, never as a fallback to local exec.
    if (state.backend === 'none' && state.onUnavailable !== 'allow')
      throw unavailable('no sandbox backend is available and the preset does not allow unconfined execution')
    return inner.run(argv, { ...opts, cwd })
  }
}

/**
 * The raw spawner a sandbox factory may probe a backend with, and nothing else. It is revoked the
 * moment the factory returns, so a seam that saved the handle owns a refusal, not a backdoor
 * around the policy gate every other caller of exec goes through.
 */
export function createProbeExec(inner: ExecAdapter): {
  run: ExecAdapter['run']
  revoke(): void
} {
  let active = true
  return {
    run(argv, opts) {
      if (!active)
        return Promise.reject(
          new HostProbeRevoked('the probe exec is revoked: it lives only while the sandbox factory runs'),
        )
      return inner.run(argv, opts)
    },
    revoke() {
      active = false
    },
  }
}

class HostProbeRevoked extends Error {
  readonly code = 'E_SEAM_INIT'
}
