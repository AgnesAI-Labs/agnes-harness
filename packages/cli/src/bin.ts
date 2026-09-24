#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  acquireDaemonOfflineMaintenance,
  daemonStatus,
  resolveDaemonScope,
  runDaemonControl,
  stopDaemon,
} from '@agnes/daemon'
import { AGNES_ERRORS, JSONRPC_ERRORS } from '@agnes/protocol'
import {
  confirmResourceOperation,
  isResourceOperationFailure,
  resourceOperationFailureWasRendered,
  runResourceCliCommand,
} from '@agnes/resource-control-cli'
import { TransportClosed } from '@agnes/sdk'
import { parseArgs, resolveMode, usage } from './args.js'
import { ensureLocalBackend } from './boot/backend.js'
import { bootDefault } from './boot/default.js'
import { makeEphemeralHome, profileNameFrom, resolveHome } from './boot/inputs.js'
import { bootLocal, type LocalBootDeps } from './boot/local.js'
import { installSignalLadder } from './boot/signals.js'
import { type ConfigWizardIO, runConfigurationWizard } from './config-wizard.js'
import {
  BootError,
  CommandError,
  ExitCode,
  SIGNAL_EXIT_CODES,
  type SignalName,
  UsageError,
} from './errors.js'
import { runAcp } from './modes/acp.js'
import { runPrint } from './modes/print.js'
import { runTui } from './modes/tui.js'
import { runOnboardingTui } from './onboarding/tui.js'
import { NodeTerminal } from './tui/terminal.js'
import type { Booted } from './types.js'

/** The resource command layer only raises these for backend-confirmed terminal outcomes. */
export function safeResourceFailureLine(error: unknown): string | undefined {
  if (!isResourceOperationFailure(error)) return undefined
  return `${error.code}: ${error.message} operation ${error.operationId}`
}

/** A daemon disappearing during a client command is operational, not a CLI programming failure. */
export function safeDaemonDisconnectLine(error: unknown): string | undefined {
  const kind = (error as { kind?: unknown } | null)?.kind
  if (!(error instanceof TransportClosed) && kind !== 'transport-closed') return undefined
  return 'DAEMON_CONNECTION_CLOSED: local Daemon connection closed; retry the command.'
}

type RpcFailureShape = Readonly<{
  kind?: unknown
  code?: unknown
  data?: Readonly<{ code?: unknown }>
}>

/**
 * These are the only confirmed resource-operation JSON-RPC outcomes that can occur while a local
 * command is finishing. Match their wire shape so the handling survives the local/SEA bundle edge;
 * do not interpolate server messages or data because either can contain untrusted diagnostics.
 */
export function safeExpectedResourceRpcFailureLine(error: unknown): string | undefined {
  const value = error as RpcFailureShape | null
  if (value?.kind !== 'json-rpc') return undefined
  if (value.code === JSONRPC_ERRORS.INVALID_REQUEST && value.data?.code === 'SHUTTING_DOWN')
    return 'DAEMON_SHUTTING_DOWN: local Daemon is shutting down; retry the command.'
  if (value.code === AGNES_ERRORS.SEMANTIC_REJECTED && value.data?.code === 'RESOURCE_OPERATION_TERMINAL')
    return 'RESOURCE_OPERATION_TERMINAL: resource operation has already reached a terminal state.'
  return undefined
}

/**
 * Refusals a session command meets because of what the operator asked for or has configured: a
 * `--model`/`--preset` this profile does not carry, or a home with no provider at all. Each gets
 * one fixed line saying what to do next. Same rule as above: the server's message and data are not
 * interpolated.
 */
export function safeExpectedSessionRpcFailureLine(error: unknown): string | undefined {
  const value = error as RpcFailureShape | null
  if (value?.kind !== 'json-rpc') return undefined
  if (value.code === AGNES_ERRORS.PRESET_SWITCH_REJECTED)
    return 'PRESET_SWITCH_REJECTED: the requested preset or model is not available in this profile; `agh doctor provider` lists the configured routes.'
  if (value.code === AGNES_ERRORS.SEMANTIC_REJECTED && value.data?.code === 'PROVIDER_UNCONFIGURED')
    return 'PROVIDER_UNCONFIGURED: no model provider is configured for this profile; run `agh config` to add one.'
  return undefined
}

