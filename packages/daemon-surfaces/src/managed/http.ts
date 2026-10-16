import { request } from 'node:http'
import type { SurfaceEndpoint } from '../surfaces/types.js'

/** Private supervisor channel. Its bounded body and incarnation never enter public status/config. */
export function managedRequest(
  endpoint: SurfaceEndpoint,
  incarnation: string,
  path: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: endpoint.host,
        port: endpoint.port,
        path,
        method: body === undefined ? 'GET' : 'POST',
        signal,
        headers: {
          'x-agnes-incarnation': incarnation,
          'content-type': 'application/json',
          connection: 'close',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        let bytes = 0
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength
          if (bytes > 65536) req.destroy(new Error('invalid managed response'))
          else chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('end', () => {
          try {
            if (res.statusCode !== 200 || bytes > 65536) throw new Error('unavailable managed endpoint')
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.once('error', reject)
    req.setTimeout(body === undefined ? 1000 : 5000, () => req.destroy(new Error('managed endpoint timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
