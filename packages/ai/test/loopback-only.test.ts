import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  assertLoopbackOnly,
  clearOffMachineAttempts,
  installLoopbackOnly,
  offMachineAttempts,
  restoreLoopbackOnly,
} from './loopback-only.js'

/**
 * The guard's own proof. The two loopback tests assert that nothing left the machine; this asserts
 * that such an assertion could have failed — a guard that never refuses anything would let both of
 * them pass by doing nothing, which is the failure mode this whole round was about.
 *
 * The address is 192.0.2.1, TEST-NET-1 from RFC 5737: reserved for documentation and not routable,
 * so even a broken guard could not reach anything with it. It is never contacted in any case,
 * because the refusal happens before the name lookup and before the connect.
 */
const OFF_MACHINE = '192.0.2.1'

let server: http.Server
let port = 0

beforeAll(async () => {
  installLoopbackOnly()
  server = http.createServer((_req, res) => res.end('ok'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
})

afterAll(async () => {
  restoreLoopbackOnly()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(() => clearOffMachineAttempts())

/** Either shape of refusal counts: thrown out of the call, or raised on the request. */
const attempt = async (start: () => { on: (event: 'error', fn: (e: Error) => void) => unknown }) =>
  new Promise<unknown>((resolve) => {
    try {
      start().on('error', resolve)
    } catch (e) {
      resolve(e)
    }
  })

describe('the loopback guard', () => {
  it('refuses a plain socket to an address off this machine', () => {
    expect(() => net.connect(80, OFF_MACHINE)).toThrow(/refused an outbound connection/)
    expect(offMachineAttempts()).toEqual([{ host: OFF_MACHINE, port: 80, via: 'socket' }])
  })

  it('refuses a TLS connection, which is where an SDK with its own http handler goes', () => {
    expect(() => tls.connect({ host: OFF_MACHINE, port: 443 })).toThrow(/refused an outbound/)
    expect(offMachineAttempts()).toEqual([{ host: OFF_MACHINE, port: 443, via: 'tls' }])
  })

  // The `fetch` wrapper in the loopback tests cannot see this one: `http.request` goes through an
  // agent and a socket, which is exactly the path `bedrock-converse-stream` takes.
  it('refuses an agent-driven http request', async () => {
    await attempt(() => http.get(`http://${OFF_MACHINE}:9/`))
    expect(offMachineAttempts().map((a) => a.host)).toEqual([OFF_MACHINE])
  })

  // An unresolved hostname is refused too, before the lookup: a name is not evidence of a
  // destination, and waiting for DNS would already have told the network something.
  it('refuses a hostname, without resolving it', () => {
    expect(() => net.connect(443, 'bedrock-runtime.us-east-1.amazonaws.com')).toThrow()
    expect(offMachineAttempts().map((a) => a.host)).toEqual(['bedrock-runtime.us-east-1.amazonaws.com'])
  })

  it('lets loopback through, by address and by name', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/`, (res) => {
          let text = ''
          res.on('data', (c) => {
            text += String(c)
          })
          res.on('end', () => resolve(text))
        })
        .on('error', reject)
    })
    expect(body).toBe('ok')
    expect(offMachineAttempts()).toEqual([])
  })

  it('turns a recorded attempt into a failure, and clears it', () => {
    expect(() => net.connect(80, OFF_MACHINE)).toThrow()
    expect(() => assertLoopbackOnly()).toThrow(/tried to connect off this machine/)
    expect(() => assertLoopbackOnly()).not.toThrow()
  })
})
