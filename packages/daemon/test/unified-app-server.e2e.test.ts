import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConfigurationService, createPlatform, type ResolvedProfile, resolveProfile } from '@agnes/host'
import { createClient, memoryJournal, wsTransport } from '@agnes/sdk'
import { createPrivateDirectorySync, windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { buildConfig } from '../src/config.js'
import { startProductionSupervisor } from '../src/supervisor/supervisor.js'
import { localSdkTransport } from './local-socket-path.js'

const processIdentity = async (pid: number) =>
  pid === process.pid
    ? ({ state: 'alive', startId: 'unified-app-server' } as const)
    : ({ state: 'dead' } as const)

const workerExits = vi.hoisted(
  () => [] as Array<Promise<{ pid: number | undefined; code: number | null; signal: string | null }>>,
)
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  const spawn = new Proxy(actual.spawn, {
    apply(target, receiver, args) {
      const child: import('node:child_process').ChildProcess = Reflect.apply(target, receiver, args)
      const options = (Array.isArray(args[1]) ? args[2] : args[1]) as
        | import('node:child_process').SpawnOptions
        | undefined
      if (options?.env?.AGNES_WORKER_TOKEN) {
        workerExits.push(
          new Promise((resolve) =>
            child.once('exit', (code, signal) => resolve({ pid: child.pid, code, signal })),
          ),
        )
      }
      return child
    },
  })
  return { ...actual, spawn }
})
afterEach(async () => {
  const exits = await Promise.all(workerExits.splice(0))
  // Skill scans now run as commands inside the shared session worker (single-resident-worker
  // design §3.5), not their own short-lived workers, so every worker exit here is a session worker.
  expect(exits).toHaveLength(2)
  for (const exit of exits)
    expect(exit, `Worker ${exit.pid} must exit cleanly`).toMatchObject({ code: 0, signal: null })
})

