import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { isSea } from 'node:sea'
import {
  mergeWindowsEnvironment,
  startWindowsJobProcess,
  type WindowsJobProcess,
} from '@agnes/system-node/process-spawn'

export type EngineExit = { code: number | null; signal: string | null; error?: Error }
export type ExternalCommand = {
  command: string
  args?: readonly string[]
  cwd: string
  env?: Readonly<Record<string, string>>
  /** Trusted Host launch resources, never model input. */
  launch?: Readonly<{ windowsNodeExecutable?: string }>
  /** Only a deployment that verified the wrapper may choose argv-proxy. */
  windowsBatch?: 'script' | 'argv-proxy'
}

/** Shared pipes only. SDK and ACP retain their own authorization and wire protocols. */
export class ExternalProcess {
  readonly ready: Promise<void>
  readonly exited: Promise<EngineExit>
  readonly closed: Promise<void>
  private child: ChildProcessWithoutNullStreams | WindowsJobProcess | undefined
  private readonly controller = new AbortController()
  private closing: Promise<void> | undefined
  private ended = false
  private resolveExit!: (result: EngineExit) => void
  private resolveClose!: () => void

  constructor(command: ExternalCommand, output: (text: string) => void, fail: (error: Error) => void) {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve
    })
    this.closed = new Promise((resolve) => {
      this.resolveClose = resolve
    })
    this.ready = this.start(command, output).catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      this.ended = true
      this.resolveExit({ code: null, signal: null, error })
      if (!this.child) this.resolveClose()
      fail(error)
      throw error
    })
    void this.ready.catch(() => undefined)
  }
  private async start(command: ExternalCommand, output: (text: string) => void) {
    const windows = process.platform === 'win32' // guards-allow-platform: external child launch leaf.
    const env: Record<string, string> = {}
    for (const name of windows
      ? ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']
      : ['PATH', 'HOME', 'USERPROFILE']) {
      const key = windows
        ? Object.keys(process.env).find((key) => key.toUpperCase() === name.toUpperCase())
        : name
      if (key && process.env[key] !== undefined) env[key] = process.env[key]!
    }
    if (windows) {
      const nodeExecutable = command.launch?.windowsNodeExecutable ?? (isSea() ? undefined : process.execPath)
      if (
        !nodeExecutable ||
        !isAbsolute(nodeExecutable) ||
        (isSea() && nodeExecutable.toLowerCase() === process.execPath.toLowerCase())
      )
        throw new Error(
          'Windows child engines require a trusted Node runtime separate from the SEA executable',
        )
      const child = await startWindowsJobProcess([command.command, ...(command.args ?? [])], {
        cwd: command.cwd,
        env: mergeWindowsEnvironment(env, command.env),
        nodeExecutable,
        signal: this.controller.signal,
        // Arbitrary configured scripts retain script semantics; never guess that a .cmd is an argv proxy.
        windowsBatch: command.windowsBatch ?? 'script',
      })
      this.child = child
      child.stderr.resume()
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', output)
      void child.completion.then((result) => {
        this.ended = true
        this.resolveExit({
          code: result.code,
          signal: result.signal,
          ...(result.error ? { error: result.error } : {}),
        })
        this.resolveClose()
      })
      return
    }
    const child = spawn(command.command, [...(command.args ?? [])], {
      cwd: command.cwd,
      env: { ...env, ...command.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdin.on('error', () => undefined)
    child.stdout.on('error', () => undefined)
    child.stderr.on('error', () => undefined)
    child.stderr.resume()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', output)
    child.once('exit', (code, signal) => {
      this.ended = true
      this.resolveExit({ code, signal })
    })
    child.once('close', () => this.resolveClose())
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
  }
  async write(text: string): Promise<void> {
    await this.ready
    if (this.ended || this.closing || !this.child) throw new Error('child engine is closed')
    return new Promise<void>((resolve, reject) =>
      this.child!.stdin.write(text, (error) => (error ? reject(error) : resolve())),
    )
  }
  kill(): Promise<void> {
    this.closing ??= (async () => {
      this.controller.abort()
      await this.ready.catch(() => undefined)
      const child = this.child
      let escalation: NodeJS.Timeout | undefined
      if (child && !('terminate' in child)) {
        if (!this.ended) {
          child.kill()
          child.stdin.destroy()
        }
        escalation = setTimeout(() => child.kill('SIGKILL'), 1000)
        escalation.unref()
      }
      try {
        const result = await this.exited
        if (result.error) throw result.error
      } finally {
        clearTimeout(escalation)
      }
    })()
    return this.closing
  }
}
