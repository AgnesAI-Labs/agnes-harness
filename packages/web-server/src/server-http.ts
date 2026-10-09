import { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { httpRpcError } from '@agnes/protocol'
import { HOST } from './server-assets.js'

export function readLimitedBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const fail = (): void => {
      request.removeAllListeners('data')
      reject(new Error('invalid body'))
    }
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        fail()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (size !== limit) fail()
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', fail)
  })
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  // Compatibility refusals also use the App Server envelope, never exception prose.
  if (body && typeof body === 'object' && 'error' in body) {
    const error = body.error
    if (
      typeof error === 'string' ||
      (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    ) {
      const code = typeof error === 'string' ? 'INVALID_REQUEST' : (error.code as string)
      body = { ...body, error: httpRpcError(status, code) }
    }
  }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  })
  response.end(JSON.stringify(body))
}

export function listen(server: Server, requestedPort: number): Promise<{ port: number; host: string }> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error)
    server.once('error', failed)
    server.listen(requestedPort, HOST, () => {
      server.removeListener('error', failed)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Web listener did not bind'))
        return
      }
      resolve({ port: address.port, host: address.address })
    })
  })
}
