import { createConnection } from 'node:net'
import type { Duplex } from 'node:stream'
import { connectWindowsPipe } from '@agnes/system-node/windows-pipe'
import { ProtocolViolation, TransportClosed } from '../errors.js'
import { encodeFrame, FrameDecoder } from './jsonl.js'
import type { CloseInfo, TransportFactory } from './types.js'

export function unixTransport(opts: {
  path: string
  connectTimeoutMs?: number
  serverIdentity?: { pid: number; processStartId: string }
  /** Called for each attempt inside the connect deadline; the caller owns trusted discovery. */
  resolveServerIdentity?: () => Promise<{ pid: number; processStartId: string }>
}): TransportFactory {
  const timeout = opts.connectTimeoutMs ?? 3000
  const path = opts.path
  const expected = opts.serverIdentity
  if (expected !== undefined && (!expected || typeof expected !== 'object'))
    throw new TypeError('invalid Windows server identity')
  const identity =
    expected === undefined ? undefined : { pid: expected.pid, processStartId: expected.processStartId }
  const resolveIdentity = opts.resolveServerIdentity
  if (resolveIdentity !== undefined && (typeof resolveIdentity !== 'function' || identity))
    throw new TypeError('provide either a server identity or a trusted identity resolver')
  const windows = process.platform === 'win32' // guards-allow-platform: Node local transport must reject every unverified Windows path, including aliases.
  if ((windows || path.startsWith('\\\\.\\pipe\\')) && !identity && !resolveIdentity)
    throw new TypeError('Windows pipe requires a verified server identity')
  if ((identity || resolveIdentity) && !path.startsWith('\\\\.\\pipe\\'))
    throw new TypeError('server identity requires a Windows pipe')
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2147483647)
    throw new RangeError('invalid connect timeout')
  return (handlers) =>
    new Promise((resolve, reject) => {
      let socket: Duplex | undefined
      const abort = new AbortController()
      const decoder = new FrameDecoder()
      let opened = false
      let ended = false
      let closing: Promise<void> | undefined
      let closeDone!: () => void
      const disconnected = new Promise<void>((done) => {
        closeDone = done
      })
      const unavailable = () =>
        new TransportClosed({ reason: 'error', error: new Error('unix connection unavailable') })
      const finish = (info: CloseInfo) => {
        if (ended) return
        ended = true
        clearTimeout(timer)
        abort.abort()
        socket?.destroy()
        if (!opened) reject(new TransportClosed(info))
        if (!socket || socket.closed) closeDone()
        handlers.onClose(info)
      }
      const timer = setTimeout(() => finish(unavailable().info), timeout)
      const attach = (connection: Duplex, connected: boolean) => {
        if (ended) {
          connection.destroy()
          return
        }
        socket = connection
        connection.on('error', () => finish(unavailable().info))
        connection.on('close', () => {
          closeDone()
          if (ended) return
          try {
            decoder.end()
            finish({ reason: 'eof' })
          } catch (error) {
            finish({ reason: 'error', error: error as Error })
          }
        })
        connection.on('data', (bytes: Buffer) => {
          if (ended) return
          try {
            for (const frame of decoder.push(bytes)) {
              if (ended) break
              handlers.onMessage(frame)
            }
          } catch (error) {
            finish({
              reason: 'error',
              error: error instanceof ProtocolViolation ? error : new Error('unix message handler failed'),
            })
          }
        })
        const ready = () => {
          if (ended) return
          opened = true
          clearTimeout(timer)
          resolve({
            kind: 'unix',
            async send(msg) {
              if (ended) throw new TransportClosed({ reason: 'closed' })
              const bytes = encodeFrame(msg)
              await new Promise<void>((sent, failed) =>
                connection.write(bytes, (error) => (error ? failed(unavailable()) : sent())),
              )
            },
            close() {
              closing ??= Promise.resolve()
                .then(() => finish({ reason: 'closed' }))
                .then(() => disconnected)
              return closing
            },
          })
        }
        if (connected) ready()
        else connection.once('connect', ready)
      }
      const connect = async () => {
        if (identity || resolveIdentity) {
          const resolved = resolveIdentity ? await resolveIdentity() : identity
          if (ended) return
          if (!resolved || typeof resolved !== 'object') throw unavailable()
          const connection = await connectWindowsPipe({
            path,
            pid: resolved.pid,
            processStartId: resolved.processStartId,
            timeoutMs: timeout,
            signal: abort.signal,
          })
          attach(connection, true)
        } else {
          attach(createConnection(path), false)
        }
      }
      void connect().catch(() => finish(unavailable().info))
    })
}
