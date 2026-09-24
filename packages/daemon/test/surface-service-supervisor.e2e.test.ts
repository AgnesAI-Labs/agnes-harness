import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canonicalJson,
  DEFAULT_COMPUTER_USE,
  hashInput,
  type ResolvedDeployment,
  type ResolvedProfile,
  resolveWorkspaceDirectory,
  sha256hex,
} from '@agnes/host'
import { createClient, createSurfaceRelay, memoryJournal } from '@agnes/sdk'
import { afterEach, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/config.js'
import { signSourceAuth, sourceAuthCanonical } from '../src/local/auth.js'
import { SessionWorkspaceIndex } from '../src/storage/lister.js'
import { SessionPrincipalOwnershipIndex } from '../src/storage/session-ownership.js'
import type { Tables } from '../src/storage/table.js'
import { WorkspaceBindingIndex, WorkspaceCatalog, WorkspaceIndex } from '../src/storage/workspaces.js'
import { daemonSocketPaths } from '../src/supervisor/socket-paths.js'
import { startSupervisor } from '../src/supervisor/supervisor.js'
import { createSurfaceRoutes, type SurfaceRelay } from '../src/surfaces/routes.js'
import { serviceOwner, servicePackageId, serviceRowId } from './service-row-fixture.js'
import { sqliteTables } from './sqlite-tables.js'

type Rpc = Readonly<{ id?: number; result?: unknown; error?: unknown }>
const cleanup: Array<() => void | Promise<void>> = []
function socketPaths(dir: string) {
  const paths = daemonSocketPaths({ dataDir: dir, ipc: process.platform === 'win32' ? 'pipe' : 'unix' })
  if (process.platform !== 'win32' && dirname(paths.socketPath) !== join(dir, 'daemon'))
    cleanup.push(() => rmSync(dirname(paths.socketPath), { recursive: true, force: true }))
  return paths
}

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function profile(dataDir: string): ResolvedProfile {
  const body = {
    name: 'local-dev',
    dataDir,
    cacheDir: join(dataDir, 'cache'),
    computerUse: DEFAULT_COMPUTER_USE,
  } as unknown as Omit<ResolvedProfile, 'hash'>
  return { ...body, hash: `sha256-${sha256hex(canonicalJson(hashInput(body)))}` }
}

function tls(): { cert: string; key: string } {
  return {
    cert: readFileSync(
      new URL('../../../tools/test-fixtures/tls/localhost-cert.pem', import.meta.url),
      'utf8',
    ),
    key: readFileSync(new URL('../../../tools/test-fixtures/tls/localhost-key.pem', import.meta.url), 'utf8'),
  }
}

const b64u = (value: string): string => Buffer.from(value).toString('base64url')

function portalToken(subject: string, expiresAt: number, secret: string): string {
  const payload = JSON.stringify({ sub: subject, exp: expiresAt })
  return `${b64u(payload)}.${createHmac('sha256', secret).update(payload).digest('hex')}`
}

async function surfaceClient(
  url: string,
  bearer: string,
): Promise<{ socket: WebSocket; call(method: string, params: unknown): Promise<Rpc> }> {
  const socket = new WebSocket(url, {
    rejectUnauthorized: false,
    headers: { authorization: `Bearer ${bearer}` },
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  let nextId = 1
  const pending = new Map<number, (reply: Rpc) => void>()
  socket.on('message', (data) => {
    const reply = JSON.parse(data.toString()) as Rpc
    if (reply.id !== undefined) pending.get(reply.id)?.(reply)
  })
  return {
    socket,
    call(method, params) {
      const id = nextId++
      return new Promise<Rpc>((resolve) => {
        pending.set(id, (reply) => {
          pending.delete(id)
          resolve(reply)
        })
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      })
    },
  }
}

async function seedPortalSession(input: {
  tables: Tables
  principalId: string
  workspace: string
  sessionId: string
  now: number
}): Promise<void> {
  const catalog = new WorkspaceCatalog(
    new WorkspaceIndex(input.tables.table('workspace_registry')),
    new SessionWorkspaceIndex(input.tables.table('session_workspaces')),
    resolveWorkspaceDirectory,
    () => input.now,
    new WorkspaceBindingIndex(input.tables.table('workspace_bindings')),
  )
  await catalog.add(input.workspace)
  await catalog.authorizeAndBind(input.sessionId, input.workspace)
  const ownership = new SessionPrincipalOwnershipIndex(input.tables.table('session_principal_ownership'))
  if (!ownership.bindNew(input.sessionId, input.principalId)) throw new Error('ownership bind failed')
  if (!ownership.activateNew(input.sessionId, input.principalId))
    throw new Error('ownership activation failed')
}

it('runs a Surface effect through startSupervisor WebSocket and acknowledges it only explicitly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-surface-service-supervisor-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const packageDirectory = join(dir, 'service-package')
  const marker = join(dir, 'effect-marker.jsonl')
  mkdirSync(packageDirectory, { recursive: true })
  const capability = {
    name: 'sales.create',
    kind: 'effect',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['region'],
      properties: { region: { type: 'string' } },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['region'],
      properties: { region: { type: 'string' } },
    },
    timeoutMs: 1_000,
    maxResultBytes: 1_024,
  }
  writeFileSync(
    join(dir, 'service-package', 'package.json'),
    JSON.stringify({
      name: servicePackageId,
      version: '1.0.0',
      type: 'module',
      exports: './index.mjs',
      agnes: { plugins: [{ id: serviceRowId, export: 'main', services: [capability.name] }] },
    }),
  )
  writeFileSync(
    join(dir, 'service-package', 'index.mjs'),
    `import { appendFileSync } from 'node:fs';
     export const main = { apply(ctx) { ctx.services.register({ ...${JSON.stringify(capability)},
       async handler(input, serviceCtx) {
         appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ region: input.region, actor: serviceCtx.actor.id }) + '\\n');
         return { region: input.region };
       }
     }); } };`,
  )

  const now = Date.parse('2026-09-13T08:00:00Z')
  const resolved = profile(dir)
  const profileFile = join(dir, 'profile.json')
  writeFileSync(profileFile, JSON.stringify(resolved))
  const config: DaemonConfig = {
    profileName: resolved.name,
    dataDir: dir,
    ...socketPaths(dir),
    ws: { addr: '127.0.0.1:0', ...tls() },
    limits: { ...DEFAULT_LIMITS, workerStartupMs: 10_000 },
  }
  const tables = sqliteTables(join(dir, 'daemon.sqlite'))
  await seedPortalSession({
    tables,
    principalId: 'portal:alice',
    workspace: dir,
    sessionId: 'portal-session',
    now,
  })
  await seedPortalSession({
    tables,
    principalId: 'portal:bob',
    workspace: dir,
    sessionId: 'bob-session',
    now,
  })
  const supervisor = await startSupervisor({
    config,
    profile: resolved,
    profileDir: join(dir, 'profiles', 'local-dev'),
    profileFile,
    clock: () => now,
    jobTables: tables,
    processIdentity: async (pid) =>
      pid === process.pid
        ? ({ state: 'alive', startId: 'surface-service-supervisor' } as const)
        : ({ state: 'dead' } as const),
    workerExecPath: process.execPath,
    workerExecArgv: ['--import', 'tsx'],
    workerEntry: fileURLToPath(new URL('./fake-service-worker-entry.ts', import.meta.url)),
    remoteAuth: {
      portalSecret: 'portal-secret',
      surfaceSources: () => [
        {
          sourceId: 'reports',
          keys: [{ secret: 'surface-secret', keyId: 'reports-key' }],
          grants: [{ extension: serviceOwner, name: 'sales.create', range: '^1.0.0' }],
        },
      ],
    },
  })
  const ws = supervisor.ws
  if (!ws) throw new Error('Surface service test requires WebSocket')
  const client = await surfaceClient(ws.url, ws.token)
  try {
    const clientId = 'reports-bff'
    const unsigned: Record<string, unknown> = {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      _meta: { 'ai.agnes.harness': { clientId } },
    }
    const nonce = '55555555555555555555555555555555'
    const auth = {
      kind: 'surface',
      sourceId: 'reports',
      source: {
        kind: 'source-auth',
        timestamp: now / 1_000,
        nonce,
        signature: signSourceAuth(
          'surface-secret',
          now / 1_000,
          nonce,
          sourceAuthCanonical(clientId, unsigned),
        ),
      },
      subject: {
        kind: 'portal-identity',
        token: portalToken('alice', now / 1_000 + 60, 'portal-secret'),
      },
    }
    const initialize = structuredClone(unsigned)
    const pocket = (initialize._meta as Record<string, Record<string, unknown>>)['ai.agnes.harness']
    if (!pocket) throw new Error('missing harness metadata')
    pocket.auth = auth
    await expect(client.call('initialize', initialize)).resolves.toMatchObject({
      result: { protocolVersion: 1 },
    })

    const effect = {
      sessionId: 'portal-session',
      extension: serviceOwner,
      service: 'sales.create',
      input: { region: 'west' },
      commandId: 'create-west',
    }
    await expect(
      client.call('_agnes/v1/extension.call', {
        ...effect,
        sessionId: 'bob-session',
        commandId: 'cross-subject',
      }),
    ).resolves.toMatchObject({
      error: { data: { code: 'CAPABILITY_DENIED' } },
    })
    expect(() => readFileSync(marker, 'utf8')).toThrow()
    expect(
      tables
        .table('command_journal')
        .get<{ count: number }>('SELECT COUNT(*) AS count FROM command_journal WHERE command_id = ?', [
          'cross-subject',
        ]),
    ).toEqual({ count: 0 })
    await expect(client.call('_agnes/v1/extension.call', effect)).resolves.toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { output: { region: 'west' } },
    })
    await expect(client.call('_agnes/v1/extension.call', effect)).resolves.toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { output: { region: 'west' } },
    })
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual([
      JSON.stringify({ region: 'west', actor: 'alice' }),
    ])

    const table = tables.table('command_journal')
    expect(
      table.get<{ acked_at: number | null }>('SELECT acked_at FROM command_journal WHERE command_id = ?', [
        'create-west',
      ]),
    ).toEqual({ acked_at: null })
    await expect(
      client.call('_agnes/v1/extension.ack', {
        extension: effect.extension,
        service: effect.service,
        commandId: effect.commandId,
      }),
    ).resolves.toEqual({ jsonrpc: '2.0', id: 5, result: {} })
    expect(
      table.get<{ acked_at: number | null }>('SELECT acked_at FROM command_journal WHERE command_id = ?', [
        'create-west',
      ]),
    ).toEqual({ acked_at: now })
  } finally {
    client.socket.close()
    await supervisor.close()
    await tables.close()
  }
}, 30_000)

