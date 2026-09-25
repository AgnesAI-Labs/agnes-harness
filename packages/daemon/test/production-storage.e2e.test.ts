import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canonicalJson,
  createPlatform,
  createSqliteStorage,
  DEFAULT_COMPUTER_USE,
  hashInput,
  type ResolvedProfile,
  resolveProfile,
  sha256hex,
} from '@agnes/host'
import { hasPrivateDaclSync } from '@agnes/system-node'
import { describe, expect, it } from 'vitest'
import { buildConfig, type DaemonConfig, DEFAULT_LIMITS } from '../src/config.js'
import { MemoryTickets } from '../src/storage/lister.js'
import { encodeFrame, JsonlDecoder } from '../src/supervisor/framing.js'
import {
  deliverWorkerEvent,
  type StartSupervisorOptions,
  startProductionSupervisor,
} from '../src/supervisor/supervisor.js'

// These workers assemble the production package graph from TypeScript source before they say
// hello. That cold transpile takes a few seconds alone but about 30 s on a loaded hosted runner, so
// the startup window, every wait that has to cover a worker start, and the tests that start one
// (150 s) allow well beyond it.
const SOURCE_WORKER_STARTUP_MS = 90_000

function profile(dataDir: string): ResolvedProfile {
  const body = {
    name: 'local-dev',
    dataDir,
    transports: [],
    computerUse: DEFAULT_COMPUTER_USE,
    presets: { default: 'standard', allowed: ['standard'] },
  } as unknown as Omit<ResolvedProfile, 'hash'>
  return { ...body, hash: `sha256-${sha256hex(canonicalJson(hashInput(body)))}` }
}

function config(dataDir: string): DaemonConfig {
  return {
    ...buildConfig({
      args: { profile: 'local-dev' },
      profile: profile(dataDir),
      home: dataDir,
      ipc: createPlatform().snapshot().os === 'win32' ? 'pipe' : 'unix',
    }),
    limits: { ...DEFAULT_LIMITS, jobsTickMs: 60_000 },
  }
}

function options(dataDir: string): Omit<StartSupervisorOptions, 'tables' | 'jobTables'> {
  return {
    config: config(dataDir),
    profile: profile(dataDir),
    profileDir: join(dataDir, 'profiles', 'local-dev'),
    profileFile: join(dataDir, 'profile.json'),
    processIdentity: async (pid) =>
      pid === process.pid ? { state: 'alive', startId: 'production-storage-test' } : { state: 'dead' },
  }
}

