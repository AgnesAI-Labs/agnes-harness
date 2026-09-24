import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import type { Runner, RunnerStatus } from './runner.js'

export type HealthzHandle = {
  port: number
  close(): Promise<void>
}

export async function startHealthz(runner: Pick<Runner, 'status'>, port: number): Promise<HealthzHandle> {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('healthz port must be an integer from 0 through 65535')
  }

  const startedAt = Date.now()
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    request.resume()
    if (request.method !== 'GET' || request.url !== '/healthz') {
      response.statusCode = 404
      response.setHeader('cache-control', 'no-store')
      response.end()
      return
    }

    let status: RunnerStatus
    try {
      status = runner.status()
    } catch {
      status = { channel: 'stopped', daemon: 'closed', sessions: 0, degraded: [] }
    }
    const healthy = status.channel === 'connected' && status.daemon === 'connected'
    const body = JSON.stringify({
      channel: status.channel,
      daemon: status.daemon,
      ...(status.lastEventAt === undefined ? {} : { lastEventAt: status.lastEventAt }),
      sessions: status.sessions,
      uptimeSec: Math.floor(Math.max(0, Date.now() - startedAt) / 1_000),
      degraded: [...status.degraded],
    })
    response.statusCode = healthy ? 200 : 503
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('content-length', Buffer.byteLength(body))
    response.end(body)
  })
  server.requestTimeout = 5_000
  server.headersTimeout = 5_000
  server.keepAliveTimeout = 1_000
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer()
    throw new Error('healthz server did not expose a TCP address')
  }

  let closePromise: Promise<void> | undefined
  return {
    port: address.port,
    close() {
      closePromise ??= closeServer()
      return closePromise
    },
  }

  function closeServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error === undefined || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
          resolve()
        } else {
          reject(error)
        }
      })
      for (const socket of sockets) socket.destroy()
    })
  }
}
