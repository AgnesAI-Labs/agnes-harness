import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, DEFAULT_COMPUTER_USE, hashInput, type ResolvedProfile, sha256hex } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { createClient, memoryJournal, wsTransport } from '@agnes/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/config.js'
import { signSourceAuth, sourceAuthCanonical } from '../src/local/auth.js'
import { SessionPrincipalOwnershipIndex } from '../src/storage/session-ownership.js'
import { ensure } from '../src/storage/table.js'
import { encodeFrame, JsonlDecoder } from '../src/supervisor/framing.js'
import { DaemonMutationLockError } from '../src/supervisor/mutation-lock.js'
import { daemonSocketPaths } from '../src/supervisor/socket-paths.js'
import { startSupervisor } from '../src/supervisor/supervisor.js'
import { localSdkTransport } from './local-socket-path.js'
import { sqliteTables } from './sqlite-tables.js'

// A `WorkerPool.workerEntry` override that runs a real worker (`runWorker`, src/worker/main.ts) over
// a fixture Host built with `@agnes/host/testkit`'s `createTestHost` instead of a real package-loader
// assembly - see fake-worker-entry.ts's own header comment for why this is a separate spawned file
// rather than an env-var branch inside worker/main.ts itself.
const fakeWorkerEntry = fileURLToPath(new URL('./fake-worker-entry.ts', import.meta.url))
const workerSpawnOpts = {
  workerExecPath: process.execPath,
  workerEntry: fakeWorkerEntry,
  workerExecArgv: ['--import', 'tsx'],
}
const processIdentity = async (pid: number) =>
  pid === process.pid
    ? ({ state: 'alive', startId: 'supervisor-e2e' } as const)
    : ({ state: 'dead' } as const)
const SOURCE_AUTH_KEY = ['source', 'auth', 'fixture', 'key'].join('-')

type Rpc = { id?: number; method?: string; result?: unknown; error?: unknown }

async function client(path: string): Promise<{
  socket: ReturnType<typeof connect>
  call: (id: number, method: string, params: unknown) => Promise<Rpc>
  /** Every frame received, responses and notifications alike, in arrival order. */
  seen: Rpc[]
}> {
  const socket = connect(path)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  const dec = new JsonlDecoder()
  const inbox: Rpc[] = []
  const seen: Rpc[] = []
  const waiters: Array<(m: Rpc) => void> = []
  socket.on('data', (chunk: Buffer) => {
    for (const m of dec.feed(chunk) as Rpc[]) {
      seen.push(m)
      const w = waiters.shift()
      if (w) w(m)
      else inbox.push(m)
    }
  })
  const next = (): Promise<Rpc> =>
    inbox.length ? Promise.resolve(inbox.shift() as Rpc) : new Promise((resolve) => waiters.push(resolve))
  const call = async (id: number, method: string, params: unknown): Promise<Rpc> => {
    socket.write(encodeFrame({ jsonrpc: '2.0', id, method, params }))
    for (;;) {
      const m = await next()
      if (m.id === id) return m
    }
  }
  return { socket, call, seen }
}

// Minimal but real ResolvedProfile: only the fields this task's code path actually reads
// (WorkerPool's hash check, session/new's preset gate, the supervisor host facade's
// validatePresetSwitch) need to be genuine - everything else is asserted away, matching this
// package's own worker-pool.e2e.test.ts precedent (`profile: { name: 'p', hash: 'h1' } as never`).
function buildProfile(dataDir: string): ResolvedProfile {
  const body = {
    name: 'local-dev',
    dataDir,
    seams: { principals: '@agnes/base' },
    computerUse: DEFAULT_COMPUTER_USE,
    presets: { default: 'standard', allowed: ['standard'] },
    provider: {
      routes: [
        {
          route: 'faux',
          api: 'faux',
          baseUrl: 'https://invalid.test',
          models: [{ route: 'faux', id: 'faux-1' }],
        },
      ],
    },
  } as unknown as Omit<ResolvedProfile, 'hash'>
  return { ...body, hash: `sha256-${sha256hex(canonicalJson(hashInput(body)))}` }
}

const socketDirectories = new Set<string>()
afterEach(() => {
  for (const directory of socketDirectories) rmSync(directory, { recursive: true, force: true })
  socketDirectories.clear()
})
function buildConfigFor(dir: string): DaemonConfig {
  const paths = daemonSocketPaths({ dataDir: dir, ipc: process.platform === 'win32' ? 'pipe' : 'unix' })
  if (process.platform !== 'win32' && dirname(paths.socketPath) !== join(dir, 'daemon'))
    socketDirectories.add(dirname(paths.socketPath))
  return {
    profileName: 'local-dev',
    dataDir: dir,
    ...paths,
    limits: { ...DEFAULT_LIMITS, workerStartupMs: 20_000, jobsTickMs: 60_000 },
  }
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

async function wsInitialize(url: string, token: string): Promise<Rpc> {
  const socket = new WebSocket(url, {
    rejectUnauthorized: false,
    headers: { Authorization: `Bearer ${token}` },
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const response = new Promise<Rpc>((resolve) =>
    socket.once('message', (data) => resolve(JSON.parse(data.toString()))),
  )
  socket.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      },
    }),
  )
  const result = await response
  socket.close()
  return result
}

