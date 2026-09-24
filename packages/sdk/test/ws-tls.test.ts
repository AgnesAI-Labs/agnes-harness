import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { TransportClosed } from '../src/errors.js'
import type { Transport } from '../src/transport/types.js'
import { wsTransport } from '../src/transport/ws.node.js'

it('verifies TLS by default and accepts an explicitly trusted test CA without disabling verification', async () => {
  // Public test-only material; default trust must still reject this self-signed certificate.
  const key = readFileSync(
    new URL('../../../tools/test-fixtures/tls/localhost-key.pem', import.meta.url),
    'utf8',
  )
  const cert = readFileSync(
    new URL('../../../tools/test-fixtures/tls/localhost-cert.pem', import.meta.url),
    'utf8',
  )
  const server = createServer({ key, cert })
  const wss = new WebSocketServer({ server })
  const seen: string[] = []
  wss.on('connection', (_socket, request) => seen.push(String(request.headers['x-test-header'] ?? '')))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  let transport: Transport | undefined
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing TLS socket')
    const url = `wss://127.0.0.1:${address.port}`
    await expect(wsTransport({ url })({ onMessage() {}, onClose() {} })).rejects.toBeInstanceOf(
      TransportClosed,
    )
    expect(seen).toEqual([])
    transport = await wsTransport({ url, tls: { ca: cert }, headers: { 'X-Test-Header': 'present' } })({
      onMessage() {},
      onClose() {},
    })
    expect(seen).toEqual(['present'])
  } finally {
    await transport?.close()
    for (const socket of wss.clients) socket.terminate()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