it('runs a Portal request through Surface routes, the SDK relay and client, WSS, and a Service worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-surface-portal-vertical-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const packageDirectory = join(dir, 'service-package')
  const marker = join(dir, 'effect-marker.jsonl')
  mkdirSync(packageDirectory, { recursive: true })
  const capability = {
    name: 'sales.create',
    kind: 'effect',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['region'],
      properties: { region: { type: 'string' } },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['region'],
      properties: { region: { type: 'string' } },
    },
    timeoutMs: 1_000,
    maxResultBytes: 1_024,
  }
  writeFileSync(
    join(dir, 'service-package', 'package.json'),
    JSON.stringify({
      name: servicePackageId,
      version: '1.0.0',
      type: 'module',
      exports: './index.mjs',
      agnes: { plugins: [{ id: serviceRowId, export: 'main', services: [capability.name] }] },
    }),
  )
  writeFileSync(
    join(dir, 'service-package', 'index.mjs'),
    `import { appendFileSync } from 'node:fs';
     export const main = { apply(ctx) { ctx.services.register({ ...${JSON.stringify(capability)},
       async handler(input, serviceCtx) {
         appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ region: input.region, actor: serviceCtx.actor.id }) + '\\n');
         return { region: input.region };
       }
     }); } };`,
  )

  const resolved = profile(dir)
  const profileFile = join(dir, 'profile.json')
  writeFileSync(profileFile, JSON.stringify(resolved))
  const config: DaemonConfig = {
    profileName: resolved.name,
    dataDir: dir,
    ...socketPaths(dir),
    ws: { addr: '127.0.0.1:0', ...tls() },
    limits: { ...DEFAULT_LIMITS, workerStartupMs: 10_000 },
  }
  const tables = sqliteTables(join(dir, 'daemon.sqlite'))
  await seedPortalSession({
    tables,
    principalId: 'portal:alice',
    workspace: dir,
    sessionId: 'portal-session',
    now: Date.now(),
  })
  const supervisor = await startSupervisor({
    config,
    profile: resolved,
    profileDir: join(dir, 'profiles', 'local-dev'),
    profileFile,
    clock: Date.now,
    jobTables: tables,
    processIdentity: async (pid) =>
      pid === process.pid
        ? ({ state: 'alive', startId: 'surface-portal-vertical' } as const)
        : ({ state: 'dead' } as const),
    workerExecPath: process.execPath,
    workerExecArgv: ['--import', 'tsx'],
    workerEntry: fileURLToPath(new URL('./fake-service-worker-entry.ts', import.meta.url)),
    remoteAuth: {
      portalSecret: 'portal-secret',
      surfaceSources: () => [
        {
          sourceId: 'reports',
          keys: [{ secret: 'surface-secret', keyId: 'reports-key' }],
          grants: [{ extension: serviceOwner, name: 'sales.create', range: '^1.0.0' }],
        },
      ],
    },
  })
  const ws = supervisor.ws
  if (!ws) throw new Error('Surface Portal vertical test requires WebSocket')

  const deployment = {
    id: 'reports-portal',
    version: '1.0.0',
    inventoryHash: 'inventory',
    deploymentHash: 'deployment',
    policyHash: 'policy',
    hash: 'resolved',
    surfaces: [
      {
        package: 'reports-portal',
        version: '1.0.0',
        integrity: `sha256-${'a'.repeat(64)}`,
        descriptor: {
          id: 'portal',
          apiRange: '^1.0.0',
          artifact: { kind: 'node', entry: './server.js' },
          healthPath: '/healthz',
          requires: {
            services: [{ extension: serviceOwner, name: 'sales.create', range: '^1.0.0' }],
          },
        },
        instance: {
          package: 'reports-portal',
          surfaceId: 'portal',
          mount: '/sales',
          sourceId: 'reports',
          config: {},
          secrets: {},
          grants: [{ extension: serviceOwner, name: 'sales.create', range: '^1.0.0' }],
        },
        services: [
          {
            extension: serviceOwner,
            name: 'sales.create',
            version: '1.0.0',
            package: 'reports-service',
            integrity: `sha256-${'b'.repeat(64)}`,
          },
        ],
      },
    ],
  } as const satisfies ResolvedDeployment

  const token = portalToken('alice', Math.floor(Date.now() / 1_000) + 60, 'portal-secret')
  const routes = createSurfaceRoutes({
    deployment,
    resolveSubject: async () => ({
      sessionId: 'portal-session',
      subjectId: 'alice',
      credential: { kind: 'portal-identity', token },
    }),
    secretLease: { complete: true, values: [] },
    connectionFactory: async (binding): Promise<SurfaceRelay> => {
      const subject = binding.subjectCredential as { kind: 'portal-identity'; token: string }
      const client = createClient({
        transport: {
          kind: 'ws',
          url: ws.url,
          protocols: ['agnes-v1', `agnes-bearer.${ws.token}`],
          tls: { rejectUnauthorized: false },
        },
        auth: {
          kind: 'surface',
          sourceId: binding.sourceId,
          secret: 'surface-secret',
          subject,
        },
        clientId: `${binding.sourceId}-portal-bff`,
        journal: memoryJournal(`${binding.sourceId}-portal-bff`),
      })
      const handler = createSurfaceRelay(
        [
          {
            method: 'POST',
            path: '/api/create',
            extension: serviceOwner,
            service: 'sales.create',
            commandId: (request) => {
              const value = request.headers['x-request-id']
              return Array.isArray(value) ? value[0] : value
            },
            map: (body) => ({ region: typeof body.region === 'string' ? body.region : '' }),
          },
        ],
        { clientForRequest: () => ({ sessionId: binding.sessionId, extensions: client.extensions }) },
      )
      const server = createServer((request, response) => void handler(request, response))
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address() as AddressInfo
      let closed = false
      return {
        async request(request) {
          const response = await fetch(`http://127.0.0.1:${address.port}${request.path}`, {
            method: request.method,
            headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            signal: request.signal,
          })
          const text = await response.text()
          let body: unknown = text
          if (response.headers.get('content-type')?.startsWith('application/json')) body = JSON.parse(text)
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body,
          }
        },
        async close() {
          if (closed) return
          closed = true
          await client.close()
          server.closeAllConnections()
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          )
        },
      }
    },
  })

  try {
    const request = {
      method: 'POST',
      url: '/sales/api/create',
      headers: { 'content-type': 'application/json', 'x-request-id': 'portal-create-west' },
      body: { region: 'west', actor: { id: 'forged-browser-actor' } },
    }
    await expect(routes.handle(request)).resolves.toMatchObject({
      status: 200,
      body: JSON.stringify({ region: 'west' }),
    })
    await expect(routes.handle(request)).resolves.toMatchObject({
      status: 200,
      body: JSON.stringify({ region: 'west' }),
    })
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual([
      JSON.stringify({ region: 'west', actor: 'alice' }),
    ])
    expect(
      tables
        .table('command_journal')
        .get<{ acked_at: number | null }>('SELECT acked_at FROM command_journal WHERE command_id = ?', [
          'portal-create-west',
        ]),
    ).toEqual({ acked_at: expect.any(Number) })
  } finally {
    await routes.close()
    await supervisor.close()
    await tables.close()
  }
}, 30_000)