export type MainIO = {
  env: NodeJS.ProcessEnv
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: NodeJS.WritableStream & { isTTY?: boolean }
  stderr: NodeJS.WritableStream & { isTTY?: boolean }
  cwd: string
  agnesVersion: string
  /** Where the ladder sends the process. Injected so a test can watch it instead of dying. */
  exit?: (code: number) => void
  /** What the ladder listens on. Injected for the same reason: a test signals this, not the process. */
  signals?: NodeJS.EventEmitter
}

/** How long shutdown gets after a first signal before the process leaves anyway. */
const GRACE_MS = 5_000
/** And how long, after that, anything still queued on a pipe gets to reach it. */
const FLUSH_MS = 100

type ConfigInputStream = NodeJS.ReadableStream & {
  setRawMode?: (mode: boolean) => void
  resume(): void
  pause(): void
  setEncoding(encoding: string): void
  on(event: 'data', handler: (chunk: string | Buffer) => void): void
  off(event: 'data', handler: (chunk: string | Buffer) => void): void
}

/** A line reader that can briefly switch the same TTY into masked raw input for API keys. */
class MaskedConfigInput implements AsyncIterable<string>, AsyncIterator<string> {
  #queue: string[] = []
  #waiters: Array<(result: IteratorResult<string>) => void> = []
  #line = ''
  #secret = ''
  #secretResolve: ((value: string) => void) | undefined
  #secretReject: ((reason: Error) => void) | undefined
  #secretMode = false
  #skipLf = false
  #closed = false

  constructor(
    private readonly input: ConfigInputStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    input.setEncoding('utf8')
    input.on('data', this.onData)
    input.resume()
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return this
  }

  next(): Promise<IteratorResult<string>> {
    const value = this.#queue.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.#closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  return(): Promise<IteratorResult<string>> {
    this.close()
    return Promise.resolve({ done: true, value: undefined })
  }

