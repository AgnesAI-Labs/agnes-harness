import { type EngineExit, type ExternalCommand, ExternalProcess } from './transport.js'

export type { EngineExit } from './transport.js'

export type EngineCommand = ExternalCommand & { args: readonly string[] }

/**
 * One child process. Stdout is newline-delimited JSON. The child receives PATH, HOME,
 * USERPROFILE, and `env` only. Stderr is discarded so product diagnostics cannot block the pipe
 * or enter the parent card.
 */
export class EngineProcess {
  readonly exited: Promise<EngineExit>
  readonly ready: Promise<void>
  onMessage: ((message: unknown) => void) | undefined
  onProtocolError: ((error: Error) => void) | undefined
  private readonly proc: ExternalProcess
  private buffer = ''
  private closed = false

  constructor(command: EngineCommand) {
    this.proc = new ExternalProcess(
      command,
      (chunk) => this.ingest(chunk),
      (error) => {
        this.closed = true
        this.onProtocolError?.(error)
      },
    )
    this.ready = this.proc.ready
    this.exited = this.proc.exited
    void this.exited.then((result) => {
      this.closed = true
      if (result.error) this.onProtocolError?.(result.error)
    })
  }

  write(message: unknown): void {
    if (this.closed) throw new Error('child engine is closed')
    void this.proc.write(`${JSON.stringify(message)}\n`).catch((error) => this.onProtocolError?.(error))
  }

  async kill(): Promise<void> {
    this.closed = true
    await this.proc.kill()
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
