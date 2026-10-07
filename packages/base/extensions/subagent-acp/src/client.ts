import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

export type AcpCommand = {
  command: string
  args?: readonly string[]
  cwd: string
  env?: Readonly<Record<string, string>>
}

type RpcMessage = {
  jsonrpc?: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

/** Newline-delimited JSON-RPC for one ACP agent process. The child sees PATH, HOME, and `env` only. */
export class AcpChildProcess {
  private readonly proc: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
  private nextId = 1
  private buffer = ''
  private onText: ((text: string) => void) | undefined
  private closed = false

  constructor(command: AcpCommand) {
    const env: NodeJS.ProcessEnv = {}
    if (process.env.PATH) env.PATH = process.env.PATH
    if (process.env.HOME) env.HOME = process.env.HOME
    if (process.platform === 'win32' && process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE
    for (const [key, value] of Object.entries(command.env ?? {})) env[key] = value
    this.proc = spawn(command.command, [...(command.args ?? [])], {
      cwd: command.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.ingest(chunk))
    this.proc.on('error', (error) => this.failAll(error))
    this.proc.on('exit', (code) => {
      this.closed = true
      this.failAll(new Error(`acp child exited (${code ?? 'null'})`))
    })
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.send({ jsonrpc: '2.0', id, method, params })
    return result
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  set onChunk(listener: ((text: string) => void) | undefined) {
    this.onText = listener
  }

  kill(): void {
    if (this.closed) return
    this.closed = true
    this.proc.kill()
    this.proc.stdin.destroy()
  }

  private send(message: RpcMessage): void {
    if (this.closed) throw new Error('acp child is closed')
    this.proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private ingest(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message: RpcMessage
      try {
        message = JSON.parse(line) as RpcMessage
      } catch (error) {
        this.failAll(error)
        return
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: RpcMessage): void {
    if (message.id !== undefined && message.method) {
      this.reply(message)
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? 'acp request failed'))
      else pending.resolve(message.result ?? {})
      return
    }
    if (message.method !== 'session/update') return
    const update = (message.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } })
      ?.update
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && update.content.text)
      this.onText?.(update.content.text)
  }

  private reply(message: RpcMessage): void {
    if (message.id === undefined) return
    const id = message.id
    if (message.method === 'session/request_permission') {
      const options =
        (message.params as { options?: Array<{ optionId?: string; kind?: string }> } | undefined)?.options ?? []
      const reject = options.find(
        (option): option is { optionId: string; kind?: string } =>
          typeof option.optionId === 'string' && option.kind?.includes('reject') === true,
      )
      this.send(
        reject
          ? { jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: reject.optionId } } }
          : { jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } },
      )
      return
    }
    this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }

  private failAll(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
