import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { TransportClosed } from '../errors.js'
import { encodeFrame, FrameDecoder } from './jsonl.js'
import { startStdioProcess } from './stdio-process.node.js'
import type { CloseInfo, JsonRpcMessage, Transport, TransportFactory } from './types.js'

export type StdioOptions = {
  cmd: string[]
  env?: Record<string, string>
  cwd?: string
  stderrTailBytes?: number
  shutdownGraceMs?: number
  /** Trusted Node.js executable required when the SDK runs inside a Windows SEA. */
  nodeExecutable?: string
  /** Select argv-proxy only for a known batch wrapper forwarding %* to a native program. */
  windowsBatch?: 'script' | 'argv-proxy'
}

/** A byte budget, including when the retained tail starts in the middle of a UTF-8 character. */
class TailBuffer {
  private bytes = Buffer.alloc(0)
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    this.bytes = Buffer.from(Buffer.concat([this.bytes, chunk]).subarray(-this.max))
    if (this.max === 0) this.bytes = Buffer.alloc(0)
  }
  get text(): string {
    if (this.max === 0) return ''
    // Replacement characters can expand invalid input; bound the rendered UTF-8 a second time.
    const rendered = Buffer.from(this.bytes.toString('utf8')).subarray(-this.max)
    let start = 0
    while (start < rendered.length && ((rendered[start] ?? 0) & 0xc0) === 0x80) start++
    return rendered.subarray(start).toString('utf8')
  }
}

export function stdioTransport(opts: StdioOptions): TransportFactory {
  const [bin, ...args] = opts.cmd
  if (!bin) throw new TypeError('stdio transport needs cmd[0]')
  const grace = opts.shutdownGraceMs ?? 2000
  const tailBytes = opts.stderrTailBytes ?? 4096
  if (!Number.isSafeInteger(grace) || grace < 0 || grace > 2_147_483_647)
    throw new RangeError('shutdownGraceMs must be an integer between 0 and 2147483647')
  if (!Number.isSafeInteger(tailBytes) || tailBytes < 0)
    throw new RangeError('stderrTailBytes must be a nonnegative integer')
  return async (handlers) => {
    const windows = process.platform === 'win32' // guards-allow-platform: owned Windows stdio process tree.
    // Keep POSIX spawn and listener registration in one synchronous turn, including spawn errors.
    const child = windows
      ? await startStdioProcess([bin, ...args], opts.cwd, opts.env, opts)
      : spawn(bin, args, {
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          env: { ...process.env, ...opts.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
    const tail = new TailBuffer(tailBytes)
    const decoder = new FrameDecoder()
    const shutdownId = `agnes-sdk-shutdown:${randomUUID()}`
    let ended = false
    let processExited = false
    let outputEnded = false
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    let closing: Promise<void> | undefined
    let failure: Error | undefined
    let resolveExit: () => void = () => {}
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    let resolveAck: () => void = () => {}
    const acknowledged = new Promise<void>((resolve) => {
      resolveAck = resolve
    })
    const closedError = () => new TransportClosed({ reason: 'closed' })

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (ended) return
      ended = true
      if (drainTimer !== undefined) clearTimeout(drainTimer)
      if (!failure) {
        try {
          decoder.end()
        } catch (error) {
          failure = error as Error
        }
      }
      resolveExit()
      const info: CloseInfo = {
        reason: failure ? 'error' : 'exit',
        exitCode,
        signal,
        stderrTail: tail.text,
        ...(failure ? { error: failure } : {}),
      }
      handlers.onClose(info)
    }
    const destroyPipes = (): void => {
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    }
    // Prefer close so the final diagnostics drain. A descendant can inherit these pipes, though,
    // so exit starts a bounded drain even if neither stdout EOF nor explicit close ever arrives.
    child.once('exit', (exitCode, signal) => {
      processExited = true
      drainTimer = setTimeout(() => {
        destroyPipes()
        finish(exitCode, signal)
      }, grace)
    })
    child.once('close', finish)
    const fail = (error: Error): void => {
      if (ended) return
      failure ??= error
      child.kill('SIGKILL')
    }
    child.once('error', fail)
    child.stdin.on('error', fail)
    child.stdout.on('error', fail)
    child.stderr.on('error', fail)
    child.stderr.on('data', (chunk: Buffer) => {
      if (!ended) tail.push(chunk)
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (ended || failure) return
      try {
        for (const message of decoder.push(chunk)) {
          if ('id' in message && message.id === shutdownId && !('method' in message)) resolveAck()
          else handlers.onMessage(message)
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error('stdio message handler failed'))
      }
    })
    child.stdout.once('end', () => {
      outputEnded = true
      if (!failure) {
        try {
          decoder.end()
        } catch (error) {
          fail(error as Error)
        }
      }
      // EOF is loss of liveness even when a child keeps running with stdout closed.
      void close()
    })

    const wait = async (event: Promise<void>): Promise<void> => {
      if (ended) return
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          event,
          exited,
          new Promise<void>((r) => {
            timer = setTimeout(r, grace)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    const write = async (message: JsonRpcMessage): Promise<void> => {
      const frame = encodeFrame(message)
      if (ended || processExited || failure || !child.stdin.writable) throw closedError()
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(frame, (error) => (error ? reject(closedError()) : resolve()))
      })
    }
    async function teardown(): Promise<void> {
      if (ended) return
      if (processExited) {
        await exited
        return
      }
      // A private string id cannot collide with RpcConnection's monotonically increasing numbers.
      // After output EOF the peer cannot acknowledge; writing shutdown can turn its exit into EPIPE.
      if (!failure && !outputEnded && child.stdin.writable)
        void write({ jsonrpc: '2.0', id: shutdownId, method: 'shutdown', params: {} }).catch(() => {})
      await wait(acknowledged)
      if (ended) return
      child.stdin.end()
      await wait(exited)
      if (ended) return
      child.kill('SIGTERM')
      await wait(exited)
      if (ended) return
      child.kill('SIGKILL')
      await wait(exited)
      // Descendants may still hold inherited pipes after the owned process dies. They must not
      // keep this client's close pending forever; no further protocol traffic is legal now.
      if (!ended) {
        destroyPipes()
      }
      await exited
    }
    function close(): Promise<void> {
      closing ??= teardown()
      return closing
    }
    const transport: Transport = {
      kind: 'stdio',
      async send(message) {
        if (closing) throw closedError()
        await write(message)
      },
      close,
    }
    return transport
  }
}