// One shared Worker serves every live session; daemon restart starts its replacement. Each one
// assembles the production package graph from TypeScript source before it says hello, which takes
// about 30 s on a loaded hosted runner, so widen the startup window (and the SDK request budget
// that can wait on it) beyond that, and allow both generations plus fixture/RPC cleanup.
const sourceWorkerStartupMs = 90_000
const integrationTimeoutMs = sourceWorkerStartupMs * 2 + 10_000
it(
  'Web saves one profile, CLI executes it, both retain history after daemon restart',
  async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'au-'))
    const home = join(fixtureRoot, 'home')
    createPrivateDirectorySync(home)
    const work = join(home, 'work'),
      data = join(home, 'data')
    await mkdir(work)
    const requests: Array<{ model: string; authorization: string | undefined; path: string | undefined }> = []
    let availableModels = ['deepseek-flash']
    let held = false
    let releaseRequest!: () => void
    const requestBarrier = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })
    const upstream = createServer(async (req, res) => {
      if (!['Bearer fixture-key', 'Bearer replacement-key'].includes(req.headers.authorization ?? '')) {
        res.writeHead(401)
        res.end('invalid fixture credential')
        return
      }
      if (req.url?.endsWith('/models')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: availableModels.map((id) => ({ id })) }))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string }
      requests.push({ model: body.model, authorization: req.headers.authorization, path: req.url })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: body.model }
      res.write(
        `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: { role: 'assistant', content: 'Shared daemon works.' }, finish_reason: null }] })}\n\n`,
      )
      if (!held && JSON.stringify(body).includes('HOT_UPDATE_GATE')) {
        held = true
        await requestBarrier
      }
      res.end(
        `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`,
      )
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('missing provider address')
    const baseUrl = `http://127.0.0.1:${address.port}/v1`
    const configuration = createConfigurationService({ home, profile: 'local-dev' })
    const userBase = { name: 'local-dev', dataDir: data, cacheDir: join(home, 'cache') }
    const started: ResolvedProfile[] = []
    const start = async () => {
      const reloadProfile = async () =>
        resolveProfile(
          { builtin: 'local-dev', user: { ...userBase, ...(await configuration.profileInput()) } },
          { platform: createPlatform().snapshot(), agnesVersion: '0.0.0', now: new Date().toISOString() },
        )
      const profile = await reloadProfile()
      started.push(profile)
      const windows = createPlatform().snapshot().os === 'win32'
      const config = buildConfig({
        args: { profile: 'local-dev', dataDir: data },
        profile,
        home,
        ipc: windows ? 'pipe' : 'unix',
      })
      config.localWeb = { addr: '127.0.0.1:0', origin: 'http://127.0.0.1:4180' }
      config.limits = { ...config.limits, workerStartupMs: sourceWorkerStartupMs }
      if (windows) windowsEnsurePrivateDirectorySync(join(data, 'daemon'))
      else await mkdir(join(data, 'daemon'), { recursive: true, mode: 0o700 })
      const profileFile = join(data, 'daemon/profile.json')
      await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 })
      return startProductionSupervisor({
        config,
        profile,
        profileDir: join(home, 'profiles', 'local-dev'),
        profileFile,
        workspaceRoot: work,
        processIdentity,
        configuration,
        reloadProfile,
        workerExecArgv: ['--import', 'tsx'],
        workerEntry: fileURLToPath(new URL('../src/worker/main.ts', import.meta.url)),
      })
    }
    let daemon: Awaited<ReturnType<typeof start>> | undefined
    const clients: ReturnType<typeof createClient>[] = []
    try {
      daemon = await start()
      const ws = daemon.ws
      if (!ws) throw new Error('no Web listener')
      const web = createClient({
        journal: memoryJournal('web-setup'),
        auth: { kind: 'local' },
        timeouts: { request: sourceWorkerStartupMs },
        transportFactories: {
          ws: (option) =>
            wsTransport({ ...option, url: ws.url, headers: { Origin: 'http://127.0.0.1:4180' } }),
        },
        transport: { kind: 'ws', url: ws.url, protocols: ['agnes-v1', `agnes-bearer.${ws.token}`] },
      })
      const cli = createClient({
        journal: memoryJournal('cli-shared'),
        auth: { kind: 'local' },
        timeouts: { request: sourceWorkerStartupMs },
        transport: localSdkTransport(daemon.socketPath),
      })
      clients.push(web, cli)
      expect(await web.config.get()).toMatchObject({ configured: false, revision: 0 })
      expect(await web.config.test({ providerId: 'deepseek', baseUrl, apiKey: 'wrong-key' })).toMatchObject({
        verified: false,
      })
      expect(await cli.config.get()).toMatchObject({ configured: false, revision: 0 })
      expect(await web.config.test({ providerId: 'deepseek', baseUrl, apiKey: 'fixture-key' })).toMatchObject(
        {
          verified: true,
          models: [{ id: 'deepseek-flash' }],
        },
      )
      const saved = await web.config.save({
        providerId: 'deepseek',
        baseUrl,
        apiKey: 'fixture-key',
        model: 'deepseek-flash',
        expectedRevision: 0,
      })
      expect(saved).toMatchObject({ configured: true, effect: 'new-sessions' })
      expect(await cli.config.get()).toEqual(saved)
      expect(JSON.stringify(saved)).not.toContain('fixture-key')
      const session = await cli.session.new({ cwd: work })
      expect((await session.prompt('Say hello.')).reason).toBe('completed')
      expect(requests).toContainEqual({
        model: 'deepseek-flash',
        authorization: 'Bearer fixture-key',
        path: '/v1/chat/completions',
      })
      // The Web session list shows the platform's default preset for a session the CLI created.
      expect((await web.session.list({})).items.find((item) => item.sessionId === session.id)?.preset).toBe(
        createPlatform().snapshot().os === 'win32' ? 'standard-windows' : 'standard',
      )
      const same = await web.session.load(session.id, { cwd: work })
      expect(JSON.stringify(await same.projectUI(undefined, { surface: 'web' }))).toContain(
        'Shared daemon works.',
      )
      const inflight = session.prompt('HOT_UPDATE_GATE')
      await vi.waitFor(() => expect(held).toBe(true))
      const replacement = await web.config.save({
        providerId: 'deepseek',
        baseUrl,
        apiKey: 'replacement-key',
        model: 'deepseek-flash',
        expectedRevision: saved.revision,
      })
      // Existing shared Host adopts the verified model configuration without restarting.
      expect(replacement.effect).toBe('new-sessions')
      releaseRequest()
      expect((await inflight).reason).toBe('completed')
      expect(await cli.config.get()).toEqual(replacement)
      await expect(
        web.config.save({
          providerId: 'deepseek',
          baseUrl,
          apiKey: 'wrong-key',
          model: 'deepseek-flash',
          expectedRevision: replacement.revision,
        }),
      ).rejects.toBeDefined()
      expect(await cli.config.get()).toEqual(replacement)
      availableModels = ['deepseek-flash', 'deepseek-v4-pro']
      const added = await web.config.save({
        accountId: 'hot-added',
        providerId: 'deepseek',
        baseUrl: baseUrl.replace('/v1', '/v2'),
        apiKey: 'replacement-key',
        model: 'deepseek-v4-pro',
        expectedRevision: replacement.revision,
      })
      expect(added.effect).toBe('new-sessions')
      expect((await cli.apis()).profile.models).toContainEqual(
        expect.objectContaining({ route: 'account-hot-added', id: 'deepseek-v4-pro' }),
      )
      await same.setModel({ slot: 'primary', route: 'account-hot-added', model: 'deepseek-v4-pro' })
      expect((await same.prompt('Use the hot-added model.')).reason).toBe('completed')
      expect(requests.at(-1)).toMatchObject({
        model: 'deepseek-v4-pro',
        path: '/v2/chat/completions',
        authorization: 'Bearer replacement-key',
      })
      const changedDefault = await web.config.account({
        accountId: 'hot-added',
        action: 'default',
        expectedRevision: added.revision,
      })
      expect(changedDefault.effect).toBe('new-sessions')
      const newDefault = await cli.session.new({
        cwd: work,
        sessionKey: 'agnes:local:local-dev:cli:dm:hot-default',
      })
      expect((await newDefault.prompt('Use the new default.')).reason).toBe('completed')
      expect(requests.at(-1)?.model).toBe('deepseek-v4-pro')
      if (!saved.defaultAccountId || !saved.provider?.route)
        throw new Error('default fixture account missing')
      const resetDefault = await web.config.account({
        accountId: saved.defaultAccountId,
        action: 'default',
        expectedRevision: changedDefault.revision,
      })
      await newDefault.setModel({ slot: 'primary', route: 'account-hot-added', model: 'deepseek-v4-pro' })
      const disabled = await web.config.account({
        accountId: 'hot-added',
        action: 'disable',
        expectedRevision: resetDefault.revision,
      })
      expect(disabled.effect).toBe('new-sessions')
      expect((await cli.apis()).profile.models?.some((model) => model.route === 'account-hot-added')).toBe(
        false,
      )
      await expect(
        same.setModel({ slot: 'primary', route: 'account-hot-added', model: 'deepseek-v4-pro' }),
      ).rejects.toBeDefined()
      await same.setModel({ slot: 'primary', route: saved.provider.route, model: 'deepseek-flash' })
      const fresh = await cli.session.new({
        cwd: work,
        sessionKey: 'agnes:local:local-dev:cli:dm:replacement-profile',
      })
      expect((await fresh.prompt('Use new defaults.')).reason).toBe('completed')
      expect(requests.at(-1)?.authorization).toBe('Bearer replacement-key')
      await web.close()
      expect((await session.prompt('Once more.')).reason).toBe('completed')
      expect(requests.at(-1)?.authorization).toBe('Bearer replacement-key')
      await cli.close()
      await daemon.close()
      daemon = undefined
      daemon = await start()
      // The saved configuration restarts the daemon on a file-backed secret store, and the prompts
      // below authenticate with the key read back from it.
      expect(started.at(-1)?.adapters.secrets).toEqual({ kind: 'file', path: join(home, 'secrets') })
      const restored = createClient({
        journal: memoryJournal(),
        auth: { kind: 'local' },
        timeouts: { request: sourceWorkerStartupMs },
        transport: localSdkTransport(daemon.socketPath),
      })
      clients.push(restored)
      expect((await restored.session.list({})).items.some((item) => item.sessionId === session.id)).toBe(true)
      // A Web history reader knows only the durable session id after restart. The daemon must recover
      // its immutable workspace binding instead of treating the required ACP empty cwd as a new root.
      const unavailable = await restored.session.load(newDefault.id)
      await expect(
        unavailable.setModel({ slot: 'primary', route: 'account-hot-added', model: 'deepseek-v4-pro' }),
      ).rejects.toBeDefined()
      await unavailable.setModel({ slot: 'primary', route: saved.provider.route, model: 'deepseek-flash' })
      expect((await unavailable.prompt('Continue after replacing removed model.')).reason).toBe('completed')
      const loaded = await restored.session.load(session.id)
      expect(JSON.stringify(await loaded.projectUI(undefined, { surface: 'web' }))).toContain(
        'Shared daemon works.',
      )
      expect((await loaded.prompt('After restart.')).reason).toBe('completed')
      expect(requests.at(-1)?.authorization).toBe('Bearer replacement-key')
    } finally {
      releaseRequest()
      await Promise.all(clients.map((client) => client.close()))
      await daemon?.close()
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  },
  integrationTimeoutMs,
)
