import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

export type EngineExit = { code: number | null; signal: NodeJS.Signals | null }

export type EngineCommand = {
  command: string
  args: readonly string[]
  cwd: string
  env?: Readonly<Record<string, string>>
}

/**
 * One child process. Stdout is newline-delimited JSON. The child receives PATH, HOME,
 * USERPROFILE, and `env` only. Stderr is discarded so product diagnostics cannot block the pipe
 * or enter the parent card.
 */
export class EngineProcess {
  readonly exited: Promise<EngineExit>
  onMessage: ((message: unknown) => void) | undefined
  onProtocolError: ((error: Error) => void) | undefined
  private readonly proc: ChildProcessWithoutNullStreams
  private buffer = ''
  private closed = false
  private exitSettled = false
  private resolveExit: (value: EngineExit) => void = () => undefined

  constructor(command: EngineCommand) {
    const env: NodeJS.ProcessEnv = {}
    if (process.env.PATH) env.PATH = process.env.PATH
    if (process.env.HOME) env.HOME = process.env.HOME
    if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE
    for (const [key, value] of Object.entries(command.env ?? {})) env[key] = value
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve
    })
    this.proc = spawn(command.command, [...command.args], {
      cwd: command.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const ignoreStreamError = () => undefined
    this.proc.stdin.on('error', ignoreStreamError)
    this.proc.stdout.on('error', ignoreStreamError)
    this.proc.stderr.on('error', ignoreStreamError)
    this.proc.stderr.resume()
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.ingest(chunk))
    this.proc.on('error', (error) => {
      this.closed = true
      this.onProtocolError?.(error)
      this.settleExit({ code: null, signal: null })
    })
    this.proc.on('exit', (code, signal) => {
      this.closed = true
      this.settleExit({ code, signal })
    })
  }

  write(message: unknown): void {
    if (this.closed) throw new Error('child engine is closed')
    this.proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  async kill(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.proc.kill()
      this.proc.stdin.destroy()
    }
    const escalation = setTimeout(() => this.proc.kill('SIGKILL'), 1000)
    escalation.unref()
    try {
      await this.exited
    } finally {
      clearTimeout(escalation)
    }
  }

  private settleExit(value: EngineExit): void {
    if (this.exitSettled) return
    this.exitSettled = true
    this.resolveExit(value)
  }

  private ingest(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      try {
        this.onMessage?.(JSON.parse(line) as unknown)
      } catch (error) {
        this.onProtocolError?.(error instanceof Error ? error : new Error('child engine protocol error'))
      }
    }
  }
}