async function wsInitializeWithSourceAuth(
  url: string,
  token: string,
  o: { clientId: string; nonce: string; secret: string; timestamp: number },
): Promise<Rpc> {
  const socket = new WebSocket(url, {
    rejectUnauthorized: false,
    headers: { authorization: `Bearer ${token}` },
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const params: Record<string, unknown> = {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    _meta: { 'ai.agnes.harness': { clientId: o.clientId } },
  }
  const canonical = sourceAuthCanonical(o.clientId, params)
  const pocket = (params._meta as Record<string, Record<string, unknown>>)['ai.agnes.harness']
  if (!pocket) throw new Error('missing harness metadata')
  pocket.auth = {
    kind: 'source-auth',
    timestamp: o.timestamp,
    nonce: o.nonce,
    signature: signSourceAuth(o.secret, o.timestamp, o.nonce, canonical),
  }
  const response = new Promise<Rpc>((resolve) =>
    socket.once('message', (data) => resolve(JSON.parse(data.toString()))),
  )
  socket.send(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'initialize', params }))
  const result = await response
  socket.close()
  return result
}

async function wsSourceAuthCall(
  url: string,
  token: string,
  o: { clientId: string; nonce: string; secret: string; timestamp: number },
  request: Readonly<{ id: number; method: string; params: unknown }>,
): Promise<Rpc> {
  const socket = new WebSocket(url, {
    rejectUnauthorized: false,
    headers: { authorization: `Bearer ${token}` },
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const receive = (): Promise<Rpc> =>
    new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(data.toString()))))
  const params: Record<string, unknown> = {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    _meta: { 'ai.agnes.harness': { clientId: o.clientId } },
  }
  const pocket = (params._meta as Record<string, Record<string, unknown>>)['ai.agnes.harness']
  if (!pocket) throw new Error('missing harness metadata')
  pocket.auth = {
    kind: 'source-auth',
    timestamp: o.timestamp,
    nonce: o.nonce,
    signature: signSourceAuth(o.secret, o.timestamp, o.nonce, sourceAuthCanonical(o.clientId, params)),
  }
  const initialized = receive()
  socket.send(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'initialize', params }))
  const init = await initialized
  if (init.error) throw new Error('source-auth initialize failed')
  const response = receive()
  socket.send(JSON.stringify({ jsonrpc: '2.0', ...request }))
  const result = await response
  socket.close()
  return result
}

