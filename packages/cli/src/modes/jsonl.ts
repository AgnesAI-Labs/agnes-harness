import { MAX_FRAME_BYTES } from '@agnes/protocol'
import type { JsonRpcMessage } from '@agnes/sdk'
import type { CliRpcEndpoint } from '../types.js'

export class FrameTooLarge extends Error {
  constructor() {
    super(`JSONL frame exceeds ${MAX_FRAME_BYTES} bytes`)
    this.name = 'FrameTooLarge'
  }
}

/** Stateful newline framing. The byte limit is enforced before UTF-8 decoding. */
export function splitLines(): (chunk: Buffer) => string[] {
  let rest = Buffer.alloc(0)
  return (chunk) => {
    let buffer = Buffer.concat([rest, chunk])
    const lines: string[] = []
    for (;;) {
      const newline = buffer.indexOf(0x0a)
      if (newline < 0) break
      // The ceiling counts message bytes, not the delimiter, and a CR before the LF belongs to the
      // delimiter -- the same one stripped here. Measuring against the LF index would bill it.
      const end = newline > 0 && buffer[newline - 1] === 0x0d ? newline - 1 : newline
      if (end > MAX_FRAME_BYTES) throw new FrameTooLarge()
      lines.push(buffer.subarray(0, end).toString('utf8'))
      buffer = buffer.subarray(newline + 1)
    }
    // A trailing CR may be the first half of a delimiter split across reads, so it is not payload.
    const pending = buffer.at(-1) === 0x0d ? buffer.length - 1 : buffer.length
    if (pending > MAX_FRAME_BYTES) throw new FrameTooLarge()
    rest = buffer
    return lines
  }
}

type PumpOptions = {
  endpoint: CliRpcEndpoint
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  signal?: AbortSignal
}

async function write(
  stream: NodeJS.WritableStream,
  message: JsonRpcMessage,
  signal: AbortSignal,
): Promise<void> {
  if (stream.write(`${JSON.stringify(message)}\n`)) return
  await new Promise<void>((resolve, reject) => {
    // EOF does not mean an in-flight prompt has finished, so the bound belongs to an actual blocked
    // drain rather than to overall shutdown. A slow model may legitimately answer well after EOF.
    const timer = setTimeout(() => failed(new Error('ACP output drain timeout')), 1_000)
    timer.unref()
    const cleanup = (): void => {
      clearTimeout(timer)
      stream.off('drain', drained)
      stream.off('error', failed)
      signal.removeEventListener('abort', aborted)
    }
    const drained = (): void => {
      cleanup()
      resolve()
    }
    const failed = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const aborted = (): void => {
      cleanup()
      reject(signal.reason ?? new Error('ACP output closed'))
    }
    stream.once('drain', drained)
    stream.once('error', failed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

const protocolError = (code: number, message: string): JsonRpcMessage =>
  ({
    jsonrpc: '2.0',
    // JSON-RPC requires null when no request id could be recovered. The SDK transport type omits
    // this foreign-wire case because its client drops it; a stdio server still has to emit it.
    id: null,
    error: { code, message, data: { code: code === -32700 ? 'PARSE_ERROR' : 'INVALID_REQUEST' } },
  }) as unknown as JsonRpcMessage

/** Bridges one JSONL stream to one endpoint and closes it after stdin reaches EOF. */
export async function pump({ endpoint, stdin, stdout, stderr, signal }: PumpOptions): Promise<void> {
  const split = splitLines()
  let chain = Promise.resolve()
  let writes = Promise.resolve()
  // In-flight session/prompt dispatches and the session each one runs a turn in.
  const turns = new Map<Promise<void>, unknown>()
  const closing = new AbortController()
  let stopped = false
  const send = (message: JsonRpcMessage): Promise<void> => {
    writes = writes.then(() => write(stdout, message, closing.signal))
    return writes
  }
  const forward = (async () => {
    for await (const notification of endpoint.notifications) await send(notification)
  })()
  // Nothing inspects this until the Promise.allSettled below, which only stdin EOF reaches. Claim
  // the rejection now so a notification write that fails before then is not an unhandled one: under
  // Node's default --unhandled-rejections=throw that would end the process and every session in it.
  // `forward` itself stays rejected, so the settled inspection below still reports the failure.
  void forward.catch(() => undefined)

  const dispatch = (message: JsonRpcMessage): Promise<void> =>
    (async () => {
      const response = await endpoint.handle(message)
      if (response) await send(response)
    })().catch((error: unknown) => {
      stderr.write(`${(error as Error).message}\n`)
    })

  const enqueue = (message: JsonRpcMessage): void => {
    // Preserve wire order. In particular, session/new must not overtake initialize merely because
    // both frames arrived in one OS chunk. A prompt still starts in order but does not hold the frames
    // behind it: its handle() lasts the whole turn, and session/cancel, answers to the endpoint's own
    // session/request_permission, and a second prompt the endpoint must refuse as busy all have to
    // reach it during that turn.
    chain = chain
      .then(() => {
        if (closing.signal.aborted) return
        if (!('method' in message) || message.method !== 'session/prompt') return dispatch(message)
        const turn = dispatch(message).finally(() => turns.delete(turn))
        turns.set(turn, (message.params as { sessionId?: unknown } | undefined)?.sessionId)
      })
      .catch((error: unknown) => {
        stderr.write(`${(error as Error).message}\n`)
      })
  }

  const enqueueError = (code: number, message: string): void => {
    // Terminated like enqueue above, and for the same reason: leaving the shared chain rejected
    // makes the next frame's .then skip its dispatch, so that request reaches neither the endpoint
    // nor a response. The write failure itself is still reported, and `writes` still carries it.
    chain = chain
      .then(() => send(protocolError(code, message)))
      .catch((error: unknown) => {
        stderr.write(`${(error as Error).message}\n`)
      })
  }

  let primaryFailure: { reason: unknown } | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        if (stopped) return
        stopped = true
        resolve()
      }
      const abort = (): void => {
        stdin.pause()
        closing.abort(signal?.reason ?? new Error('ACP cancelled'))
        // Shutdown asks each running turn to stop instead of waiting for it to finish on its own.
        for (const sessionId of new Set(turns.values()))
          if (typeof sessionId === 'string')
            void dispatch({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
        finish()
      }
      stdin.on('data', (raw: Buffer | string) => {
        if (stopped) return
        let lines: string[]
        try {
          lines = split(Buffer.isBuffer(raw) ? raw : Buffer.from(raw))
        } catch (error) {
          stopped = true
          stdin.pause()
          void send(protocolError(-32600, (error as Error).message)).then(resolve, reject)
          return
        }
        for (const line of lines) {
          if (line.length === 0) continue
          try {
            const parsed: unknown = JSON.parse(line)
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
              enqueueError(-32600, 'invalid request')
            else enqueue(parsed as JsonRpcMessage)
          } catch {
            enqueueError(-32700, 'parse error')
          }
        }
      })
      stdin.once('end', finish)
      stdin.once('error', reject)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    await chain
    // EOF does not cancel a running turn (see write()); its answer is still owed to the client.
    await Promise.all(turns.keys())
  } catch (reason) {
    // A caller-triggered cancellation is the normal shutdown path. The abort also rejects a
    // pending stdout drain so that endpoint.close() and the ephemeral main() finally can run.
    if (!signal?.aborted) primaryFailure = { reason }
  }
  const results = await Promise.allSettled([endpoint.close(), forward, writes])
  if (primaryFailure) throw primaryFailure.reason
  if (!signal?.aborted) for (const result of results) if (result.status === 'rejected') throw result.reason
}
