import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_SERVER_SCHEMA, META_KEY, normalizeRpcError, rpcError } from '@agnes/protocol'
import { APP_SERVER_TYPES } from '@agnes/protocol/gen/app-server-types'
import { FrameDecoder, type JsonRpcMessage, type Transport, unixTransport } from '@agnes/sdk'
import type { MainIO } from '../bin.js'
import { ensureLocalBackend } from '../boot/backend.js'
import { localPipeFactories } from '../boot/pipe-factory.js'
import { UsageError } from '../errors.js'

/** JSONL is only a transport; no Host, session registry or new service is created here. */
export async function runAppServer(argv: readonly string[], io: MainIO): Promise<number> {
  if (argv[0] === 'schema') {
    if (argv.length !== 3 || argv[1] !== '--out' || !argv[2])
      throw new UsageError('agh app-server schema --out <dir>')
    await mkdir(argv[2], { recursive: true })
    await writeFile(join(argv[2], 'app-server-v1.json'), JSON.stringify(APP_SERVER_SCHEMA, null, 2) + '\n')
    await writeFile(join(argv[2], 'app-server.ts'), APP_SERVER_TYPES)
    return 0
  }
  let profile: string | undefined
  let home: string | undefined
  let workspace = io.cwd
  let stdio = false
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--stdio') {
      stdio = true
      continue
    }
    const value = argv[++index]
    if (!value || !['--home', '--profile', '--cwd'].includes(flag ?? ''))
      throw new UsageError('agh app-server --stdio [--home <dir>] [--profile <name>] [--cwd <dir>]')
    if (flag === '--home') home = value
    else if (flag === '--profile') profile = value
    else workspace = value
  }
  if (!stdio) throw new UsageError('agh app-server requires --stdio or schema --out <dir>')
  const backend = await ensureLocalBackend({
    env: io.env,
    cwd: workspace,
    workspace,
    ...(home ? { home } : {}),
    ...(profile ? { profile } : {}),
    agnesVersion: io.agnesVersion,
  })
  const options = { path: backend.socketPath }
  const factory =
    localPipeFactories(backend.socketPath, backend.scope).unix?.({
      kind: 'unix',
      path: backend.socketPath,
    }) ?? unixTransport(options)
  return await bridgeStdio(factory, { ...io, signals: io.signals ?? process })
}

/** Bound framing, output queue and cleanup; ids and server requests pass through unchanged. */
export async function bridgeStdio(
  factory: import('@agnes/sdk').TransportFactory,
  io: Pick<MainIO, 'stdin' | 'stdout' | 'signals'>,
): Promise<number> {
  const decoder = new FrameDecoder()
  const clientId = `stdio-${randomUUID()}`
  let transport: Transport | undefined
  let sending = Promise.resolve()
  let writing = Promise.resolve()
  let queued = 0
  let incoming = 0
  let stopped = false
  let exitCode = 0
  let finish!: () => void
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const stop = () => {
    if (stopped) return
    stopped = true
    finish()
  }
  const interrupt = () => {
    exitCode = 130
    stop()
  }
  const terminate = () => {
    exitCode = 143
    stop()
  }
  const write = (message: unknown) => {
    const line = JSON.stringify(message) + '\n'
    queued += Buffer.byteLength(line)
    if (queued > 32 * 1024 * 1024) {
      stop()
      return
    }
    writing = writing
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            io.stdout.write(line, (error?: Error | null) => (error ? reject(error) : resolve()))
          }),
      )
      .finally(() => {
        queued -= Buffer.byteLength(line)
      })
    void writing.catch(stop)
  }
  try {
    transport = await factory({ onMessage: write, onClose: stop })
    const data = (chunk: Buffer | string) => {
      if (stopped) return
      try {
        for (const original of decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
          let message: JsonRpcMessage = original
          if (
            'method' in message &&
            message.method === 'initialize' &&
            message.params &&
            typeof message.params === 'object' &&
            !Array.isArray(message.params)
          ) {
            const params = (message.params ?? {}) as Record<string, unknown>
            const meta =
              params._meta && typeof params._meta === 'object'
                ? (params._meta as Record<string, unknown>)
                : {}
            const agnes =
              meta[META_KEY] && typeof meta[META_KEY] === 'object'
                ? (meta[META_KEY] as Record<string, unknown>)
                : {}
            message = {
              ...message,
              params: {
                ...params,
                _meta: {
                  ...meta,
                  [META_KEY]: { ...agnes, clientId: agnes.clientId ?? clientId, auth: { kind: 'local' } },
                },
              },
            }
          }
          const bytes = Buffer.byteLength(JSON.stringify(message))
          incoming += bytes
          if (incoming > 32 * 1024 * 1024) {
            stop()
            return
          }
          if (incoming > 2 * 1024 * 1024) io.stdin.pause()
          sending = sending
            .then(() => transport?.send(message))
            .then(() => undefined)
            .finally(() => {
              incoming -= bytes
              if (!stopped && incoming < 2 * 1024 * 1024) io.stdin.resume()
            })
          void sending.catch(stop)
        }
      } catch {
        write({ jsonrpc: '2.0', id: null, error: normalizeRpcError(rpcError('PARSE_ERROR')) })
        stop()
      }
    }
    const end = () => {
      try {
        decoder.end()
      } catch {
        write({ jsonrpc: '2.0', id: null, error: normalizeRpcError(rpcError('INVALID_REQUEST')) })
      }
      stop()
    }
    io.stdin.on('data', data)
    io.stdin.once('end', end)
    io.stdin.once('error', stop)
    io.stdout.once('error', stop)
    io.signals?.once('SIGINT', interrupt)
    io.signals?.once('SIGTERM', terminate)
    if ('readableEnded' in io.stdin && io.stdin.readableEnded === true) end()
    else io.stdin.resume()
    try {
      await done
    } finally {
      io.stdin.off('data', data)
      io.stdin.off('end', end)
      io.stdin.off('error', stop)
      io.stdout.off('error', stop)
      io.stdin.pause()
      io.signals?.off('SIGINT', interrupt)
      io.signals?.off('SIGTERM', terminate)
    }
  } finally {
    await transport?.close()
    // A closed embedder must not keep a bridge alive on a blocked stdout pipe.
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      writing.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000)
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }
  return exitCode
}
