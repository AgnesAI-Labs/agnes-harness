import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import {
  acquireDaemonOfflineMaintenance,
  daemonStatus,
  resolveDaemonScope,
  runDaemonControl,
  stopDaemon,
} from '@agnes/daemon'
import type { MainIO } from '../bin.js'
import { ensureLocalBackend, resolveLocalControlScope } from '../boot/backend.js'
import { bootDefault } from '../boot/default.js'
import { profileNameFrom } from '../boot/inputs.js'
import type { LocalBootDeps } from '../boot/local.js'
import type { prepareCommandArgs } from '../command-entry.js'
import { type ConfigWizardIO, runConfigurationWizard } from '../config-wizard.js'
import { ExitCode, UsageError } from '../errors.js'
import type { Booted } from '../types.js'

type CommandArgs = ReturnType<typeof prepareCommandArgs>

/** What the command branches that live outside bin.ts need from the dispatcher. */
export type BranchContext = {
  io: MainIO
  deps: LocalBootDeps
  home: string
  /** True when the caller injected boot pieces (a test), so commands use the embedded backend. */
  useEmbedded: boolean
}

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

function configErrorCode(error: unknown): string | undefined {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code
  return typeof code === 'string' ? code : undefined
}

export async function readConfigurationSnapshot(booted: Booted) {
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

export async function runDaemonBranch(p: CommandArgs, ctx: BranchContext): Promise<number> {
  const { io } = ctx
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
    scope: resolveLocalControlScope,
    ...(parsed.command === 'status' ? { status: daemonStatus } : { stop: stopDaemon }),
  })
  return controlExit ?? ExitCode.ERROR
}

export async function runConfigBranch(p: CommandArgs, ctx: BranchContext): Promise<number> {
  const { io, deps } = ctx
  if (p.positional[0] === 'dump') {
    const { configDumpCommand } = await import('./config-dump.js')
    io.stdout.write(`${await configDumpCommand(p, deps)}\n`)
    return ExitCode.OK
  }
  if (p.positional.length) throw new UsageError('unknown config command')
  const booted = await bootDefault(p, deps, { useEmbedded: ctx.useEmbedded })
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

export async function runDoctorBranch(p: CommandArgs, ctx: BranchContext): Promise<number> {
  const { io, deps } = ctx
  if (p.connect !== undefined) throw new UsageError('doctor only runs in one-shot form')
  if ((p.include !== undefined || p.skip !== undefined) && p.positional[0] !== 'computer-use')
    throw new UsageError('--include and --skip are only supported by doctor computer-use')
  if (p.positional[0] === 'computer-use') {
    const { doctorComputerUseCommand, validateDoctorComputerUseArgs } = await import('./computer-use.js')
    validateDoctorComputerUseArgs(p)
    const booted = await bootDefault(p, deps, { useEmbedded: ctx.useEmbedded })
    try {
      const result = await doctorComputerUseCommand(p, booted.client)
      io.stdout.write(`${result.text}\n`)
      return result.exitCode
    } finally {
      await booted.close().catch(() => undefined)
    }
  }
  const { doctorCommand } = await import('./doctor.js')
  const result = await doctorCommand(p, deps)
  ;(result.exitCode === ExitCode.USAGE ? io.stderr : io.stdout).write(`${result.text}\n`)
  return result.exitCode
}

export async function runComputerUseBranch(p: CommandArgs, ctx: BranchContext): Promise<number> {
  const { io, deps, home } = ctx
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
  } = await import('./computer-use.js')
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
      const daemon = await daemonStatus(scope.home)
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
    const booted = await bootDefault(p, deps, { useEmbedded: ctx.useEmbedded })
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
    const booted = await bootDefault(p, deps, { useEmbedded: ctx.useEmbedded })
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
  const booted = await bootDefault(p, deps, { useEmbedded: ctx.useEmbedded })
  try {
    const result = await computerUseStatusCommand(p, booted.client)
    io.stdout.write(`${result.text}\n`)
    return result.exitCode
  } finally {
    await booted.close().catch(() => undefined)
  }
}

export async function runPluginsPackBranch(p: CommandArgs, ctx: BranchContext): Promise<number> {
  const { io } = ctx
  const { packPlugin } = await import('@agnes/package-manager')
  if (!p.positional[1]) throw new UsageError('usage: agh plugins pack <folder> [output.tgz]')
  io.stdout.write((await packPlugin(p.positional[1], p.positional[2])) + '\n')
  return 0
}

export async function runPackagesBranch(p: CommandArgs, ctx: BranchContext): Promise<number> {
  const { io, deps } = ctx
  const booted = await bootDefault(p, deps, { useEmbedded: ctx.useEmbedded })
  try {
    const { packagesPinsCommand } = await import('./packages-pins.js')
    await packagesPinsCommand({ ...p, profile: booted.profileName }, booted.client, {
      write: (text) => io.stdout.write(text),
    })
    return ExitCode.OK
  } finally {
    await booted.close().catch(() => undefined)
  }
}

export async function runProfileBranch(p: CommandArgs, ctx: BranchContext): Promise<number> {
  const { io, deps } = ctx
  const { profileInspect, profileList, profileTrust } = await import('./profile.js')
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
    const booted = await bootDefault(p, deps, { useEmbedded: ctx.useEmbedded })
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