async function client(socketPath: string): Promise<{
  call(id: number, method: string, params: unknown): Promise<unknown>
  close(): void
}> {
  const socket = connect(socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const decoder = new JsonlDecoder()
  const inbox: Array<{ id?: number; result?: unknown; error?: unknown }> = []
  const waiters: Array<(frame: (typeof inbox)[number]) => void> = []
  socket.on('data', (chunk: Buffer) => {
    for (const frame of decoder.feed(chunk) as typeof inbox) {
      const waiter = waiters.shift()
      if (waiter) waiter(frame)
      else inbox.push(frame)
    }
  })
  const next = (): Promise<(typeof inbox)[number]> =>
    inbox.length
      ? Promise.resolve(inbox.shift() as (typeof inbox)[number])
      : new Promise((resolve) => waiters.push(resolve))
  return {
    async call(id, method, params) {
      socket.write(encodeFrame({ jsonrpc: '2.0', id, method, params }))
      for (;;) {
        const frame = await next()
        if (frame.id !== id) continue
        if (frame.error !== undefined) throw frame.error
        return frame.result
      }
    },
    close: () => socket.end(),
  }
}

describe('production supervisor storage', () => {
  const reclaim = {
    listExpired: () => [],
    claimForReclaim: () => null,
  }

  it('indexes worker approval events with the real session workspace before delivery', () => {
    const tickets = new MemoryTickets()
    const delivered: string[] = []
    const order: string[] = []
    const registry = {
      get: () => ({ session: { cwd: '/workspace/project' } }),
      deliver: (key: string, _event: unknown, beforePublish?: () => void) => {
        beforePublish?.()
        order.push(`indexed:${tickets.get('ticket-one') ?? 'missing'}`)
        delivered.push(key)
      },
    }
    deliverWorkerEvent(registry as never, tickets, () => Date.parse('2026-09-11T00:00:00Z'), 'session-one', {
      type: 'approval/asked',
      data: {
        pending: { ticket: 'ticket-one', expiresAt: '2026-09-11T00:01:00Z' },
      },
    } as never)
    expect(tickets.get('ticket-one')).toBe('session-one')
    expect(tickets.cwd('ticket-one')).toBe('/workspace/project')
    expect(delivered).toEqual(['session-one'])
    expect(order).toEqual(['indexed:session-one'])
  })

  it('persists jobs and auth claims through Host isolated storage across production restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-production-storage-'))
    const o = options(dir)
    writeFileSync(o.profileFile, JSON.stringify(o.profile))
    const productionSession = 'agnes:local:default:daemon:dm:production'
    const seeded = createSqliteStorage({
      file: join(dir, 'sessions.db'),
      tablesDir: join(dir, 'tables'),
    })
    const ownership = seeded.tables('@agnes/daemon').table('session_principal_ownership')
    ownership.exec(`CREATE TABLE IF NOT EXISTS session_principal_ownership (
      session_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      reservation_kind TEXT NOT NULL,
      reservation_state TEXT NOT NULL,
      parent_session_id TEXT,
      boundary_seq INTEGER
    )`)
    ownership.run(
      `INSERT INTO session_principal_ownership
       (session_id, principal_id, reservation_kind, reservation_state, parent_session_id, boundary_seq)
       VALUES (?, ?, 'new', 'active', NULL, NULL)`,
      [productionSession, 'local'],
    )
    await seeded.close()
    const supervisor = await startProductionSupervisor(o)
    const rpc = await client(supervisor.socketPath)
    try {
      if (createPlatform().snapshot().os === 'win32')
        expect(hasPrivateDaclSync(join(dir, 'resource-control', 'skill-lkg', 'local-dev'))).toBe(true)
      await rpc.call(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      await expect(
        rpc.call(2, '_agnes/v1/jobs.enqueue', {
          idempotencyKey: 'production-job',
          sessionKey: productionSession,
          payload: { prompt: 'later' },
          schedule: { kind: 'at', at: Date.now() + 60_000 },
        }),
      ).resolves.toEqual({ jobId: 'production-job' })
      await expect(
        rpc.call(3, '_agnes/v1/auth.claim', { kind: 'production-restart', value: 'same-event' }),
      ).resolves.toEqual({ granted: true })
    } finally {
      rpc.close()
      await supervisor.close()
    }

    const restarted = await startProductionSupervisor(o)
    const retry = await client(restarted.socketPath)
    try {
      await retry.call(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      await expect(
        retry.call(2, '_agnes/v1/auth.claim', { kind: 'production-restart', value: 'same-event' }),
      ).resolves.toEqual({ granted: false })
    } finally {
      retry.close()
      await restarted.close()
    }

    const storage = createSqliteStorage({
      file: join(dir, 'sessions.db'),
      tablesDir: join(dir, 'tables'),
    })
    try {
      expect(
        storage
          .tables('@agnes/daemon')
          .table('jobs')
          .get<{ status: string }>('SELECT status FROM jobs WHERE idempotency_key = ?', ['production-job']),
      ).toEqual({ status: 'waiting' })
    } finally {
      await storage.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.runIf(createPlatform().snapshot().os === 'win32')(
    'refuses a pre-existing broad Skill cache without changing its ACL',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agnes-broad-skill-cache-'))
      const cache = join(dir, 'resource-control', 'skill-lkg', 'local-dev')
      mkdirSync(cache, { recursive: true })
      const systemRoot = process.env.SystemRoot
      if (!systemRoot) throw new Error('SystemRoot missing')
      const icacls = join(systemRoot, 'System32', 'icacls.exe')
      execFileSync(icacls, [cache, '/grant', '*S-1-1-0:R'], { windowsHide: true })
      const before = execFileSync(icacls, [cache], { windowsHide: true })
      try {
        expect(hasPrivateDaclSync(cache)).toBe(false)
        await expect(startProductionSupervisor(options(dir))).rejects.toMatchObject({ code: 'EACCES' })
        expect(execFileSync(icacls, [cache], { windowsHide: true })).toEqual(before)
        expect(readdirSync(cache)).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it('publishes a changed workspace Skill revision and keeps its trust across five roots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-skill-refresh-'))
    const workspace = join(dir, 'workspace')
    const home = join(dir, 'home')
    const priorHome = process.env.HOME
    // The worker inherits process.env: an exported AGH_HOME/AGNES_HOME would move the user-agnes
    // root away from <HOME>/.agh, so clear both for the test and restore them afterwards.
    const priorHomeVars = { AGH_HOME: process.env.AGH_HOME, AGNES_HOME: process.env.AGNES_HOME }
    delete process.env.AGH_HOME
    delete process.env.AGNES_HOME
    let supervisor: Awaited<ReturnType<typeof startProductionSupervisor>> | undefined
    let rpc: Awaited<ReturnType<typeof client>> | undefined
    try {
      const skills = [
        [workspace, '.agh', 'skills', 'workspace-agnes', 'Workspace'],
        [home, '.agh', 'skills', 'user-agnes', 'User Agnes'],
        [home, '.agents', 'skills', 'user-agents', 'User Agents'],
        [home, '.claude', 'skills', 'user-claude', 'User Claude'],
        [home, '.codex', 'skills', 'user-codex', 'User Codex'],
      ] as const
      for (const [root, dot, category, name, description] of skills) {
        const location = join(root, dot, category, name)
        mkdirSync(location, { recursive: true })
        writeFileSync(
          join(location, 'SKILL.md'),
          `---\nname: ${name}\ndescription: ${description}\n---\ninitial ${name}`,
        )
      }
      process.env.HOME = home
      const resourceProfile = await resolveProfile(
        {
          builtin: 'local-dev',
          user: { name: 'local-dev', dataDir: join(dir, 'data'), cacheDir: join(dir, 'cache') },
        },
        { platform: createPlatform().snapshot(), agnesVersion: '0.0.0', now: new Date().toISOString() },
      )
      mkdirSync(resourceProfile.dataDir, { recursive: true })
      supervisor = await startProductionSupervisor({
        config: {
          ...config(resourceProfile.dataDir),
          // This test separates the resolved Agnes home from profile.dataDir. Production workers
          // receive config.home as AGH_HOME, so point it at the root that owns user-agnes/skills.
          home: join(home, '.agh'),
          limits: { ...DEFAULT_LIMITS, workerStartupMs: SOURCE_WORKER_STARTUP_MS, jobsTickMs: 60_000 },
        },
        profile: resourceProfile,
        profileDir: join(dir, 'profiles', 'local-dev'),
        profileFile: join(dir, 'profile.json'),
        workspaceRoot: workspace,
        processIdentity: async (pid) =>
          pid === process.pid ? { state: 'alive', startId: 'skill-refresh-test' } : { state: 'dead' },
        workerExecPath: process.execPath,
        workerExecArgv: ['--import', 'tsx'],
        workerEntry: fileURLToPath(new URL('../src/worker/main.ts', import.meta.url)),
      })
      const connection = await client(supervisor.socketPath)
      rpc = connection
      let id = 1
      const call = (method: string, params: unknown): Promise<unknown> =>
        connection.call(id++, method, params)
      const wait = async (operationId: string): Promise<Record<string, unknown>> => {
        // The daemon's Skill watcher also refreshes after these file edits, and refreshes of one
        // profile run one at a time, so an explicit refresh can queue behind a watcher refresh.
        const deadline = performance.now() + SOURCE_WORKER_STARTUP_MS + 30_000
        while (performance.now() < deadline) {
          const operation = (await call('_agnes/v1/resources.operation.get', {
            profile: 'local-dev',
            operationId,
          })) as Record<string, unknown>
          if (
            operation.state === 'succeeded' ||
            operation.state === 'failed' ||
            operation.state === 'cancelled'
          )
            return operation
          await new Promise<void>((resolve) => setTimeout(resolve, 20))
        }
        throw new Error('resource operation did not settle')
      }
      await call('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        _meta: { 'ai.agnes.harness': { clientId: 'skill-refresh-test' } },
      })
      const refresh = (commandId: string) =>
        call('_agnes/v1/skills.refresh', {
          profile: 'local-dev',
          clientId: 'skill-refresh-test',
          commandId,
        }) as Promise<{
          operationId: string
        }>
      const first = await refresh('skill-refresh-first')
      expect(await wait(first.operationId)).toMatchObject({ state: 'succeeded' })
      const initial = (await call('_agnes/v1/resources.list', { profile: 'local-dev', kind: 'skill' })) as {
        items: Array<{ resourceId: string; revision: string; sourceIdentity: { rootKey: string } }>
      }
      expect(initial.items.map((item) => item.sourceIdentity.rootKey).sort()).toEqual([
        'user-agents',
        'user-agnes',
        'user-claude',
        'user-codex',
        'workspace-agnes',
      ])
      const workspaceSkill = initial.items.find((item) => item.sourceIdentity.rootKey === 'workspace-agnes')
      if (!workspaceSkill) throw new Error('workspace Skill was not discovered')
      const trusted = (await call('_agnes/v1/skills.trust.set', {
        profile: 'local-dev',
        resourceId: workspaceSkill.resourceId,
        expectedRevision: workspaceSkill.revision,
        trust: 'trusted',
        clientId: 'skill-refresh-test',
        commandId: 'skill-trust',
      })) as { operationId: string }
      expect(await wait(trusted.operationId)).toMatchObject({ state: 'succeeded' })
      const enabled = (await call('_agnes/v1/resources.desired.set', {
        profile: 'local-dev',
        resourceId: workspaceSkill.resourceId,
        expectedRevision: workspaceSkill.revision,
        state: 'enabled',
        config: { kind: 'none' },
        clientId: 'skill-refresh-test',
        commandId: 'skill-enable',
      })) as { operationId: string }
      expect(await wait(enabled.operationId)).toMatchObject({ state: 'succeeded' })
      writeFileSync(
        join(workspace, '.agh', 'skills', 'workspace-agnes', 'SKILL.md'),
        '---\nname: workspace-agnes\ndescription: Workspace changed\n---\nchanged body',
      )
      const changed = await refresh('skill-refresh-changed')
      expect(await wait(changed.operationId)).toMatchObject({ state: 'succeeded' })
      const next = (await call('_agnes/v1/resources.get', {
        profile: 'local-dev',
        resourceId: workspaceSkill.resourceId,
      })) as {
        revision: string
        trust: string
        desired: string
        actual: string
        lastSafeError?: { code: string }
      }
      // An edit keeps the Skill's trust decision: it is rebound to the new revision.
      expect(next).toMatchObject({ trust: 'trusted', desired: 'enabled', actual: 'ready' })
      expect(next.revision).not.toBe(workspaceSkill.revision)
      expect(next.lastSafeError).toBeUndefined()
      // The real resource worker rejects the malformed root contents while retaining its last
      // known-good candidate. Publishing that explicitly stale snapshot is a successful refresh.
      writeFileSync(join(workspace, '.agh', 'skills', 'workspace-agnes', 'SKILL.md'), 'malformed')
      const malformed = await refresh('skill-refresh-malformed')
      const malformedResult = await wait(malformed.operationId)
      expect(malformedResult, JSON.stringify(malformedResult)).toMatchObject({ state: 'succeeded' })
      await expect(
        call('_agnes/v1/resources.get', { profile: 'local-dev', resourceId: workspaceSkill.resourceId }),
      ).resolves.toMatchObject({
        revision: next.revision,
        trust: 'trusted',
        stale: true,
      })
    } finally {
      rpc?.close()
      await supervisor?.close()
      if (priorHome === undefined) delete process.env.HOME
      else process.env.HOME = priorHome
      for (const [name, value] of Object.entries(priorHomeVars))
        if (value !== undefined) process.env[name] = value
      rmSync(dir, { recursive: true, force: true })
    }
  }, 150_000)

  it('projects a killed stdio MCP generation without degrading an unrelated active server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-mcp-health-'))
    const server = join(dir, 'mcp-health-server.mjs')
    const previousAllowlist = process.env.AGNES_MCP_STDIO_ALLOWLIST
    const previousPath = process.env.PATH
    let supervisor: Awaited<ReturnType<typeof startProductionSupervisor>> | undefined
    let rpc: Awaited<ReturnType<typeof client>> | undefined
    // Windows enables its verified native executable without a deployment grant. Elsewhere the
    // servers name a bare `node`, so the deployment grant and the lookup both go through PATH.
    const windows = process.platform === 'win32'
    const executable = windows ? process.execPath : 'node'
    if (windows) delete process.env.AGNES_MCP_STDIO_ALLOWLIST
    else {
      process.env.AGNES_MCP_STDIO_ALLOWLIST = 'node'
      process.env.PATH = `${dirname(process.execPath)}:${previousPath ?? ''}`
    }
    try {
      writeFileSync(
        server,
        [
          "import { writeFileSync } from 'node:fs'",
          "import readline from 'node:readline'",
          'const [pidFile] = process.argv.slice(2)',
          'writeFileSync(pidFile, String(process.pid))',
          "const tool = { name: 'status', description: 'status', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }",
          "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')",
          "readline.createInterface({ input: process.stdin }).on('line', (line) => { const request = JSON.parse(line); if (request.method === 'initialize') reply(request.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'health-fixture', version: '1' } }); else if (request.method === 'tools/list') reply(request.id, { tools: [tool] }); else if (request.id !== undefined) reply(request.id, {}); })",
        ].join(';'),
      )
      const resourceProfile = await resolveProfile(
        {
          builtin: 'local-dev',
          user: { name: 'local-dev', dataDir: dir, cacheDir: join(dir, 'cache') },
        },
        { platform: createPlatform().snapshot(), agnesVersion: '0.0.0', now: new Date().toISOString() },
      )
      supervisor = await startProductionSupervisor({
        config: {
          ...config(dir),
          limits: { ...DEFAULT_LIMITS, workerStartupMs: SOURCE_WORKER_STARTUP_MS, jobsTickMs: 60_000 },
        },
        profile: resourceProfile,
        profileDir: join(dir, 'profiles', 'local-dev'),
        profileFile: join(dir, 'profile.json'),
        processIdentity: async (pid) =>
          pid === process.pid ? { state: 'alive', startId: 'mcp-health-test' } : { state: 'dead' },
        workerExecPath: process.execPath,
        workerExecArgv: ['--import', 'tsx'],
        workerEntry: fileURLToPath(new URL('../src/worker/main.ts', import.meta.url)),
      })
      const connection = await client(supervisor.socketPath)
      rpc = connection
      let id = 1
      const call = (method: string, params: unknown): Promise<unknown> =>
        connection.call(id++, method, params)
      const wait = async (operationId: string): Promise<Record<string, unknown>> => {
        const deadline = performance.now() + SOURCE_WORKER_STARTUP_MS + 10_000
        while (performance.now() < deadline) {
          const operation = (await call('_agnes/v1/resources.operation.get', {
            profile: 'local-dev',
            operationId,
          })) as Record<string, unknown>
          if (operation.state === 'succeeded' || operation.state === 'failed') return operation
          await new Promise<void>((resolve) => setTimeout(resolve, 20))
        }
        throw new Error('health operation did not settle')
      }
      const pid = async (file: string): Promise<number> => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (existsSync(file)) {
            const value = Number(readFileSync(file, 'utf8'))
            if (Number.isSafeInteger(value) && value > 0) return value
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 20))
        }
        throw new Error('stdio fixture did not publish a pid')
      }
      await call('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        _meta: { 'ai.agnes.harness': { clientId: 'mcp-health-test' } },
      })
      const activate = async (serverId: string): Promise<{ revision: string; pidFile: string }> => {
        const pidFile = join(dir, `${serverId}.pid`)
        const definition = {
          serverId,
          displayName: serverId,
          transport: { kind: 'stdio', executable, args: [server, pidFile] },
          secretBinding: { kind: 'none' },
          toolPolicy: { allow: ['status'] },
        }
        const created = (await call('_agnes/v1/mcp.servers.create', {
          profile: 'local-dev',
          definition,
          clientId: 'mcp-health-test',
          commandId: `${serverId}-create`,
        })) as { operationId: string }
        expect(await wait(created.operationId)).toMatchObject({ state: 'succeeded' })
        const descriptor = (await call('_agnes/v1/mcp.servers.get', {
          profile: 'local-dev',
          serverId,
        })) as { revision: string }
        const trusted = (await call('_agnes/v1/mcp.servers.trust.set', {
          profile: 'local-dev',
          serverId,
          expectedRevision: descriptor.revision,
          trust: 'trusted',
          clientId: 'mcp-health-test',
          commandId: `${serverId}-trust`,
        })) as { operationId: string }
        expect((await wait(trusted.operationId)).state).toBe('succeeded')
        const enabled = (await call('_agnes/v1/mcp.servers.enable', {
          profile: 'local-dev',
          serverId,
          expectedRevision: descriptor.revision,
          clientId: 'mcp-health-test',
          commandId: `${serverId}-enable`,
        })) as { operationId: string }
        expect((await wait(enabled.operationId)).state).toBe('succeeded')
        return { revision: descriptor.revision, pidFile }
      }
      const a = await activate('a')
      const b = await activate('b')
      const aPid = await pid(a.pidFile)
      const bPid = await pid(b.pidFile)
      await expect(
        call('_agnes/v1/mcp.servers.status', { profile: 'local-dev', serverId: 'a' }),
      ).resolves.toMatchObject({ connectionState: 'ready' })
      await expect(
        call('_agnes/v1/mcp.servers.status', { profile: 'local-dev', serverId: 'b' }),
      ).resolves.toMatchObject({ connectionState: 'ready' })

      process.kill(aPid, 'SIGKILL')
      let aStatus: Record<string, unknown> | undefined
      for (let attempt = 0; attempt < 120; attempt++) {
        const current = (await call('_agnes/v1/mcp.servers.status', {
          profile: 'local-dev',
          serverId: 'a',
        })) as Record<string, unknown>
        if (current.connectionState === 'unavailable' || current.connectionState === 'degraded') {
          aStatus = current
          break
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
      }
      expect(aStatus).toMatchObject({ lastSafeError: { code: 'MCP_CONNECTION_LOST' } })
      await expect(
        call('_agnes/v1/mcp.servers.status', { profile: 'local-dev', serverId: 'b' }),
      ).resolves.toMatchObject({ connectionState: 'ready' })
      await expect(
        call('_agnes/v1/mcp.servers.tools.list', { profile: 'local-dev', serverId: 'a' }),
      ).rejects.toMatchObject({ data: { code: 'MCP_CATALOG_UNAVAILABLE' } })

      const reconnect = (await call('_agnes/v1/mcp.servers.reconnect', {
        profile: 'local-dev',
        serverId: 'b',
        expectedRevision: b.revision,
        clientId: 'mcp-health-test',
        commandId: 'b-reconnect',
      })) as { operationId: string }
      expect((await wait(reconnect.operationId)).state).toBe('succeeded')
      const newBPid = await pid(b.pidFile)
      expect(newBPid).not.toBe(bPid)
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      expect(() => process.kill(bPid, 0)).toThrow()
    } finally {
      rpc?.close()
      await supervisor?.close()
      if (previousAllowlist === undefined) delete process.env.AGNES_MCP_STDIO_ALLOWLIST
      else process.env.AGNES_MCP_STDIO_ALLOWLIST = previousAllowlist
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      rmSync(dir, { recursive: true, force: true })
    }
  }, 150_000)

  it('resolves SecretRef only inside the resource worker and preserves the active MCP on a missing ref', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-resource-secret-'))
    const server = join(dir, 'mcp-secret-server.mjs')
    const observation = join(dir, 'mcp-observation.json')
    const sentinel = ['resource', 'credential', 'audit', 'marker'].join('-')
    const expectedHash = createHash('sha256').update(sentinel, 'utf8').digest('hex')
    const previousAllowlist = process.env.AGNES_MCP_STDIO_ALLOWLIST
    const previousToken = process.env.AGNES_SECRET_AUDIT_TOKEN
    let supervisor: Awaited<ReturnType<typeof startProductionSupervisor>> | undefined
    let rpc: Awaited<ReturnType<typeof client>> | undefined
    process.env.AGNES_MCP_STDIO_ALLOWLIST = process.execPath
    process.env.AGNES_SECRET_AUDIT_TOKEN = sentinel
    try {
      writeFileSync(
        server,
        [
          "import { createHash } from 'node:crypto'",
          "import { writeFileSync } from 'node:fs'",
          "import readline from 'node:readline'",
          'const [expectedHash, observation] = process.argv.slice(2)',
          "const token = process.env.TOKEN ?? ''",
          "const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')",
          'writeFileSync(observation, JSON.stringify({ matches: tokenHash === expectedHash, tokenHash }))',
          "const tool = { name: 'status', description: 'status', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }",
          "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')",
          "readline.createInterface({ input: process.stdin }).on('line', (line) => { const request = JSON.parse(line); if (request.method === 'initialize') reply(request.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'secret-audit-fixture', version: '1' } }); else if (request.method === 'tools/list') reply(request.id, { tools: [tool], nextCursor: undefined }); else if (request.id !== undefined) reply(request.id, {}); })",
        ].join(';'),
      )
      const resourceProfile = await resolveProfile(
        {
          builtin: 'local-dev',
          user: { name: 'local-dev', dataDir: dir, cacheDir: join(dir, 'cache') },
        },
        { platform: createPlatform().snapshot(), agnesVersion: '0.0.0', now: new Date().toISOString() },
      )
      // The resource worker manages MCP servers before default local-dev has any provider route.
      expect(resourceProfile.provider.routes).toBeUndefined()
      const startOptions = {
        config: {
          ...config(dir),
          limits: { ...DEFAULT_LIMITS, workerStartupMs: SOURCE_WORKER_STARTUP_MS, jobsTickMs: 60_000 },
        },
        profile: resourceProfile,
        profileDir: join(dir, 'profiles', 'local-dev'),
        profileFile: join(dir, 'profile.json'),
        processIdentity: async (pid: number) =>
          pid === process.pid
            ? { state: 'alive' as const, startId: 'resource-secret-test' }
            : { state: 'dead' as const },
        workerExecPath: process.execPath,
        workerExecArgv: ['--import', 'tsx'],
        workerEntry: fileURLToPath(new URL('../src/worker/main.ts', import.meta.url)),
      }
      supervisor = await startProductionSupervisor(startOptions)
      const connection = await client(supervisor.socketPath)
      rpc = connection
      let id = 1
      const call = (method: string, params: unknown): Promise<unknown> =>
        connection.call(id++, method, params)
      const wait = async (operationId: string): Promise<Record<string, unknown>> => {
        // Match the real worker startup budget instead of assuming a two-second cold start.
        const deadline = performance.now() + SOURCE_WORKER_STARTUP_MS + 10_000
        let lastState: unknown
        while (performance.now() < deadline) {
          const operation = (await call('_agnes/v1/resources.operation.get', {
            profile: 'local-dev',
            operationId,
          })) as Record<string, unknown>
          lastState = operation.state
          if (operation.state === 'succeeded') return operation
          if (operation.state === 'failed' || operation.state === 'cancelled') return operation
          await new Promise<void>((resolve) => setTimeout(resolve, 20))
        }
        throw new Error(`resource operation did not settle (last state: ${String(lastState)})`)
      }
      await call('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        _meta: { 'ai.agnes.harness': { clientId: 'resource-secret-test' } },
      })
      const definition = {
        serverId: 'secret-audit',
        displayName: 'Secret audit',
        transport: { kind: 'stdio', executable: process.execPath, args: [server, expectedHash, observation] },
        secretBinding: { kind: 'stdio-env', env: { TOKEN: 'secret://audit/token' } },
        toolPolicy: { allow: ['status'] },
      }
      const created = (await call('_agnes/v1/mcp.servers.create', {
        profile: 'local-dev',
        definition,
        clientId: 'resource-secret-test',
        commandId: 'resource-secret-create',
      })) as { operationId: string }
      expect((await wait(created.operationId)).state).toBe('succeeded')
      const descriptor = (await call('_agnes/v1/mcp.servers.get', {
        profile: 'local-dev',
        serverId: 'secret-audit',
      })) as { revision: string }
      const trusted = (await call('_agnes/v1/mcp.servers.trust.set', {
        profile: 'local-dev',
        serverId: 'secret-audit',
        expectedRevision: descriptor.revision,
        trust: 'trusted',
        clientId: 'resource-secret-test',
        commandId: 'resource-secret-trust',
      })) as { operationId: string }
      expect((await wait(trusted.operationId)).state).toBe('succeeded')
      const tested = (await call('_agnes/v1/mcp.servers.test', {
        profile: 'local-dev',
        serverId: 'secret-audit',
        expectedRevision: descriptor.revision,
        clientId: 'resource-secret-test',
        commandId: 'resource-secret-test',
      })) as { operationId: string }
      await expect(wait(tested.operationId)).resolves.toMatchObject({
        state: 'succeeded',
        result: { toolCount: 1 },
      })
      const enabled = (await call('_agnes/v1/mcp.servers.enable', {
        profile: 'local-dev',
        serverId: 'secret-audit',
        expectedRevision: descriptor.revision,
        clientId: 'resource-secret-test',
        commandId: 'resource-secret-enable',
      })) as { operationId: string }
      expect((await wait(enabled.operationId)).state).toBe('succeeded')
      const readyDescriptor = await call('_agnes/v1/mcp.servers.get', {
        profile: 'local-dev',
        serverId: 'secret-audit',
      })
      expect(readyDescriptor).toMatchObject({ trust: 'trusted', desired: 'enabled', actual: 'ready' })
      expect(JSON.stringify(readyDescriptor)).not.toContain(sentinel)
      expect(JSON.parse(readFileSync(observation, 'utf8'))).toEqual({
        matches: true,
        tokenHash: expectedHash,
      })

      // single-resident-worker design: every MCP server's connection now lives in the one shared
      // session worker, kept alive from daemon start rather than re-spawned per reconcile/reconnect
      // call. That worker process's own environment was captured once at its own spawn, with the
      // token still set - deleting it here in the daemon's process cannot reach an already-running
      // child process's environment, so this reconnect resolves the SecretRef exactly as before and
      // succeeds. (The OLD per-request candidate worker inherited the daemon's *current* environment
      // on every fresh spawn, so the equivalent reconnect used to fail here - see the restart-scoped
      // steps below for how a missing secret is still surfaced: once the shared worker itself is
      // gone, its replacement's environment reflects whatever is current at that spawn instead.)
      delete process.env.AGNES_SECRET_AUDIT_TOKEN
      const reconnect = (await call('_agnes/v1/mcp.servers.reconnect', {
        profile: 'local-dev',
        serverId: 'secret-audit',
        expectedRevision: descriptor.revision,
        clientId: 'resource-secret-test',
        commandId: 'resource-secret-missing-reconnect',
      })) as { operationId: string }
      const reconnectedWithStaleEnv = await wait(reconnect.operationId)
      expect(reconnectedWithStaleEnv).toMatchObject({ state: 'succeeded' })
      expect(JSON.stringify(reconnectedWithStaleEnv)).not.toContain(sentinel)
      await expect(
        call('_agnes/v1/mcp.servers.tools.list', { profile: 'local-dev', serverId: 'secret-audit' }),
      ).resolves.toMatchObject({ items: [expect.objectContaining({ name: 'status' })] })

      // This reconnect shares the existing daemon and retains its old active worker. A restart has
      // no such generation: restore with the deployment secret must establish a new current one.
      process.env.AGNES_SECRET_AUDIT_TOKEN = sentinel
      rpc.close()
      rpc = undefined
      await supervisor.close()
      supervisor = await startProductionSupervisor(startOptions)
      const restored = await client(supervisor.socketPath)
      rpc = restored
      await restored.call(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        _meta: { 'ai.agnes.harness': { clientId: 'resource-secret-restart' } },
      })
      await expect(
        restored.call(2, '_agnes/v1/mcp.servers.get', { profile: 'local-dev', serverId: 'secret-audit' }),
      ).resolves.toMatchObject({ actual: 'ready' })
      await expect(
        restored.call(3, '_agnes/v1/mcp.servers.tools.list', {
          profile: 'local-dev',
          serverId: 'secret-audit',
        }),
      ).resolves.toMatchObject({ items: [expect.objectContaining({ name: 'status' })] })

      // No current Host connection survives this shutdown. Without the SecretRef, recovery must
      // expose unavailable and catalog reads must reject deterministically without delegating stale state.
      restored.close()
      rpc = undefined
      await supervisor.close()
      delete process.env.AGNES_SECRET_AUDIT_TOKEN
      supervisor = await startProductionSupervisor(startOptions)
      const missing = await client(supervisor.socketPath)
      rpc = missing
      await missing.call(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        _meta: { 'ai.agnes.harness': { clientId: 'resource-secret-missing-restart' } },
      })
      await expect(
        missing.call(2, '_agnes/v1/mcp.servers.get', { profile: 'local-dev', serverId: 'secret-audit' }),
      ).resolves.toMatchObject({ actual: 'unavailable', lastSafeError: { code: 'MCP_CONNECT_FAILED' } })
      await expect(
        missing.call(3, '_agnes/v1/mcp.servers.tools.list', {
          profile: 'local-dev',
          serverId: 'secret-audit',
        }),
      ).rejects.toMatchObject({ data: { code: 'MCP_CATALOG_UNAVAILABLE' } })

      const restartReconnect = (await missing.call(4, '_agnes/v1/mcp.servers.reconnect', {
        profile: 'local-dev',
        serverId: 'secret-audit',
        expectedRevision: descriptor.revision,
        clientId: 'resource-secret-missing-restart',
        commandId: 'resource-secret-missing-restart-reconnect',
      })) as { operationId: string }
      let restartFailure: unknown
      // Reconnect creates a real candidate worker before it can report a missing credential.
      const restartDeadline = performance.now() + startOptions.config.limits.workerStartupMs
      let restartCallId = 5
      while (performance.now() < restartDeadline) {
        const operation = await missing.call(restartCallId++, '_agnes/v1/resources.operation.get', {
          profile: 'local-dev',
          operationId: restartReconnect.operationId,
        })
        restartFailure = operation
        if (['failed', 'succeeded', 'cancelled'].includes((operation as { state: string }).state)) break
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
      }
      expect(restartFailure).toMatchObject({
        state: 'failed',
        lastSafeError: { code: 'MCP_RECONCILE_FAILED' },
      })
      await expect(
        missing.call(restartCallId++, '_agnes/v1/mcp.servers.get', {
          profile: 'local-dev',
          serverId: 'secret-audit',
        }),
      ).resolves.toMatchObject({ actual: 'unavailable' })

      const resourceFiles = (directory: string): string[] =>
        readdirSync(directory).flatMap((entry) => {
          const file = join(directory, entry)
          return statSync(file).isDirectory() ? resourceFiles(file) : [readFileSync(file, 'utf8')]
        })
      const durable = resourceFiles(join(dir, 'resource-control')).join('')
      expect(durable).not.toContain(sentinel)
    } finally {
      rpc?.close()
      await supervisor?.close()
      if (previousAllowlist === undefined) delete process.env.AGNES_MCP_STDIO_ALLOWLIST
      else process.env.AGNES_MCP_STDIO_ALLOWLIST = previousAllowlist
      if (previousToken === undefined) delete process.env.AGNES_SECRET_AUDIT_TOKEN
      else process.env.AGNES_SECRET_AUDIT_TOKEN = previousToken
      rmSync(dir, { recursive: true, force: true })
    }
  }, 150_000)

  it('closes the supervisor before storage exactly once on normal or signal-driven shutdown', async () => {
    const events: string[] = []
    const store = { table: () => ({}) }
    const owners: string[] = []
    let storageOptions: unknown
    let received: StartSupervisorOptions | undefined
    const directory = { upsert: async () => ({ upserted: 0, deleted: 0 }) }
    const supervisor = await startProductionSupervisor(
      { ...options('/state'), ports: { directory } },
      {
        createStorage: ((o: unknown) => {
          storageOptions = o
          return {
            crashReclaim: reclaim,
            tables(id: string) {
              owners.push(id)
              return store
            },
            async close() {
              events.push('storage.close')
            },
          }
        }) as never,
        start: (async (o: StartSupervisorOptions) => {
          received = o
          return {
            socketPath: '/state/daemon/agnesd.sock',
            async close() {
              events.push('supervisor.close')
            },
          }
        }) as never,
      },
    )

    expect(storageOptions).toEqual({
      file: join('/state', 'sessions.db'),
      tablesDir: join('/state', 'tables'),
    })
    expect(owners).toEqual(['@agnes/daemon', '@agnes/daemon/artifact-read-authority'])
    expect(received?.jobTables).toBeDefined()
    expect(received?.artifactAuthorityTable).toBeDefined()
    expect(received?.reclaim).toBeDefined()
    expect(received?.tables).toBeUndefined()
    expect(received?.ports?.directory).toBe(directory)
    await Promise.all([supervisor.close(), supervisor.close()])
    expect(events).toEqual(['supervisor.close', 'storage.close'])
  })

  it('closes storage after startup failure and after a supervisor shutdown failure', async () => {
    const startup = new Error('startup failed')
    let startupCloses = 0
    await expect(
      startProductionSupervisor(options('/startup-failure'), {
        createStorage: (() => ({
          crashReclaim: reclaim,
          tables: () => ({ table: () => ({}) }),
          close: async () => {
            startupCloses++
          },
        })) as never,
        start: (async () => {
          throw startup
        }) as never,
      }),
    ).rejects.toBe(startup)
    expect(startupCloses).toBe(1)

    const shutdown = new Error('shutdown failed')
    let shutdownCloses = 0
    const supervisor = await startProductionSupervisor(options('/shutdown-failure'), {
      createStorage: (() => ({
        crashReclaim: reclaim,
        tables: () => ({ table: () => ({}) }),
        close: async () => {
          shutdownCloses++
        },
      })) as never,
      start: (async () => ({
        socketPath: '/shutdown-failure/daemon/agnesd.sock',
        close: async () => {
          throw shutdown
        },
      })) as never,
    })
    await expect(supervisor.close()).rejects.toBe(shutdown)
    expect(shutdownCloses).toBe(1)
  })
})
