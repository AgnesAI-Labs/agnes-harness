import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createSurfaceRelay } from '../src/surface.node.js'

const servers = new Set<ReturnType<typeof createServer>>()

afterEach(async () => {
  for (const server of servers) server.closeAllConnections()
  await Promise.all(
    [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  servers.clear()
})

describe('Surface Service relay', () => {
  it('binds a fixed HTTP route to one named Service and strips asserted identity', async () => {
    const calls: unknown[] = []
    const relay = createSurfaceRelay(
      [{ method: 'POST', path: '/api/status', extension: 'example/service', service: 'status.get' }],
      {
        clientForRequest: async () => ({
          sessionId: 'session-1',
          extensions: {
            call: async (params) => {
              calls.push(params)
              return { output: { ok: true } }
            },
          },
        }),
      },
    )
    const server = createServer((request, response) => void relay(request, response))
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const response = await fetch(`${base}/api/status`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'one',
        actor: { id: 'forged' },
        nested: { credential: 'forged', keep: true },
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(calls).toEqual([
      {
        sessionId: 'session-1',
        extension: 'example/service',
        service: 'status.get',
        input: { id: 'one', nested: { keep: true } },
      },
    ])
    expect((await fetch(`${base}/api/missing`)).status).toBe(404)
  })

  it('requires an authenticated request-to-client binding before calling a Service', async () => {
    const relay = createSurfaceRelay(
      [{ method: 'POST', path: '/api/status', extension: 'example/service', service: 'status.get' }],
      { clientForRequest: async () => null },
    )
    const server = createServer((request, response) => void relay(request, response))
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect((await fetch(`${base}/api/status`, { method: 'POST', body: '{}' })).status).toBe(401)
  })

  it.each(['v1', 'v2'] as const)(
    'keeps the browser route stable while adapting Service %s',
    async (version) => {
      const calls: unknown[] = []
      const relay = createSurfaceRelay(
        [
          {
            method: 'POST',
            path: '/api/status',
            extension: 'example/service',
            service: 'status.get',
            map: (body) => (version === 'v1' ? { itemId: body.id ?? null } : { id: body.id ?? null }),
          },
        ],
        {
          clientForRequest: async () => ({
            sessionId: 'session-1',
            extensions: {
              call: async (params) => {
                calls.push(params)
                return { output: { id: 'one', status: 'ready' } }
              },
            },
          }),
        },
      )
      const server = createServer((request, response) => void relay(request, response))
      servers.add(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const response = await fetch(`${base}/api/status?actor=forged`, {
        method: 'POST',
        body: JSON.stringify({ id: 'one', commandId: 'browser-controlled' }),
      })
      expect(await response.json()).toEqual({ id: 'one', status: 'ready' })
      expect(calls).toEqual([
        {
          sessionId: 'session-1',
          extension: 'example/service',
          service: 'status.get',
          input: version === 'v1' ? { itemId: 'one' } : { id: 'one' },
        },
      ])
    },
  )
})
