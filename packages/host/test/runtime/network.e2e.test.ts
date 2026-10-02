import type { lookup } from 'node:dns/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  boundary,
  cleanup,
  error,
  inline,
  loopback,
  must,
  network,
  peer,
  request,
  rule,
  scratch,
} from './network-secrets-fixture.js'
import { waitFor } from './network-secrets-process.js'

describe.each(['default', 'reference'] as const)('%s network transport', (kind) => {
  it('bounds pending DNS and closes admission without opening a connection', async () => {
    const root = scratch()
    const auth = boundary()
    let reached!: () => void
    const entered = new Promise<void>((resolve) => {
      reached = resolve
    })
    const service = network(kind, root, auth, [rule(1234)], {
      resolver: (async () => {
        reached()
        return new Promise(() => {})
      }) as never,
      timeoutMs: 25,
    })
    try {
      const pending = service.request(request(1234), auth.call())
      await entered
      expect(error(await pending)).toBe('cancelled/network_cancelled')
      await service.close()
      expect(error(await service.request(request(1234), auth.call()))).toBe('denied/network_closed')
    } finally {
      await service.close()
      cleanup(root)
    }
  })
  it('records response evidence, replays the exact request after cold open and rejects identity reuse', async () => {
    const remote = await peer()
    const root = scratch()
    const auth = boundary()
    let service = network(kind, root, auth, [rule(remote.port)], { resolver: loopback })
    try {
      const call = auth.call({ invocationId: 'same-request' })
      const input = request(remote.port)
      const first = must(await service.request(input, call))
      expect(first.status).toBe(200)
      expect(Buffer.from(await serviceContent(first.bodyRef))).toEqual(Buffer.from('peer-result'))
      expect(first.receipt?.kind).toBe('inline')
      expect(remote.requests()).toBe(1)
      await service.close()
      service = network(kind, root, auth, [rule(remote.port)], { resolver: loopback })
      expect(must(await service.request(input, call))).toEqual(first)
      expect(remote.requests()).toBe(1)
      expect(error(await service.request({ ...input, method: 'POST' }, call))).toBe(
        'conflict/network_request_identity',
      )
      async function serviceContent(ref: typeof first.bodyRef) {
        const { readFileSync } = await import('node:fs')
        return readFileSync(`${root}/content/${ref.blobId}`)
      }
    } finally {
      await service.close()
      await remote.close()
      cleanup(root)
    }
  })
  it('blocks denied targets, mixed DNS and DNS rebinding before TCP connects; rechecks revoked policy after DNS', async () => {
    const remote = await peer()
    const root = scratch()
    const auth = boundary()
    let authorized = true
    let addresses = [{ address: '127.0.0.1', family: 4 }]
    let revokeDuringResolution = false
    const service = network(kind, root, auth, [rule(remote.port)], {
      authorize: () => authorized,
      resolver: (async () => {
        if (revokeDuringResolution) authorized = false
        return addresses
      }) as unknown as typeof lookup,
    })
    try {
      expect(
        error(
          await service.request(
            request(remote.port, '/normal', {
              target: { ...request(remote.port).target, targetId: 'unlisted' },
            }),
            auth.call(),
          ),
        ),
      ).toBe('denied/network_denied')
      addresses = [
        { address: '127.0.0.1', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]
      expect(error(await service.request(request(remote.port), auth.call()))).toBe('denied/network_address')
      addresses = [{ address: '127.0.0.2', family: 4 }]
      expect(error(await service.request(request(remote.port), auth.call()))).toBe('denied/network_address')
      addresses = [{ address: '127.0.0.1', family: 4 }]
      revokeDuringResolution = true
      expect(error(await service.request(request(remote.port), auth.call()))).toBe('denied/network_denied')
      expect(remote.connections()).toBe(0)
      expect(remote.requests()).toBe(0)
    } finally {
      await service.close()
      await remote.close()
      cleanup(root)
    }
  })
  it('revalidates redirect targets, strips credentials, caps response bytes and leaves denied peers untouched', async () => {
    const remote = await peer()
    const root = scratch()
    const auth = boundary()
    const service = network(kind, root, auth, [rule(remote.port)], { resolver: loopback })
    try {
      const normal = must(
        await service.request(
          request(remote.port, '/redirect', {
            headers: inline({ authorization: 'invalid', cookie: 'invalid' }),
          }),
          auth.call(),
        ),
      )
      expect(normal.finalTarget.path).toBe('/normal')
      expect(remote.requests()).toBe(2)
      expect(remote.observed()).toEqual([
        { path: '/redirect', authorization: 'invalid', cookie: 'invalid' },
        { path: '/normal', authorization: undefined, cookie: undefined },
      ])
      expect(error(await service.request(request(remote.port, '/private'), auth.call()))).toBe(
        'denied/network_redirect',
      )
      expect(remote.requests()).toBe(3)
      expect(
        error(
          await service.request(
            request(remote.port, '/redirect', { redirect: { mode: 'deny', maxHops: 0 } }),
            auth.call(),
          ),
        ),
      ).toBe('denied/network_redirect')
      expect(error(await service.request(request(remote.port, '/oversize'), auth.call()))).toBe(
        'denied/network_response_limit',
      )
      expect(
        error(await service.request(request(remote.port, '/redirect', { method: 'POST' }), auth.call())),
      ).toBe('incompatible/network_redirect_method')
    } finally {
      await service.close()
      await remote.close()
      cleanup(root)
    }
  })
  it('cancels and times out real requests, drains sockets, and never resends uncertain work after reopening', async () => {
    const remote = await peer()
    const root = scratch()
    const auth = boundary()
    let service = network(kind, root, auth, [rule(remote.port)], { resolver: loopback, timeoutMs: 40 })
    try {
      const call = auth.call({ invocationId: 'uncertain' })
      const input = request(remote.port, '/slow')
      expect(error(await service.request(input, call))).toBe('unknown_effect/network_unknown')
      expect(remote.requests()).toBe(1)
      await service.close()
      service = network(kind, root, auth, [rule(remote.port)], { resolver: loopback })
      expect(error(await service.request(input, call))).toBe('unknown_effect/network_unknown')
      expect(remote.requests()).toBe(1)
      const abort = new AbortController()
      const pending = service.request(input, auth.call({ signal: abort.signal }))
      await waitFor(() => remote.requests() === 2)
      abort.abort()
      expect(error(await pending)).toBe('unknown_effect/network_unknown')
      await waitFor(() => remote.active() === 0)
      const disposing = service.request(input, auth.call())
      await waitFor(() => remote.requests() === 3)
      expect(remote.active()).toBe(1)
      await service.close()
      expect(error(await disposing)).toBe('unknown_effect/network_unknown')
      await waitFor(() => remote.active() === 0)
      expect(error(await service.request(input, auth.call()))).toBe('denied/network_closed')
    } finally {
      await service.close()
      await remote.close()
      cleanup(root)
    }
  })
})

it('refuses unsupported public IPv6 before connecting in the reference provider', async () => {
  const root = scratch()
  const remote = await peer()
  const auth = boundary()
  const { addresses: _addresses, ...destination } = rule(remote.port)
  const service = network('reference', root, auth, [destination], {
    resolver: (async () => [{ address: '2001:4860:4860::8888', family: 6 }]) as never,
  })
  try {
    expect(error(await service.request(request(remote.port), auth.call()))).toBe(
      'incompatible/network_address_family_unsupported',
    )
    expect(remote.connections()).toBe(0)
  } finally {
    await service.close()
    await remote.close()
    cleanup(root)
  }
})

it('uses the configured CONNECT proxy with a pinned destination and refuses reference proxy capability', async () => {
  const remote = await peer()
  let tunnels = 0
  const destinations: string[] = []
  const proxy = createServer()
  const sockets = new Set<import('node:net').Socket>()
  proxy.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  proxy.on('connect', (input, socket, head) => {
    tunnels += 1
    destinations.push(input.url ?? '')
    const upstream = connect(remote.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    sockets.add(upstream)
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => sockets.delete(upstream))
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address()
  if (!address || typeof address === 'string') throw new Error('Proxy listener unavailable')
  const root = scratch()
  const auth = boundary()
  const rules = [rule(remote.port, { proxy: `http://127.0.0.1:${address.port}` })]
  const service = network('default', `${root}/default`, auth, rules, { resolver: loopback })
  const reference = network('reference', `${root}/reference`, auth, rules, { resolver: loopback })
  try {
    expect(error(await reference.request(request(remote.port), auth.call()))).toBe(
      'incompatible/network_proxy_unsupported',
    )
    expect(remote.connections()).toBe(0)
    expect(must(await service.request(request(remote.port), auth.call())).status).toBe(200)
    expect(tunnels).toBe(1)
    expect(destinations).toEqual([`127.0.0.1:${remote.port}`])
    expect(remote.requests()).toBe(1)
  } finally {
    await service.close()
    await reference.close()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
    await remote.close()
    cleanup(root)
  }
})
