import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import { join } from 'node:path'
import { createClient, memoryJournal } from '@agnes/sdk'
import { afterEach, expect, it } from 'vitest'
import { registerSurfaces, type SurfaceMountsSource } from '../src/local/methods/surfaces.js'
import { bindConnection } from '../src/supervisor/connection.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { createMountProxy, matchMount } from '../src/surfaces/mount-proxy.js'
import type { SurfaceControllerSnapshot } from '../src/surfaces/types.js'
import { openTestHost } from './host.js'
import { localSdkTransport, localSocketPath } from './local-socket-path.js'

/**
 * G1's cross-process-reachability proof (task-15): a real `agnesd`-shaped endpoint, listening on a
 * real Unix socket, answering `_agnes/v1/surfaces.mounts` to a real `@agnes/sdk` client connected
 * exactly the way `packages/cli/launch/surface-mounts.ts`'s `fetchSurfaceMountLookup` connects
 * (`auth: {kind:'local'}` over a Unix transport) -- as close to production's actual two-process
 * shape as a single test process can get without literally forking a second OS process. See
 * packages/daemon/src/local/methods/surfaces.ts and packages/cli/launch/surface-mounts.ts.
 *
 * `registerSurfaces` is registered directly on `createLocalEndpoint`'s real embedded endpoint (the
 * same endpoint construction `sdk-submit-integration.test.ts` already uses this way) rather than
 * through `startSupervisor`'s heavier demo-surface/package-manager fixture
 * (`surface-boot-e2e.test.ts`): that fixture is already the reviewed proof that a real Surface's
 * `{host,port}` flows into `SurfaceController.snapshot()`, so this test focuses on the one thing it
 * does not cover -- that the daemon answers that snapshot correctly to a client on the *other* side
 * of the RPC wire, and that the CLI-side lookup construction built from that answer actually routes
 * an HTTP request. `startSupervisor` is not re-invoked here so the two tests stay independent.
 */

let upstream: Server | undefined
afterEach(() => {
  upstream?.close()
})

async function listenHttp(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

function get(port: number, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += String(chunk)))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function boot(source: SurfaceMountsSource) {
  const h = await openTestHost()
  const ep = h.endpoint()
  registerSurfaces(ep, source)
  const socketPath = localSocketPath(join(h.dataDir, 'daemon', 'surfaces-mounts.sock'))
  const server = await listenUnix(socketPath, (socket) => {
    bindConnection(
      socket,
      { notifications: ep.notifications, close: () => ep.close(), handle: (m) => ep.handle(m) },
      { onClose() {} },
    )
  })
  const client = createClient({
    transport: localSdkTransport(socketPath),
    auth: { kind: 'local' },
    journal: memoryJournal(),
  })
  await client.initialize()
  return {
    client,
    async close() {
      await client.close()
      await server.close()
      await h.close()
    },
  }
}

it('answers the current healthy mount table to a real SDK client over a real Unix socket', async () => {
  const snapshot: SurfaceControllerSnapshot = {
    phase: 'running',
    instances: [
      {
        sourceId: 'customer',
        package: 'agnes/demo-surface',
        surfaceId: 'demo',
        mount: '/demo',
        state: 'healthy',
        endpoint: { host: '127.0.0.1', port: 51234, healthPath: '/health' },
      },
      // Crashed and starting instances must not be routed to -- createMountProxy would forward
      // traffic to a port nothing is listening on (crashed) or not yet serving (starting).
      {
        sourceId: 'customer',
        package: 'agnes/other-surface',
        surfaceId: 'other',
        mount: '/other',
        state: 'crashed',
        endpoint: { host: '127.0.0.1', port: 51235, healthPath: '/health' },
      },
      {
        sourceId: 'customer',
        package: 'agnes/starting-surface',
        surfaceId: 'starting',
        mount: '/starting',
        state: 'starting',
      },
    ],
  }
  const boot1 = await boot({ snapshot: () => snapshot })
  try {
    await expect(boot1.client.surfaces.mounts()).resolves.toEqual({
      mounts: [
        {
          package: 'agnes/demo-surface',
          surfaceId: 'demo',
          mount: '/demo',
          host: '127.0.0.1',
          port: 51234,
        },
      ],
    })
  } finally {
    await boot1.close()
  }
})

it('answers an empty table when no SurfaceController has started yet', async () => {
  const boot1 = await boot({ snapshot: () => undefined })
  try {
    await expect(boot1.client.surfaces.mounts()).resolves.toEqual({ mounts: [] })
  } finally {
    await boot1.close()
  }
})

it(
  'the RPC answer, turned into createMountProxy lookup() exactly as packages/cli/launch/' +
    'surface-mounts.ts does, actually routes a real HTTP request to the live Surface endpoint',
  async () => {
    upstream = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ path: req.url }))
    })
    const upstreamPort = await listenHttp(upstream)
    const snapshot: SurfaceControllerSnapshot = {
      phase: 'running',
      instances: [
        {
          sourceId: 'customer',
          package: 'agnes/demo-surface',
          surfaceId: 'demo',
          mount: '/demo',
          state: 'healthy',
          endpoint: { host: '127.0.0.1', port: upstreamPort, healthPath: '/health' },
        },
      ],
    }
    const boot1 = await boot({ snapshot: () => snapshot })
    try {
      // Same construction as fetchSurfaceMountLookup: fetch once, hand the RPC row -- {mount, host,
      // port}, exactly what createMountProxy's narrowed MountProxyMatch needs (M3, final review) --
      // straight to the shared matchMount() (I3, final review) rather than re-deriving the predicate.
      const { mounts } = await boot1.client.surfaces.mounts()
      const proxy = createMountProxy({ lookup: (pathname) => matchMount(mounts, pathname) })
      const front = createHttpServer((req, res) => {
        if (proxy(req, res)) return
        res.writeHead(404)
        res.end('static fallback')
      })
      const frontPort = await listenHttp(front)
      try {
        const res = await get(frontPort, '/demo/version')
        expect(res.status).toBe(200)
        expect(JSON.parse(res.body)).toEqual({ path: '/version' })
        expect((await get(frontPort, '/unmounted')).body).toBe('static fallback')
      } finally {
        front.close()
      }
    } finally {
      await boot1.close()
    }
  },
)