describe('agnesd supervisor: real end-to-end', () => {
  it.runIf(process.platform === 'win32')(
    'starts after a transient reader releases the existing profile snapshot',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agnes-profile-reader-'))
      const profile = buildProfile(dir)
      const profileFile = join(dir, 'profile.json')
      writeFileSync(profileFile, '{}')
      let reader: number | undefined = openSync(profileFile, 'r')
      const release = () => {
        if (reader !== undefined) closeSync(reader)
        reader = undefined
      }
      const timer = setTimeout(release, 300)
      const tables = sqliteTables(join(dir, 'daemon.sqlite'))
      let supervisor: Awaited<ReturnType<typeof startSupervisor>> | undefined
      try {
        supervisor = await startSupervisor({
          config: buildConfigFor(dir),
          profile,
          profileDir: join(dir, 'profiles', 'local-dev'),
          profileFile,
          workspaceRoot: dir,
          jobTables: tables,
          processIdentity,
          ...workerSpawnOpts,
        })
        expect(reader).toBeUndefined()
        expect(JSON.parse(readFileSync(profileFile, 'utf8')).hash).toBe(profile.hash)
      } finally {
        clearTimeout(timer)
        release()
        await supervisor?.close()
        await tables.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
  // One restart carries every piece of durable supervisor state these checks need: submit receipts,
  // auth claims, session metadata and source-auth nonces, all under a long Unicode data directory.
  it('keeps submit receipts, claims, session metadata and source-auth nonces across a restart under a long Unicode data directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), `agnes-${'中文长目录'.repeat(10)}-`))
    const profile = buildProfile(dir)
    const profileFile = join(dir, 'profile.json')
    const config = { ...buildConfigFor(dir), ws: { addr: '127.0.0.1:0', ...tls() } }
    const database = join(dir, 'daemon.sqlite')
    const secret = SOURCE_AUTH_KEY
    const auth = {
      clientId: 'channel-adapter',
      nonce: '0123456789abcdef0123456789abcdef',
      secret,
      timestamp: Math.floor(Date.now() / 1000),
    }
    const start = (jobTables: ReturnType<typeof sqliteTables>) =>
      startSupervisor({
        config,
        profile,
        profileDir: join(dir, 'profiles', 'local-dev'),
        profileFile,
        workspaceRoot: dir,
        jobTables,
        remoteAuth: {
          sourceAuthCredentials: [{ credentialId: 'secret://test/source-auth-restart', secret }],
        },
        processIdentity,
        ...workerSpawnOpts,
      })
    writeFileSync(profileFile, JSON.stringify(profile))
    let sessionId = ''
    let firstSeq = 0
    try {
      const tables = sqliteTables(database)
      const supervisor = await start(tables)
      const rpc = await client(supervisor.socketPath)
      try {
        await rpc.call(1, 'initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          _meta: { 'ai.agnes.harness': { clientId: 'restart-client' } },
        })
        expect(
          await rpc.call(10, '_agnes/v1/auth.claim', { kind: 'restart-once', value: 'same-event' }),
        ).toMatchObject({ result: { granted: true } })
        expect(
          await rpc.call(11, '_agnes/v1/auth.claim', {
            kind: 'restart-rate',
            value: 'same-target',
            limit: 2,
            windowMs: 60_000,
          }),
        ).toMatchObject({ result: { granted: true, slot: 1 } })
        const made = await rpc.call(2, 'session/new', { cwd: dir, mcpServers: [] })
        sessionId = (made.result as { sessionId: string }).sessionId
        const sent = await rpc.call(3, '_agnes/v1/submit', {
          clientId: 'restart-client',
          commandId: 'restart-command',
          kind: 'followUp',
          payload: { sessionId, content: [{ type: 'text', text: 'once' }] },
        })
        expect(sent).toMatchObject({ result: { seq: expect.any(Number), replayed: false } })
        firstSeq = (sent.result as { seq: number }).seq
        expect(
          await rpc.call(20, '_agnes/v1/session.rename', { sessionId, title: '持久化名称' }),
        ).toMatchObject({ result: { title: '持久化名称' } })
        expect(await rpc.call(21, '_agnes/v1/session.archive', { sessionId, archived: true })).toMatchObject({
          result: { archived: true },
        })

        const firstWs = supervisor.ws
        if (!firstWs) throw new Error('source-auth test requires ws')
        // The random lifecycle bearer admits the HTTP upgrade only. Once source-auth is configured,
        // presenting that bearer without an initialize credential must still fail closed.
        expect(await wsInitialize(firstWs.url, firstWs.token)).toMatchObject({
          error: { data: { reason: 'local auth not accepted on ws' } },
        })
        expect(await wsInitializeWithSourceAuth(firstWs.url, firstWs.token, auth)).toMatchObject({
          result: { protocolVersion: 1 },
        })
        expect(
          await wsSourceAuthCall(
            firstWs.url,
            firstWs.token,
            { ...auth, nonce: 'fedcba9876543210fedcba9876543210' },
            {
              id: 100,
              method: 'session/new',
              params: {
                cwd: dir,
                mcpServers: [],
                _meta: { 'ai.agnes.harness': { sessionKey: 'agnes:test:remote-explicit' } },
              },
            },
          ),
        ).toMatchObject({
          error: {
            data: {
              code: 'CAPABILITY_DENIED',
              reason: 'remote session actor authority unavailable',
            },
          },
        })
      } finally {
        rpc.socket.end()
        await supervisor.close()
        await tables.close()
      }

      const reopened = sqliteTables(database)
      const restarted = await start(reopened)
      const retry = await client(restarted.socketPath)
      try {
        await retry.call(1, 'initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          _meta: { 'ai.agnes.harness': { clientId: 'restart-client' } },
        })
        expect(await retry.call(20, '_agnes/v1/session.list', {})).toMatchObject({
          result: {
            items: [
              expect.objectContaining({
                sessionId,
                title: '持久化名称',
                titleSource: 'user',
                archived: true,
              }),
            ],
          },
        })
        expect(
          await retry.call(21, '_agnes/v1/session.archive', { sessionId, archived: false }),
        ).toMatchObject({ result: { archived: false, title: '持久化名称' } })
        expect(
          await retry.call(10, '_agnes/v1/auth.claim', { kind: 'restart-once', value: 'same-event' }),
        ).toMatchObject({ result: { granted: false } })
        expect(
          await retry.call(11, '_agnes/v1/auth.claim', {
            kind: 'restart-rate',
            value: 'same-target',
            limit: 2,
            windowMs: 60_000,
          }),
        ).toMatchObject({ result: { granted: true, slot: 2 } })
        expect(
          await retry.call(2, '_agnes/v1/submit', {
            clientId: 'restart-client',
            commandId: 'restart-command',
            kind: 'followUp',
            payload: { sessionId, content: [{ type: 'text', text: 'once' }] },
          }),
        ).toMatchObject({ result: { seq: firstSeq, replayed: true } })
        expect(
          await retry.call(3, '_agnes/v1/submit', {
            clientId: 'restart-client',
            commandId: 'restart-command',
            kind: 'followUp',
            payload: { sessionId, content: [{ type: 'text', text: 'changed' }] },
          }),
        ).toMatchObject({ error: { data: { code: 'ID_CONFLICT' } } })

        const restartedWs = restarted.ws
        if (!restartedWs) throw new Error('source-auth restart test requires ws')
        expect(await wsInitializeWithSourceAuth(restartedWs.url, restartedWs.token, auth)).toMatchObject({
          error: { data: { reason: 'nonce' } },
        })
      } finally {
        retry.socket.end()
        await restarted.close()
        await reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('serves initialize -> session/new -> session/prompt through a real worker subprocess, and refuses a second instance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-sup-'))
    try {
      const profile = buildProfile(dir)
      const profileFile = join(dir, 'profile.json')
      writeFileSync(profileFile, JSON.stringify(profile))
      const config = { ...buildConfigFor(dir), ws: { addr: '127.0.0.1:0', ...tls() } }
      const artifactSessionId = 'agnes:local:default:daemon:dm:artifact-status-e2e'
      const seededHost = await createTestHost({ dataDir: dir, script: [] })
      const seededSession = await seededHost.host.createSession({ key: artifactSessionId, cwd: dir })
      await seededSession.append([
        seededSession.ev(
          'artifact/job',
          { jobId: 'artifact-e2e', status: 'queued' },
          { register: 'artifact/job' },
        ),
      ])
      await seededSession.close()
      await seededHost.host.close()
      const tables = sqliteTables(join(dir, 'daemon.sqlite'))
      const ownership = new SessionPrincipalOwnershipIndex(tables.table('session_principal_ownership'))
      expect(ownership.bindNew(artifactSessionId, 'local')).toBe(true)
      expect(ownership.activateNew(artifactSessionId, 'local')).toBe(true)
      ensure(
        tables.table('writer_claims'),
        'CREATE TABLE IF NOT EXISTS writer_claims (session_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, until INTEGER NOT NULL, generation INTEGER NOT NULL)',
      )
      ensure(
        tables.table('registers'),
        'CREATE TABLE IF NOT EXISTS registers (session_key TEXT, register TEXT, key TEXT, seq INTEGER, data TEXT, PRIMARY KEY (session_key, register, key))',
      )

      const sup = await startSupervisor({
        config,
        profile,
        profileDir: join(dir, 'profiles', 'local-dev'),
        profileFile,
        workspaceRoot: dir,
        tables,
        remoteAuth: {
          sourceAuthCredentials: [{ credentialId: 'secret://test/supervisor-e2e', secret: SOURCE_AUTH_KEY }],
        },
        processIdentity,
        ...workerSpawnOpts,
      })
      try {
        expect(sup.ws).toBeDefined()
        await expect(sup.reclaimNow()).resolves.toEqual([])
        expect(await wsInitialize(sup.ws?.url as string, sup.ws?.token as string)).toMatchObject({
          error: { data: { reason: 'local auth not accepted on ws' } },
        })
        expect(
          await wsInitializeWithSourceAuth(sup.ws?.url as string, sup.ws?.token as string, {
            clientId: 'supervisor-e2e',
            nonce: 'abcdef0123456789abcdef0123456789',
            secret: SOURCE_AUTH_KEY,
            timestamp: Math.floor(Date.now() / 1000),
          }),
        ).toMatchObject({
          result: { protocolVersion: 1 },
        })
        // Negative case first, while the first supervisor is still holding the lock: a second
        // agnesd against the same dataDir must be refused, not queued or silently ignored.
        //
        // The real rejection here is `DaemonMutationLockError` (mutation-lock.ts), not
        // `OwnerLockError` (owner-lock.ts) - `acquireOwnerLock` calls
        // `acquireDaemonMutationLock(dataDir)` *outside* its own try/catch, so while the first
        // supervisor is alive and still holding that SQLite `BEGIN EXCLUSIVE` transaction, the
        // second attempt's mutation-lock acquisition itself throws before `acquireOwnerLock` ever
        // reaches its own owner.json / processStartId staleness logic - and that raw
        // `DaemonMutationLockError` propagates unconverted. `OwnerLockError` is reserved for a
        // different case: a *stale* owner.json (the file's own PID is dead, or ambiguous) left
        // behind by a crashed process, where the SQLite lock is free to reacquire but the recorded
        // owner cannot be safely superseded. Confirmed by actually running this assertion against
        // the plan's originally-assumed `{ name: 'AlreadyRunning' }`/`OwnerLockError` shape first
        // and reading the real failure (see this task's report for the exact before/after output).
        await expect(
          startSupervisor({
            config,
            profile,
            profileDir: join(dir, 'profiles', 'local-dev'),
            profileFile,
            workspaceRoot: dir,
            tables,
            processIdentity,
            ...workerSpawnOpts,
          }),
        ).rejects.toBeInstanceOf(DaemonMutationLockError)

        const c = await client(sup.socketPath)
        try {
          const init = await c.call(1, 'initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          })
          expect(init.error).toBeUndefined()
          expect((init.result as { protocolVersion: number }).protocolVersion).toBe(1)

          expect(
            await c.call(29, 'session/new', {
              cwd: dir,
              mcpServers: [],
              _meta: { 'ai.agnes.harness': { sessionKey: artifactSessionId } },
            }),
          ).toMatchObject({ result: { sessionId: artifactSessionId } })
          expect(
            await c.call(30, 'session/load', {
              sessionId: artifactSessionId,
              cwd: dir,
              mcpServers: [],
            }),
          ).toMatchObject({ result: {} })
          expect(await c.call(31, '_agnes/v1/artifact.job.status', { jobId: 'artifact-e2e' })).toMatchObject({
            result: { jobId: 'artifact-e2e', status: 'queued' },
          })

          const made = await c.call(2, 'session/new', { cwd: dir, mcpServers: [] })
          expect(made.error).toBeUndefined()
          const sessionId = (made.result as { sessionId: string }).sessionId
          expect(typeof sessionId).toBe('string')

          expect(
            await c.call(4, '_agnes/v1/session.setModel', {
              sessionId,
              slot: 'primary',
              route: 'faux',
              model: 'faux-1',
            }),
          ).toMatchObject({ result: { effectiveFromSeq: expect.any(Number) } })

          const participantCredential = {
            kind: 'channel',
            channel: 'dingtalk',
            accountId: 'account-e2e',
            userId: 'participant-e2e',
            chatId: 'chat-e2e',
            chatType: 'group',
          }
          expect(
            await c.call(40, '_agnes/v1/participant.join', {
              sessionId,
              credential: participantCredential,
            }),
          ).toMatchObject({ result: { seq: expect.any(Number) } })
          expect(await c.call(41, '_agnes/v1/participant.list', { sessionId })).toMatchObject({
            result: { participants: [{ actor: { id: 'participant-e2e' }, surface: 'dingtalk' }] },
          })
          expect(
            await c.call(42, '_agnes/v1/participant.leave', {
              sessionId,
              credential: participantCredential,
            }),
          ).toMatchObject({ result: { seq: expect.any(Number) } })

          // UI responses use the same handler against a RemoteSession in production. A second
          // connection legitimately starts its own requestSeq counter at 1, so its response must
          // not collide with this connection's idempotency key.
          const uiParams = { sessionId, requestSeq: 1, action: 'accept', data: { choice: 'safe' } }
          const firstUi = await c.call(20, '_agnes/v1/ext.ui.response', uiParams)
          expect(firstUi).toMatchObject({ result: { seq: expect.any(Number) } })
          expect(await c.call(21, '_agnes/v1/ext.ui.response', uiParams)).toMatchObject({
            result: { seq: (firstUi.result as { seq: number }).seq },
          })

          const c2 = await client(sup.socketPath)
          try {
            expect(
              await c2.call(1, 'initialize', {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
              }),
            ).toMatchObject({ result: { protocolVersion: 1 } })
            const otherUi = await c2.call(2, '_agnes/v1/ext.ui.response', {
              ...uiParams,
              action: 'decline',
            })
            expect(otherUi).toMatchObject({ result: { seq: expect.any(Number) } })
            expect((otherUi.result as { seq: number }).seq).not.toBe((firstUi.result as { seq: number }).seq)

            const [queuedA, queuedB] = await Promise.all([
              c.call(50, '_agnes/v1/session.followUp', {
                sessionId,
                content: [{ type: 'text', text: 'from client one' }],
                commandId: 'dual-client-a',
                generation: 1,
              }),
              c2.call(50, '_agnes/v1/session.followUp', {
                sessionId,
                content: [{ type: 'text', text: 'from client two' }],
                commandId: 'dual-client-b',
                generation: 1,
              }),
            ])
            expect(queuedA).toMatchObject({ result: { seq: expect.any(Number) } })
            expect(queuedB).toMatchObject({ result: { seq: expect.any(Number) } })
            expect((queuedA.result as { seq: number }).seq).not.toBe((queuedB.result as { seq: number }).seq)
          } finally {
            c2.socket.end()
          }

          const enqueued = await c.call(3, '_agnes/v1/jobs.enqueue', {
            idempotencyKey: 'supervisor-e2e-job',
            sessionKey: sessionId,
            payload: { prompt: 'later' },
            schedule: { kind: 'at', at: Date.now() + 60_000 },
          })
          expect(enqueued).toMatchObject({ result: { jobId: 'supervisor-e2e-job' } })
          const polled = await c.call(4, '_agnes/v1/jobs.poll', { jobId: 'supervisor-e2e-job' })
          expect(polled).toMatchObject({ result: { status: 'waiting', attempts: 0 } })
          expect(await c.call(5, '_agnes/v1/jobs.cancel', { jobId: 'supervisor-e2e-job' })).toMatchObject({
            result: {},
          })

          const res = await c.call(6, 'session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: 'hi' }],
          })
          expect(res.error).toBeUndefined()
          expect((res.result as { stopReason: string }).stopReason).toBe('end_turn')
        } finally {
          c.socket.end()
        }
      } finally {
        await sup.close()
        await expect(sup.reclaimNow()).resolves.toEqual([])
        await tables.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

it('restores one attached SDK session after its worker is replaced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-idle-restore-e2e-'))
  const profile = buildProfile(dir)
  const profileFile = join(dir, 'profile.json')
  writeFileSync(profileFile, JSON.stringify(profile))
  const config = buildConfigFor(dir)
  const tables = sqliteTables(join(dir, 'daemon.sqlite'))
  const sup = await startSupervisor({
    config,
    profile,
    profileDir: join(dir, 'profiles', 'local-dev'),
    profileFile,
    workspaceRoot: dir,
    jobTables: tables,
    processIdentity,
    ...workerSpawnOpts,
  })
  const sdk = createClient({
    journal: memoryJournal(),
    transport: localSdkTransport(sup.socketPath),
  })
  try {
    const session = await sdk.session.new({ cwd: dir })
    await session.attach({ filter: { preview: true } })
    const seen: Array<{ seq: number; type: string }> = []
    let turnEnds = 0
    let firstEnded!: () => void
    let secondEnded!: () => void
    const firstEnd = new Promise<void>((resolve) => {
      firstEnded = resolve
    })
    const secondEnd = new Promise<void>((resolve) => {
      secondEnded = resolve
    })
    const collect = (async () => {
      for await (const event of session.events({ preview: true })) {
        seen.push({ seq: event.seq, type: event.type })
        if (event.type !== 'turn/end') continue
        turnEnds++
        if (turnEnds === 1) firstEnded()
        if (turnEnds === 2) {
          secondEnded()
          break
        }
      }
    })()

    await expect(session.prompt('before idle')).resolves.toMatchObject({ reason: 'completed' })
    await firstEnd
    const firstTimeline = await session.projectUI()
    const firstMax = Math.max(...seen.map((event) => event.seq))
    const firstCount = seen.length

    // '@shared' is kept up from daemon start (P1) and is exempt from idle eviction, so the
    // worker replacement this test exercises is forced directly rather than through evictIdleNow.
    expect(sup.retireSharedWorkerNow()).toBe(true)
    // No settling sleep: this prompt lands on the exact retirement boundary. WorkerLink.close()
    // must synchronously remove the old registry entry so SDK receives the recoverable not-found,
    // not an opaque command failure against a half-closed socket.
    await expect(session.prompt('after idle')).resolves.toMatchObject({ reason: 'completed' })
    await secondEnd
    await collect

    expect(turnEnds).toBe(2)
    expect(new Set(seen.map((event) => event.seq)).size).toBe(seen.length)
    expect(seen.slice(firstCount).every((event) => event.seq > firstMax)).toBe(true)
    const incremental = await session.projectUIPatch(firstTimeline.upto)
    expect(incremental.kind).toBe('patch')
    if (incremental.kind !== 'patch') throw new Error('expected worker-backed projection patch')
    expect(incremental.patch.from).toBe(firstTimeline.upto)
    expect(incremental.patch.upto).toBeGreaterThan(firstTimeline.upto)
    expect(incremental.patch.changes.length).toBeGreaterThan(0)
    const timeline = await session.projectUI()
    const rendered = JSON.stringify(timeline.nodes)
    expect(rendered.match(/before idle/g)).toHaveLength(1)
    expect(rendered.match(/after idle/g)).toHaveLength(1)
  } finally {
    await sdk.close()
    await sup.close()
    await tables.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

// One supervisor with both a unix and a local-Web ws listener serves every check here: Computer Use
// status without a trusted package source, surfaces.mounts registered on unix only, a worker-backed
// session over the local Web bearer and exact origin, and the activation barrier on RPC admission.
//
// surfaces.mounts used to be registered on every transport, including ws, even though its only
// production consumer (`packages/cli/launch/surface-mounts.ts`'s `fetchSurfaceMountLookup`) always
// connects over unix, like its siblings `registerPackageAdmin`/`registerResourceControl` restrict
// themselves off ws. Over ws it must be genuinely unregistered, not merely unauthorized.
it('serves Computer Use status, unix-only mounts, a local Web session and the activation barrier', async () => {
  // Short prefix deliberately: on macOS the Unix domain socket path (this dir + '/daemon/agnesd.sock')
  // must stay under sun_path's ~104-byte limit alongside an already-long `tmpdir()`.
  const dir = mkdtempSync(join(tmpdir(), 'agnes-local-web-'))
  const profile = buildProfile(dir)
  const profileFile = join(dir, 'profile.json')
  writeFileSync(profileFile, JSON.stringify(profile))
  const tables = sqliteTables()
  const config = {
    ...buildConfigFor(dir),
    localWeb: { addr: '127.0.0.1:0', origin: 'http://127.0.0.1:4177' },
  }
  const sup = await startSupervisor({
    config,
    profile,
    profileDir: join(dir, 'profiles', 'local-dev'),
    profileFile,
    workspaceRoot: dir,
    jobTables: tables,
    processIdentity,
    ...workerSpawnOpts,
  })
  if (!sup.ws) throw new Error('missing Web listener')
  const rpc = await client(sup.socketPath)
  const unixClient = createClient({ journal: memoryJournal(), transport: localSdkTransport(sup.socketPath) })
  const wsClient = createClient({
    journal: memoryJournal(),
    auth: { kind: 'local' },
    transportFactories: {
      ws: (option) =>
        wsTransport({ ...option, url: sup.ws?.url ?? '', headers: { Origin: config.localWeb.origin } }),
    },
    transport: {
      kind: 'ws',
      url: sup.ws.url,
      protocols: ['agnes-v1', `agnes-bearer.${sup.ws.token}`],
    },
  })
  try {
    // No trusted source is configured, so locked-package mutation readiness stays unknown.
    await rpc.call(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      _meta: { 'ai.agnes.harness': { clientId: 'mutation-status-unknown' } },
    })
    const status = await rpc.call(2, '_agnes/v1/computerUse.status', {})
    expect(status).toMatchObject({ result: { status: 'blocked' } })
    expect(status).not.toHaveProperty('result.lockedPackageMutations')

    await unixClient.initialize()
    await expect(unixClient.surfaces.mounts()).resolves.toEqual({ mounts: [] })

    await wsClient.initialize()
    await expect(wsClient.surfaces.mounts()).rejects.toMatchObject({
      rpc: { message: 'METHOD_NOT_FOUND', data: { code: 'NOT_REGISTERED' } },
    })

    const session = await wsClient.session.new({ cwd: dir })
    expect(session.id).toBeTruthy()
    const result = await session.prompt('hello')
    expect(result).toMatchObject({ stopReason: 'end_turn', reason: 'completed' })
    expect((await wsClient.session.list({ limit: 10 })).items.map((x) => x.sessionId)).toContain(session.id)

    // The Web session holds this workspace's default key, so the barrier session names its own.
    const made = await rpc.call(3, 'session/new', {
      cwd: dir,
      mcpServers: [],
      _meta: { 'ai.agnes.harness': { sessionKey: 'agnes:local:default:daemon:dm:activation-barrier' } },
    })
    const sessionId = (made.result as { sessionId: string }).sessionId
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const activation = sup.activationBarrier.quiesce('supervisor-activation', () => held)
    const refused = await rpc.call(4, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'must not cross cutover' }],
    })
    expect(refused).toMatchObject({
      error: {
        code: -32001,
        data: { reason: 'activation-in-progress', operationId: 'supervisor-activation' },
      },
    })
    release()
    await activation
  } finally {
    rpc.socket.end()
    await unixClient.close()
    await wsClient.close()
    await sup.close()
    await tables.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

describe('agnesd supervisor: ACP subscriptions follow the connection', () => {
  async function supervisorFor(dir: string, audit?: (record: unknown) => void) {
    const profile = buildProfile(dir)
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify(profile))
    const tables = sqliteTables(join(dir, 'daemon.sqlite'))
    const sup = await startSupervisor({
      config: buildConfigFor(dir),
      profile,
      profileDir: join(dir, 'profiles', 'local-dev'),
      profileFile,
      workspaceRoot: dir,
      jobTables: tables,
      processIdentity,
      ...(audit ? { audit } : {}),
      ...workerSpawnOpts,
    })
    return { sup, tables }
  }
  const initialize = {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  }
  type Update = {
    method?: string
    params?: { sessionId?: string; _meta?: Record<string, { eventSequence: number }> }
  }

  it('streams the answer through a worker as previews without auditing or logging its text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-preview-sentinel-'))
    const sentinel = `sentinel-${Math.random().toString(36).slice(2)}`
    process.env.AGNES_FAKE_WORKER_TEXT = sentinel
    const audited: unknown[] = []
    const { sup, tables } = await supervisorFor(dir, (record) => audited.push(record)).finally(() => {
      delete process.env.AGNES_FAKE_WORKER_TEXT
    })
    const c = await client(sup.socketPath)
    try {
      expect((await c.call(1, 'initialize', initialize)).error).toBeUndefined()
      const made = await c.call(2, 'session/new', { cwd: dir, mcpServers: [] })
      const sessionId = (made.result as { sessionId: string }).sessionId
      expect(
        (await c.call(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] })).error,
      ).toBeUndefined()
      const said = (c.seen as Update[])
        .filter((m) => m.method === 'session/update' && m.params?.sessionId === sessionId)
        .map(
          (m) => m.params as unknown as { update?: { sessionUpdate?: string; content?: { text?: string } } },
        )
        .filter((p) => p.update?.sessionUpdate === 'agent_message_chunk')
        .map((p) => p.update?.content?.text ?? '')
        .join('')
      expect(said).toBe(sentinel)
      // Worker log frames reach the daemon audit as worker.log; whatever was audited on this turn,
      // none of it carries the streamed text.
      expect(JSON.stringify(audited)).not.toContain(sentinel)
    } finally {
      c.socket.destroy()
      await sup.close()
      await tables.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('pushes each event once to a connection that loads and prompts the same session repeatedly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-feed-once-'))
    process.env.AGNES_FAKE_WORKER_TURNS = '5'
    const { sup, tables } = await supervisorFor(dir).finally(() => {
      delete process.env.AGNES_FAKE_WORKER_TURNS
    })
    const c = await client(sup.socketPath)
    try {
      expect((await c.call(1, 'initialize', initialize)).error).toBeUndefined()
      const made = await c.call(2, 'session/new', { cwd: dir, mcpServers: [] })
      const sessionId = (made.result as { sessionId: string }).sessionId
      for (const id of [3, 4])
        expect(await c.call(id, 'session/load', { sessionId, cwd: dir, mcpServers: [] })).toMatchObject({
          result: {},
        })
      const afterLoads = c.seen.length
      for (let id = 10; id < 15; id++) {
        const started = Date.now()
        const out = await c.call(id, 'session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: `p${id}` }],
        })
        expect(out.error).toBeUndefined()
        // The response waits for this connection's feed to see the turn's last row; hitting the
        // quiescence ceiling means the feed it waited on was not the one being pushed to.
        expect(Date.now() - started).toBeLessThan(2_000)
      }
      const updates = (c.seen.slice(afterLoads) as Update[]).filter(
        (m) => m.method === 'session/update' && m.params?.sessionId === sessionId,
      )
      // Streamed text rides as previews, which are not rows and carry no harness _meta.
      const live = updates
        .map((m) => m.params?._meta?.['ai.agnes.harness']?.eventSequence)
        .filter((seq) => seq !== undefined)
      expect(live.length).toBeGreaterThan(0)
      expect(new Set(live).size).toBe(live.length)
      // Each answer reaches the client exactly once, however it was split between previews and the
      // part the durable message had to add.
      const said = updates
        .map(
          (m) => m.params as unknown as { update?: { sessionUpdate?: string; content?: { text?: string } } },
        )
        .filter((p) => p.update?.sessionUpdate === 'agent_message_chunk')
        .map((p) => p.update?.content?.text ?? '')
        .join('')
      expect(said).toBe('hello world'.repeat(5))
    } finally {
      c.socket.destroy()
      await sup.close()
      await tables.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('stops keeping a session alive across a worker replacement once its only connection closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-feed-close-'))
    const { sup, tables } = await supervisorFor(dir)
    const a = await client(sup.socketPath)
    const b = await client(sup.socketPath)
    try {
      expect((await a.call(1, 'initialize', initialize)).error).toBeUndefined()
      expect((await b.call(1, 'initialize', initialize)).error).toBeUndefined()
      // Two sessions in one workspace need their own keys; the default key is per workspace.
      const open = async (c: typeof a, sessionKey: string) =>
        (
          (
            await c.call(2, 'session/new', {
              cwd: dir,
              mcpServers: [],
              _meta: { 'ai.agnes.harness': { sessionKey } },
            })
          ).result as { sessionId: string }
        ).sessionId
      const dropped = await open(a, 'agnes:local:default:daemon:dm:feed-dropped')
      const watched = await open(b, 'agnes:local:default:daemon:dm:feed-watched')
      expect(dropped).not.toBe(watched)
      const closed = new Promise((resolve) => a.socket.once('close', resolve))
      a.socket.end()
      await closed
      let id = 10
      const setMode = (sessionId: string) =>
        b.call(id++, 'session/set_mode', { sessionId, modeId: 'standard' })
      const pollUntil = async (check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs
        for (;;) {
          if (await check()) return true
          if (Date.now() > deadline) return false
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      const isOpen = async (sessionId: string) => (await setMode(sessionId)).error === undefined
      // Nothing reports when the daemon has handled the close, so rather than guess a delay, replace
      // the worker until a replacement no longer brings the dropped session back. With the closed
      // connection's subscriptions released that is the first or second round; without, never.
      for (let round = 0; ; round++) {
        expect(round, 'the dropped session kept being reopened').toBeLessThan(3)
        expect(sup.retireSharedWorkerNow()).toBe(true)
        // The session a live connection still watches is reopened by the registry on its own.
        expect(await pollUntil(() => isOpen(watched), 30_000)).toBe(true)
        // Both recoveries would start at the same crash, so the dropped one would land alongside.
        if (!(await pollUntil(() => isOpen(dropped), 5_000))) break
      }
      expect(JSON.stringify((await setMode(dropped)).error ?? null)).toContain('SESSION_NOT_FOUND')
    } finally {
      a.socket.destroy()
      b.socket.destroy()
      await sup.close()
      await tables.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 150_000)
})
