import { closeSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlatform, resolveProfile } from '@agnes/host'
import { createClient, memoryJournal, wsTransport } from '@agnes/sdk'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { buildConfig, DEFAULT_LIMITS } from '../src/config.js'
import { startProductionSupervisor } from '../src/supervisor/supervisor.js'

const sourceAssemblyRequestTimeoutMs = DEFAULT_LIMITS.workerStartupMs * 3
const integrationTimeoutMs = sourceAssemblyRequestTimeoutMs + DEFAULT_LIMITS.shutdownGraceMs + 10_000
const processIdentity = async (pid: number) =>
  pid === process.pid
    ? ({ state: 'alive', startId: 'local-web-production' } as const)
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
  expect(exits).toHaveLength(1)
  for (const exit of exits)
    expect(exit, `Web Worker ${exit.pid} must exit cleanly`).toMatchObject({ code: 0, signal: null })
})

it(
  'local Web creates and projects a session using production worker package assembly',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agnes-web-real-'))
    const work = join(dir, 'work')
    await mkdir(work)
    const data = join(dir, 'data')
    const secretDir = join(dir, 'secrets')
    createPrivateDirectorySync(secretDir)
    createPrivateDirectorySync(join(secretDir, 'test'))
    const credential = createPrivateFileSync(join(secretDir, 'test/key'))
    try {
      writeFileSync(credential, 'fixture-not-a-real-key')
    } finally {
      closeSync(credential)
    }
    const profile = await resolveProfile(
      {
        builtin: 'local-dev',
        user: {
          name: 'local-dev',
          dataDir: data,
          cacheDir: join(dir, 'cache'),
          adapters: { secrets: { kind: 'file', path: secretDir } },
          provider: {
            package: '@agnes/ai',
            adapters: ['@agnes/ai'],
            routes: [
              {
                route: 'test',
                api: 'openai-completions',
                baseUrl: 'https://invalid.test',
                credentialRef: 'secret://test/key',
                models: [
                  {
                    id: 'test-model',
                    name: 'Test model',
                    api: 'openai-completions',
                    route: 'test',
                    baseUrl: 'https://invalid.test',
                    reasoning: false,
                    input: ['text'],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 1024,
                    toolCallFormats: ['native'],
                    thinkingReplay: 'native',
                    contract_id: null,
                  },
                ],
              },
            ],
          },
        },
      },
      { platform: createPlatform().snapshot(), agnesVersion: '0.0.0', now: new Date().toISOString() },
    )
    const config = buildConfig({
      args: { profile: 'local-dev', dataDir: dir },
      profile,
      home: dir,
      ipc: createPlatform().snapshot().os === 'win32' ? 'pipe' : 'unix',
    })
    const localWeb = { addr: '127.0.0.1:0', origin: 'http://127.0.0.1:4180' }
    config.localWeb = localWeb
    await mkdir(join(data, 'daemon'), { recursive: true, mode: 0o700 })
    const profileFile = join(data, 'daemon/profile.json')
    await writeFile(profileFile, JSON.stringify(profile))
    const daemon = await startProductionSupervisor({
      config,
      profile,
      profileDir: join(dir, 'profiles', 'local-dev'),
      profileFile,
      workspaceRoot: work,
      processIdentity,
      workerExecArgv: ['--import', 'tsx'],
      workerEntry: fileURLToPath(new URL('../src/worker/main.ts', import.meta.url)),
    })
    if (!daemon.ws) throw new Error('missing Web listener')
    const sdk = createClient({
      journal: memoryJournal(),
      auth: { kind: 'local' },
      // This test boots the production package graph through tsx from source. On a cold Windows
      // transform cache that work can outlive the SDK's ordinary request budget after the worker
      // has already sent hello. Use the same bounded three-startup-window allowance as the other
      // source-level production-server integration test.
      timeouts: { request: sourceAssemblyRequestTimeoutMs },
      transportFactories: {
        ws: (option) =>
          wsTransport({ ...option, url: daemon.ws?.url ?? '', headers: { Origin: localWeb.origin } }),
      },
      transport: {
        kind: 'ws',
        url: daemon.ws.url,
        protocols: ['agnes-v1', `agnes-bearer.${daemon.ws.token}`],
      },
    })
    try {
      await sdk.initialize()
      const session = await sdk.session.new({ cwd: work })
      expect((await sdk.session.list({})).items[0]?.preset).toBe(
        createPlatform().snapshot().os === 'win32' ? 'standard-windows' : 'standard',
      )
      expect(await session.projectUI(undefined, { surface: 'web' })).toBeDefined()
    } finally {
      await sdk.close()
      await daemon.close()
      await rm(dir, { recursive: true, force: true })
    }
    // The full lifecycle must accommodate both independent product deadlines and local setup.
  },
  integrationTimeoutMs,
)