  secret = (prompt: string): Promise<string> => {
    if (this.#closed) return Promise.reject(new Error('configuration input is closed'))
    if (this.#secretMode) return Promise.reject(new Error('configuration secret prompt is already active'))
    this.#secretMode = true
    this.#secret = ''
    this.output.write(prompt)
    this.input.setRawMode?.(true)
    return new Promise((resolve, reject) => {
      this.#secretResolve = resolve
      this.#secretReject = reject
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.input.off('data', this.onData)
    this.input.setRawMode?.(false)
    this.input.pause()
    this.#secretReject?.(new Error('configuration input is closed'))
    this.#secretResolve = undefined
    this.#secretReject = undefined
    for (const resolve of this.#waiters.splice(0)) resolve({ done: true, value: undefined })
    this.#queue = []
    this.#line = ''
    this.#secret = ''
  }

  private readonly onData = (chunk: string | Buffer): void => {
    if (this.#closed) return
    const data = String(chunk)
    if (this.#secretMode) {
      for (const char of data) {
        if (char === '\r' || char === '\n') {
          this.#skipLf = char === '\r'
          this.finishSecret()
          return
        }
        if (char === '\u0003') {
          this.failSecret(new Error('configuration cancelled'))
          return
        }
        if (char === '\u007f' || char === '\b') {
          if (this.#secret.length > 0) {
            this.#secret = this.#secret.slice(0, -1)
            this.output.write('\b \b')
          }
          continue
        }
        if (char >= '!' && char <= '~') {
          this.#secret += char
          this.output.write('*')
        }
      }
      return
    }
    let start = 0
    if (this.#skipLf && data.startsWith('\n')) start = 1
    this.#skipLf = false
    this.#line += data.slice(start)
    for (;;) {
      const at = this.#line.search(/[\r\n]/)
      if (at < 0) break
      const value = this.#line.slice(0, at).trim()
      const newline = this.#line[at]
      this.#line = this.#line.slice(at + 1)
      if (newline === '\r' && this.#line.startsWith('\n')) this.#line = this.#line.slice(1)
      this.push(value)
    }
  }

  private finishSecret(): void {
    const value = this.#secret
    const resolve = this.#secretResolve
    this.#secretResolve = undefined
    this.#secretReject = undefined
    this.#secret = ''
    this.#secretMode = false
    this.input.setRawMode?.(false)
    this.output.write('\n')
    resolve?.(value)
  }

  private failSecret(error: Error): void {
    const reject = this.#secretReject
    this.#secretResolve = undefined
    this.#secretReject = undefined
    this.#secret = ''
    this.#secretMode = false
    this.input.setRawMode?.(false)
    this.output.write('\n')
    reject?.(error)
  }

  private push(value: string): void {
    const resolve = this.#waiters.shift()
    if (resolve) resolve({ done: false, value })
    else this.#queue.push(value)
  }
}

function configurationWizardInput(io: MainIO): { io: ConfigWizardIO; close(): void } {
  const input = io.stdin as ConfigInputStream
  if (io.stdin.isTTY === true && typeof input.setRawMode === 'function') {
    const reader = new MaskedConfigInput(input, io.stderr)
    return {
      io: { input: reader, write: (text) => io.stderr.write(text), secret: reader.secret },
      close: () => reader.close(),
    }
  }
  const rl = createInterface({ input: io.stdin as NodeJS.ReadableStream, crlfDelay: Infinity })
  return {
    io: { input: rl as AsyncIterable<string>, write: (text) => io.stderr.write(text) },
    close: () => rl.close(),
  }
}

type DaemonCommand = 'start' | 'status' | 'stop'

function daemonCommandArgs(
  rest: readonly string[],
  io: MainIO,
): {
  command: DaemonCommand
  args: Parameters<typeof runDaemonControl>[0]
} {
  let command: DaemonCommand | undefined
  let profile = io.env.AGNES_PROFILE || 'local-dev'
  let home: string | undefined
  let workspace = io.cwd
  let dataDir: string | undefined
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index]
    if (value === 'start' || value === 'status' || value === 'stop') {
      if (command !== undefined) throw new UsageError('daemon accepts one of start, status or stop')
      command = value
      continue
    }
    const next = rest[index + 1]
    if (value === '--profile' || value === '--home' || value === '--workspace' || value === '--data-dir') {
      if (next === undefined || next.startsWith('-')) throw new UsageError(`${value} needs a value`)
      index += 1
      if (value === '--profile') profile = next
      else if (value === '--home') home = next
      else if (value === '--workspace') workspace = next
      else dataDir = next
      continue
    }
    throw new UsageError(`unknown daemon argument ${value}`)
  }
  if (command === undefined) throw new UsageError('daemon expects start, status or stop')
  return {
    command,
    args: {
      profile,
      ...(home ? { home } : {}),
      ...(workspace ? { workspace } : {}),
      ...(dataDir ? { dataDir } : {}),
      command,
    } as Parameters<typeof runDaemonControl>[0],
  }
}

/**
 * Where the signal ladder sends the process.
 *
 * Not `process.exit` on the spot: that discards writes still queued on a pipe, and the two lines a
 * signalled run writes last -- the answer and the reason word beside its exit code -- are queued
 * immediately before this runs. Every signalled `agh -p` lost them, which is the whole of what the
 * reason word was added for.
 *
 * So the code is set, which is what a natural exit reports, and the hard exit is left to a timer
 * that cannot itself hold the process open. If nothing else is holding the loop either, the process
 * ends first and flushes on the way out; if something is, the timer fires and takes it down anyway,
 * which is the case this rung exists for.
 */
function hardExit(code: number): void {
  process.exitCode = code
  setTimeout(() => process.exit(code), FLUSH_MS).unref()
}

/**
 * `--ephemeral` promises the home goes with the run, but only main's finally removed it, and neither a
 * default signal termination nor process.exit -- the ladder's hard exits -- runs that finally. The exit
 * hook removes the home on any exit that runs JavaScript. Whenever the ladder is not installed (during
 * boot, and while the backend closes after a run) a signal leaves through process.exit instead of the
 * default termination, so the hook still runs. The default termination acts the instant a signal is
 * delivered, so the handlers exist before the home does and outlive its removal.
 */
function ephemeralHome(io: MainIO, ladderInstalled: () => boolean): { home: string; release(): void } {
  const signals = io.signals ?? process
  const exit = io.exit ?? ((code: number) => process.exit(code))
  const handlers = (Object.keys(SIGNAL_EXIT_CODES) as SignalName[]).map((sig) => {
    const handler = (): void => {
      if (!ladderInstalled()) exit(SIGNAL_EXIT_CODES[sig])
    }
    signals.on(sig, handler)
    return [sig, handler] as const
  })
  const eph = makeEphemeralHome()
  process.once('exit', eph.dispose)
  return {
    home: eph.home,
    release: () => {
      eph.dispose()
      process.off('exit', eph.dispose)
      for (const [sig, handler] of handlers) signals.off(sig, handler)
    },
  }
}

/**
 * The testable core of the executable. It returns an exit code rather than calling `process.exit`,
 * so every path through the grammar, the boot and the modes can be driven from a test with the
 * process it runs in surviving.
 *
 * `boot` is how a caller supplies the pieces host does not yet build for itself -- today that is the
 * package loader. It is not a general escape hatch: nothing else about the run is injectable here.
 */
export async function main(argv: string[], io: MainIO, boot: Partial<LocalBootDeps> = {}): Promise<number> {
  let p: ReturnType<typeof parseArgs>
  try {
    p = parseArgs(argv)
  } catch (e) {
    io.stderr.write(`${(e as Error).message}\n${usage()}\n`)
    return ExitCode.USAGE
  }
  // A relative --cwd means relative to where the user typed it. Left raw, it reaches the daemon,
  // which resolves it against its own working directory (WORKSPACE_INVALID, or an empty listing).
  if (p.cwd !== undefined) p = { ...p, cwd: resolve(io.cwd, p.cwd) }
  if (p.version) {
    io.stdout.write(`agh ${io.agnesVersion} node ${process.versions.node} protocol _agnes/v1\n`)
    return ExitCode.OK
  }
  if (p.help) {
    io.stdout.write(`${usage()}\n`)
    return ExitCode.OK
  }

  let ladderInstalled = false
  const eph = p.ephemeral ? ephemeralHome(io, () => ladderInstalled) : undefined
  const home = eph?.home ?? resolveHome(io.env)
  // Progress goes to a terminal or nowhere. A redirected stderr belongs to whatever the operator
  // pointed it at, and filling it with spinner text is how a log becomes unreadable.
  const log = (s: string): void => {
    if (io.stderr.isTTY) io.stderr.write(`${s}\n`)
  }
  const deps: LocalBootDeps = {
    env: io.env,
    home,
    cwd: io.cwd,
    agnesVersion: io.agnesVersion,
    log,
    ...boot,
  }
  try {
    if (p.command === 'serve') {
      const { runWebCommand } = await import('../launch/web-command.js')
      await runWebCommand(p.rest, {
        env: io.env,
        cwd: io.cwd,
        write: (text) => io.stdout.write(text),
        ...(io.signals ? { signals: io.signals } : {}),
      })
      return ExitCode.OK
    }
    if (p.command === 'daemon') {
      const parsed = daemonCommandArgs(p.rest, io)
      if (parsed.command === 'start') {
        const webOrigin = io.env.AGNES_WEB_ORIGIN ?? 'http://127.0.0.1:4177'
        await ensureLocalBackend({
          env: io.env,
          cwd: io.cwd,
          ...(parsed.args.home ? { home: parsed.args.home } : {}),
          profile: parsed.args.profile,
          ...(parsed.args.workspace ? { workspace: parsed.args.workspace } : {}),
          ...(parsed.args.dataDir ? { dataDir: parsed.args.dataDir } : {}),
          agnesVersion: io.agnesVersion,
          webOrigin,
          localWeb: { addr: '127.0.0.1:0', origin: webOrigin },
        })
        return ExitCode.OK
      }
      const controlExit = await runDaemonControl(parsed.args, {
        env: io.env,
        write: (text) => io.stdout.write(text),
        // The command line parser above has already made these explicit selections. Reusing the
        // daemon's control path keeps owner identity and stale PID handling in one place.
        scope: resolveDaemonScope,
        ...(parsed.command === 'status' ? { status: daemonStatus } : { stop: stopDaemon }),
      })
      return controlExit ?? ExitCode.ERROR
    }
    if (p.command === 'consent') {
      const { consentCommand } = await import('./commands/consent.js')
      io.stdout.write(`${consentCommand(p, deps)}\n`)
      return ExitCode.OK
    }
    if (p.command === 'stats') {
      const { statsDeviation } = await import('./commands/stats.js')
      io.stdout.write(`${await statsDeviation(p, deps)}\n`)
      return ExitCode.OK
    }
    if (p.command === 'config') {
      const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
      try {
        const snapshot = await readConfigurationSnapshot(booted)
        if (!snapshot) throw new UsageError('configuration is unavailable on this connection')
        const wizard = configurationWizardInput(io)
        try {
          await runConfigurationWizard(booted.client, snapshot, wizard.io)
        } finally {
          wizard.close()
        }
        return ExitCode.OK
      } finally {
        await booted.close().catch(() => undefined)
      }
    }
    if (p.command === 'doctor') {
      if (p.connect !== undefined) throw new UsageError('doctor only runs in one-shot form')
      if ((p.include !== undefined || p.skip !== undefined) && p.positional[0] !== 'computer-use')
        throw new UsageError('--include and --skip are only supported by doctor computer-use')
      if (p.positional[0] === 'computer-use') {
        const { doctorComputerUseCommand, validateDoctorComputerUseArgs } = await import(
          './commands/computer-use.js'
        )
        validateDoctorComputerUseArgs(p)
        const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
        try {
          const result = await doctorComputerUseCommand(p, booted.client)
          io.stdout.write(`${result.text}\n`)
          return result.exitCode
        } finally {
          await booted.close().catch(() => undefined)
        }
      }
      const { doctorCommand } = await import('./commands/doctor.js')
      const result = await doctorCommand(p, deps)
      ;(result.exitCode === ExitCode.USAGE ? io.stderr : io.stdout).write(`${result.text}\n`)
      return result.exitCode
    }
    if (p.command === 'computer-use') {
      const {
        computerUsePermissionsGrantCommand,
        computerUsePermissionsStatusCommand,
        computerUseOperationCommand,
        computerUseStatusCommand,
        isComputerUsePermissionsStatus,
        validateComputerUsePermissionsStatusArgs,
        validateComputerUsePermissionsGrantArgs,
        validateComputerUseOperationArgs,
        validateComputerUseRescueArgs,
        validateComputerUseStatusArgs,
        computerUseRescueCommand,
      } = await import('./commands/computer-use.js')
      if (p.positional[0] === 'rescue') {
        const rescueAction = validateComputerUseRescueArgs(p)
        const scope = await resolveDaemonScope({
          env: io.env,
          cwd: p.cwd ?? io.cwd,
          home,
          ...(p.profile ? { profile: p.profile } : {}),
          ...(p.dataDir ? { dataDir: p.dataDir } : {}),
          agnesVersion: io.agnesVersion,
          allowPackageRecovery: true,
        })
        const executeRescue = async () => {
          const daemon = await daemonStatus(scope.dataDir)
          const { runComputerUseRescue } = await import('@agnes/host')
          return computerUseRescueCommand(p, {
            dataDir: scope.dataDir,
            daemonRunning: daemon.running,
            ...(deps.signal ? { signal: deps.signal } : {}),
            run: runComputerUseRescue,
          })
        }
        if (rescueAction === 'status') {
          const result = await executeRescue()
          io.stdout.write(`${result.text}\n`)
          return result.exitCode
        }
        // Exclude both ordinary launchers and a directly started daemon across the liveness check
        // and activation mutation. The startup lock alone does not exclude direct agnesd startup.
        const maintenance = acquireDaemonOfflineMaintenance(scope)
        try {
          const result = await executeRescue()
          io.stdout.write(`${result.text}\n`)
          return result.exitCode
        } finally {
          maintenance.release()
        }
      }
      // Grammar validation precedes daemon discovery/start so malformed lifecycle verbs cannot have
      // side effects merely because their spelling resembles an installation command.
      if (['install', 'restart', 'operation', 'cancel'].includes(p.positional[0] ?? '')) {
        validateComputerUseOperationArgs(p)
        const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
        try {
          const result = await computerUseOperationCommand(p, booted.client)
          io.stdout.write(`${result.text}\n`)
          return result.exitCode
        } finally {
          await booted.close().catch(() => undefined)
        }
      }
      if (isComputerUsePermissionsStatus(p)) {
        const grant = p.positional[1] === 'grant'
        if (grant) validateComputerUsePermissionsGrantArgs(p)
        else validateComputerUsePermissionsStatusArgs(p)
        const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
        try {
          const result = grant
            ? await computerUsePermissionsGrantCommand(p, booted.client)
            : await computerUsePermissionsStatusCommand(p, booted.client)
          io.stdout.write(`${result.text}\n`)
          return result.exitCode
        } finally {
          await booted.close()
        }
      }
      validateComputerUseStatusArgs(p)
      const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
      try {
        const result = await computerUseStatusCommand(p, booted.client)
        io.stdout.write(`${result.text}\n`)
        return result.exitCode
      } finally {
        await booted.close().catch(() => undefined)
      }
    }
    if (p.command === 'conformance') {
      const { conformanceGateway } = await import('./commands/conformance.js')
      const result = await conformanceGateway(p, deps)
      io.stdout.write(`${result.text}\n`)
      return result.exitCode
    }
    if (p.command === 'export') {
      const { exportSession, validateExportRequest } = await import('./commands/export.js')
      if (p.connect !== undefined) throw new UsageError('export only runs in one-shot form (no --connect)')
      // Refuse a currently unsupported privacy/format request before profile resolution or host
      // startup. A typo in an export flag must not execute packages merely to discover it later.
      validateExportRequest(p)
      const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
      try {
        return await exportSession(p, { cwd: io.cwd, io }, booted.client)
      } finally {
        await booted.close().catch(() => undefined)
      }
    }
    if (p.command === 'import') {
      const { importFile } = await import('./commands/import.js')
      if (p.connect !== undefined || io.env.AGNES_CONNECT !== undefined)
        throw new UsageError('import only runs in one-shot form (no --connect)')
      const booted = await bootLocal(p, deps)
      try {
        if (booted.host === undefined) throw new BootError('local import requires a Host')
        if (booted.sessionAdmission === undefined)
          throw new BootError('local import requires session admission')
        return await importFile(p, {
          env: io.env,
          cwd: p.cwd ?? io.cwd,
          host: booted.host,
          admission: booted.sessionAdmission,
          io: { stdout: io.stdout, stderr: io.stderr },
        })
      } finally {
        await booted.close().catch(() => undefined)
      }
    }
    if (p.command === 'sessions') {
      const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
      try {
        const { sessionsCommand } = await import('./commands/sessions.js')
        return await sessionsCommand(p, booted.client, { stdout: io.stdout, stderr: io.stderr })
      } finally {
        await booted.close().catch(() => undefined)
      }
    }
    if (p.command === 'package' || p.command === 'install') {
      const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
      try {
        const { runPackageCommand } = await import('./commands/package.js')
        // The daemon scope serves only the profile it was booted for, which AGNES_PROFILE can choose.
        await runPackageCommand({ ...p, profile: booted.profileName }, booted.client, {
          write: (text) => io.stdout.write(text),
          confirm: (preview) => confirmPackageInstall(io, preview.id, preview.version, preview.integrity),
        })
        return ExitCode.OK
      } finally {
        await booted.close().catch(() => undefined)
      }
    }
    if (p.command === 'packages') {
      const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
      try {
        const { packagesPinsCommand } = await import('./commands/packages-pins.js')
        await packagesPinsCommand({ ...p, profile: booted.profileName }, booted.client, {
          write: (text) => io.stdout.write(text),
        })
        return ExitCode.OK
      } finally {
        await booted.close().catch(() => undefined)
      }
    }
    if (
      (p.command === 'resources' || p.command === 'skills' || p.command === 'mcp') &&
      !(p.command === 'mcp' && p.rest[0] === 'serve')
    ) {
      await runResourceCliCommand({
        kind: p.command,
        rest: p.rest,
        boot: (profile) =>
          bootDefault({ ...p, ...(profile ? { profile } : {}) }, deps, {
            useEmbedded: Object.keys(boot).length > 0,
          }),
        write: (text) => io.stdout.write(text),
        confirm: (summary) => confirmResourceOperation(io, summary),
        unavailable: () => {
          throw new UsageError('resource control is not supported by this Daemon')
        },
      })
      return ExitCode.OK
    }
    if (p.command === 'profile') {
      const { profileInspect, profileList, profileTrust } = await import('./commands/profile.js')
      const [sub, arg] = p.positional
      if (sub === 'list') {
        io.stdout.write(`${profileList(deps.home)}\n`)
        return ExitCode.OK
      }
      if (sub === 'inspect') {
        if (!arg) throw new UsageError('agh profile inspect requires a profile name')
        io.stdout.write(`${await profileInspect(p, deps, arg)}\n`)
        return ExitCode.OK
      }
      if (sub === 'trust') {
        if (!arg) throw new UsageError('agh profile trust requires a deploy directory')
        const deployDir = resolve(p.cwd ?? deps.cwd, arg)
        const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
        try {
          const profileName = profileNameFrom(p, deps.env)
          io.stdout.write(`${await profileTrust(booted.client, profileName, deployDir)}\n`)
          return ExitCode.OK
        } finally {
          await booted.close().catch(() => undefined)
        }
      }
      throw new UsageError('agh profile requires a subcommand: list | inspect | trust')
    }
    // Commands still require their own runners. ACP is a mode as well as a command alias.
    if (p.command && p.command !== 'resume' && p.command !== 'acp')
      throw new UsageError(`agh ${p.command} is not available in this build`)
    const mode = resolveMode(p, { stdin: io.stdin.isTTY === true, stdout: io.stdout.isTTY === true })
    if (mode !== 'print' && mode !== 'tui' && mode !== 'acp')
      throw new UsageError(`agh ${mode} is not available in this build; use -p`)
    const booted: Booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
    try {
      // The config wizard is deliberately after boot: it uses the same authenticated SDK endpoint as
      // Web and never opens Host credential stores itself. A daemon without the optional config
      // capability remains usable for ordinary sessions; an actual config failure is surfaced.
      if (
        mode === 'tui' &&
        io.stdin.isTTY === true &&
        io.stdout.isTTY === true &&
        // An injected boot is the embedding/test contract: its endpoint may not expose Host config,
        // and consuming the stream here would steal bytes from the embedder's own TUI.
        Object.keys(boot).length === 0
      ) {
        const snapshot = await readConfigurationSnapshot(booted)
        if (snapshot && !snapshot.configured) {
          // Rendered with the TUI's own selectors. `agh config` keeps the line-oriented wizard so
          // a piped or non-TTY caller still has a scriptable path to the same config endpoint.
          const term = new NodeTerminal(io.stdin, io.stdout, io.env)
          const saved = await runOnboardingTui(booted.client, snapshot, term)
          // Cancelled at the root selector: leave without writing anything, as an unconfigured CLI
          // has nothing to open a session with.
          if (saved === undefined || saved.effect === 'restart-required') return ExitCode.OK
        }
      }
      let cancel: () => Promise<void> = async () => undefined
      // Remembered rather than acted on here: the turn the signal cancels ends as `aborted`, and which
      // code that becomes -- 130, 143 or 129 -- is only knowable from the signal that caused it. The
      // ladder exits with the same number by its own route, so the two cannot disagree.
      let signal: SignalName | undefined
      // The ladder closes only once the run it cancelled has finished. Closing straight away tears the
      // transport out from under the request that is still in flight, so the turn comes back as a
      // transport failure instead of as `aborted` and the exit code is 1 rather than the signal's. The
      // grace timer is what bounds the wait if the run never ends at all.
      let settled: Promise<unknown> = Promise.resolve()
      // Resolved before the ladder is armed. Awaiting it inside the `run` expression below would
      // hold `settled` on its initial resolved promise for the whole module load, so a signal
      // arriving in that window would close the backend out from under a run yet to start --
      // the turn then fails as a dropped transport and reports that instead of the signal.
      const resourceController =
        mode === 'tui'
          ? (await import('./commands/resources.js')).createResourceController(booted.client)
          : undefined
      ladderInstalled = true
      const off = installSignalLadder(
        {
          cancel: () => cancel(),
          close: async () => {
            await settled.catch(() => undefined)
            await booted.close()
          },
        },
        {
          graceMs: GRACE_MS,
          exit: io.exit ?? hardExit,
          log,
          onSignal: (s) => {
            signal = s
          },
          ...(io.signals ? { proc: io.signals } : {}),
        },
      )
      try {
        const run =
          mode === 'acp'
            ? runAcp(booted, p, {
                stdin: io.stdin,
                stdout: io.stdout,
                stderr: io.stderr,
                registerCancel: (fn) => {
                  cancel = fn
                },
                signal: () => signal,
              })
            : mode === 'tui'
              ? runTui(booted, p, {
                  env: io.env,
                  stdin: io.stdin,
                  stdout: io.stdout,
                  cwd: p.cwd ?? io.cwd,
                  registerCancel: (fn) => {
                    cancel = fn
                  },
                  signal: () => signal,
                  ...(resourceController ? { resourceController } : {}),
                  composerSelectionPath: join(resolveHome(io.env), 'composer-selection.json'),
                })
              : runPrint(booted, p, {
                  stdout: io.stdout,
                  stderr: io.stderr,
                  stdin: io.stdin,
                  cwd: p.cwd ?? io.cwd,
                  registerCancel: (fn) => {
                    cancel = fn
                  },
                  signal: () => signal,
                })
        // Assigned before the first await, so a signal arriving in the same tick already has something
        // to wait for rather than closing on an empty promise.
        settled = run
        return await run
      } finally {
        off()
        ladderInstalled = false
      }
    } finally {
      await booted.close().catch(() => undefined)
    }
  } catch (e) {
    const safeFailure =
      safeResourceFailureLine(e) ??
      safeExpectedResourceRpcFailureLine(e) ??
      safeExpectedSessionRpcFailureLine(e) ??
      safeDaemonDisconnectLine(e)
    if (safeFailure !== undefined) {
      if (!resourceOperationFailureWasRendered(e)) io.stderr.write(`${safeFailure}\n`)
      return ExitCode.ERROR
    }
    if (e instanceof UsageError || e instanceof BootError || e instanceof CommandError) {
      io.stderr.write(`${e.message}\n`)
      return e.code
    }
    // The stack alone is not an answer: a JSON-RPC failure stringifies to its name and number, and
    // everything an operator could act on -- which refusal, from where -- is in `data.code`.
    const data = (e as { data?: { code?: unknown; message?: unknown } } | null)?.data
    const detail = [data?.code, data?.message].filter((x) => typeof x === 'string').join(': ')
    io.stderr.write(`agnes: ${(e as Error).message}${detail ? ` ${detail}` : ''}\n`)
    io.stderr.write(`${(e as Error).stack ?? String(e)}\n`)
    return ExitCode.ERROR
  } finally {
    eph?.release()
  }
}

/** A non-interactive command never guesses consent: it previews then exits without an install. */
function confirmPackageInstall(io: MainIO, id: string, version: string, integrity: string): Promise<boolean> {
  if (io.stdin.isTTY !== true || io.stdout.isTTY !== true) return Promise.resolve(false)
  return new Promise((resolve) => {
    const prompt = createInterface({ input: io.stdin, output: io.stdout, terminal: true })
    // EOF and Ctrl-C close the interface without ever calling the question callback. Settling as
    // "not confirmed" keeps INV-33: an unanswered prompt is never read as consent. Resolve before
    // close() below, which emits 'close' synchronously and would otherwise bury the answer.
    prompt.once('close', () => resolve(false))
    prompt.question(`Install ${id}@${version} (${integrity})? [y/N] `, (answer) => {
      resolve(/^y(?:es)?$/i.test(answer.trim()))
      prompt.close()
    })
  })
}

function configErrorCode(error: unknown): string | undefined {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code
  return typeof code === 'string' ? code : undefined
}

async function readConfigurationSnapshot(booted: Booted) {
  try {
    return await booted.client.config.get()
  } catch (error) {
    // Older/remote daemons may intentionally omit local configuration. Do not turn a normal chat
    // connection into a startup failure solely because its optional settings surface is absent.
    if (configErrorCode(error) === 'METHOD_NOT_FOUND' || configErrorCode(error) === 'CAPABILITY_DENIED')
      return undefined
    throw error
  }
}

/** The version this build reports. Read from the manifest so there is one place it is written. */
export function agnesVersion(): string {
  if (typeof AGNES_VERSION !== 'undefined') return AGNES_VERSION
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  return String((JSON.parse(raw) as { version?: unknown }).version ?? '0.0.0')
}

/** Replaced with the package version by build:sea; absent in the source/test runtime. */
declare const AGNES_VERSION: string | undefined

export async function runExecutable(): Promise<void> {
  const code = await main(process.argv.slice(2), {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    agnesVersion: agnesVersion(),
  })
  process.exitCode = code
}

const entry = process.argv[1]
function isMainModule(moduleUrl: string): boolean {
  if (entry === undefined) return false
  try {
    // `process.argv[1]` can be a symlink or an alias such as macOS `/var` versus `/private/var`.
    // Compare canonical filesystem paths so relocated/package invocations actually dispatch.
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return moduleUrl === pathToFileURL(entry).href
  }
}

if (!process.getBuiltinModule('node:sea').isSea() && isMainModule(import.meta.url)) {
  // The code is set, not taken. `process.exit` discards whatever is still queued on a pipe, and the
  // last two things a run writes -- the answer and the reason word -- are queued immediately before
  // this point, so exiting here truncated exactly the output the caller was reading. Node leaves
  // with this code once the loop is empty; the signal ladder keeps its own hard exit, which is what
  // a shutdown that will not finish needs.
  void runExecutable()
}
