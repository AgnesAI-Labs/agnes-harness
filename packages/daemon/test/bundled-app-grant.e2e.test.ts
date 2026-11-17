import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { managedServiceCapabilities } from '@agnes/extension-api'
import { initializeHome } from '@agnes/host'
import type { PackageOperationReceipt } from '@agnes/protocol'
import { type Client, createClient, memoryJournal } from '@agnes/sdk'
import { expect, it } from 'vitest'
import { bundledAppClient } from '../src/superagent/grant.js'
import { startLoopProvider } from './fixtures/loop-provider.js'
import { sourceTranspileCache } from './source-transpile-cache.js'

const sourceDaemon = fileURLToPath(new URL('./fixtures/source-loop-daemon.ts', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/bundled-app/', import.meta.url))
const PACKAGE = '@acme/bundled-app-probe'
const STEP_MS = 60_000
const QUIET_MS = 5_000

async function bounded<T>(promise: Promise<T>, label: string, ms = STEP_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function stop(child: ChildProcess, exited: Promise<number | null>) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    expect(await bounded(exited, 'daemon shutdown')).toBe(0)
  } catch (error) {
    child.kill('SIGKILL')
    await exited
    throw error
  }
}

function writePlugin(directory: string, exchange: string) {
  mkdirSync(directory, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'))
  const capabilities = manifest.agnes.plugins[0].capabilities
  capabilities.services = managedServiceCapabilities('app', {
    type: 'object',
    properties: {},
    additionalProperties: false,
  })
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
  writeFileSync(
    join(directory, 'index.mjs'),
    readFileSync(join(fixture, 'index.mjs'), 'utf8').replace("'__EXCHANGE__'", JSON.stringify(exchange)),
  )
}

function writeProfile(root: string, baseUrl: string) {
  const secretDir = join(root, 'secrets')
  mkdirSync(join(secretDir, 'fixture'), { recursive: true, mode: 0o700 })
  writeFileSync(join(secretDir, 'fixture', 'model'), 'synthetic-loop-fixture', { mode: 0o600 })
  const model = {
    id: 'loop-script',
    name: 'Scripted loop fixture',
    route: 'loop-fixture',
    api: 'openai-completions',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    toolCallFormats: ['native'],
    thinkingReplay: 'drop',
    contract_id: null,
  }
  writeFileSync(
    join(root, 'profiles', 'local-dev', 'profile.yaml'),
    JSON.stringify({
      name: 'local-dev',
      cacheDir: sourceTranspileCache(),
      computerUse: { enabled: false },
      adapters: { secrets: { kind: 'file', path: secretDir } },
      provider: {
        package: '@agnes/ai',
        catalog: { include: [] },
        routes: [
          {
            route: model.route,
            api: 'openai-completions',
            baseUrl,
            credentialRef: 'secret://fixture/model',
            models: [model],
          },
        ],
      },
    }),
  )
}

type ProbeEvent = { at: number; kind: string; sessionId?: string; mode?: string; child?: number } & Record<
  string,
  unknown
>
const events = (exchange: string): ProbeEvent[] => {
  try {
    return readFileSync(join(exchange, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + STEP_MS
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`${label} timed out`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

it.skipIf(process.platform === 'win32')(
  'an in-process plugin tool reaches its own managed service and stops with the plugin',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-bundled-app-')))
    const exchange = join(root, 'exchange')
    const pluginDirectory = join(root, 'plugin')
    const provider = await startLoopProvider({
      toolProbes: {
        BUNDLED_APP_ECHO_PROBE: { name: 'app_probe', arguments: { mode: 'echo' } },
        BUNDLED_APP_WAIT_PROBE: { name: 'app_probe', arguments: { mode: 'wait' } },
      },
    })
    initializeHome(root, 'local-dev')
    mkdirSync(exchange)
    writeProfile(root, provider.baseUrl)
    writePlugin(pluginDirectory, exchange)
    const daemon = spawn(process.execPath, ['--import', 'tsx', sourceDaemon, root, root], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), AGH_HOME: root },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve))
    let stderr = ''
    const ready = new Promise<void>((resolve, reject) => {
      daemon.once('error', reject)
      daemon.stderr?.on('data', (data) => {
        stderr += String(data)
        if (stderr.includes('agnesd listening on ')) resolve()
      })
      daemon.once('exit', (code) => reject(new Error(`source daemon exited ${code}: ${stderr}`)))
    })
    let sdk: Client | undefined
    let socketPath: string | undefined
    let probeChild: number | undefined
    const failures: unknown[] = []
    try {
      await bounded(ready, 'source daemon boot')
      const owner = JSON.parse(readFileSync(join(root, 'daemon', 'owner.json'), 'utf8'))
      socketPath = owner.socketPath
      const client = createClient({
        journal: memoryJournal(),
        auth: { kind: 'local' },
        transport: { kind: 'unix', path: owner.socketPath },
        timeouts: { request: STEP_MS },
      })
      sdk = client
      await client.initialize()

      // The backend-owned bundled-application client reaches this daemon as its owner.
      const discovery = JSON.parse(readFileSync(join(root, 'daemon', 'discovery.json'), 'utf8'))
      const scope = { home: root, profile: 'local-dev', dataDir: discovery.dataDir, workspace: root }
      const appState = join(root, 'app-state')
      mkdirSync(appState, { mode: 0o700 })
      const fence = new AbortController()
      let current = true
      const lease = bundledAppClient({
        scope,
        stateDirectory: appState,
        clientId: 'bundled-app:@acme/bundled-app-probe/app',
        signal: fence.signal,
        assertCurrent: () => {
          if (!current) throw new Error('retired')
        },
      })
      const app = lease.client as Client
      await bounded(app.initialize(), 'bundled app client initialize')
      expect(await app.clientId()).toBe('bundled-app:@acme/bundled-app-probe/app')
      expect(existsSync(join(appState, 'sdk', 'journal.json')), 'journal lives under <state>/sdk').toBe(true)
      const owned = await app.session.new({ cwd: root, sessionKey: 'bundled-app-owner' })
      expect(owned.id, 'the owner client creates sessions').toBeTruthy()
      await lease.close()
      expect(app.connectionState).toBe('closed')
      current = false
      const retired = bundledAppClient({
        scope,
        stateDirectory: appState,
        clientId: 'bundled-app:@acme/bundled-app-probe/app',
        signal: fence.signal,
        assertCurrent: () => {
          if (!current) throw new Error('retired')
        },
      })
      await expect(
        bounded((retired.client as Client).initialize(), 'retired initialize', 10_000),
        'a retired grant never reconnects',
      ).rejects.toThrow()
      await retired.close()

      const operation = async (receipt: PackageOperationReceipt) => {
        const deadline = Date.now() + STEP_MS
        while (Date.now() < deadline) {
          const result = await client.packages.operation.get({
            profile: receipt.profile,
            operationId: receipt.operationId,
          })
          if (result.state === 'completed') return result
          if (['failed', 'cancelled', 'rolled-back'].includes(result.state))
            throw new Error(`package ${result.operation}: ${JSON.stringify(result.error)}`)
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        throw new Error(`package ${receipt.operationId} timed out`)
      }
      const command = async () => ({
        profile: 'local-dev',
        clientId: await client.clientId(),
        commandId: randomUUID(),
      })
      const source = { type: 'file' as const, ref: `file:${pluginDirectory}` }
      const inspection = await operation(await client.packages.inspect({ ...(await command()), source }))
      const preview = inspection.preview
      if (!preview?.capabilityHash) throw new Error('plugin preview has no capability hash')
      expect(preview.blockers, 'the probe plugin installs without blockers').toEqual([])
      await operation(
        await client.packages.install({ ...(await command()), source, expectedIntegrity: preview.integrity }),
      )
      await operation(
        await client.packages.trust({
          ...(await command()),
          id: PACKAGE,
          expectedIntegrity: preview.integrity,
          capabilityHash: preview.capabilityHash,
        }),
      )
      await operation(await client.packages.enable({ ...(await command()), id: PACKAGE }))
      const started = await until(
        () => events(exchange).find((event) => event.kind === 'started'),
        'managed service start',
      )
      probeChild = started.child
      expect(JSON.parse(readFileSync(join(exchange, 'db.json'), 'utf8'))).toEqual({ opened: true })

      // The tool gets the service from its own handle, with the calling session and a live signal.
      const echoSession = await client.session.new({ cwd: root, sessionKey: 'bundled-app-echo' })
      const echoTurn = await bounded(echoSession.prompt('BUNDLED_APP_ECHO_PROBE'), 'echo turn')
      expect(echoTurn.reason).toBe('completed')
      expect(events(exchange).filter((event) => event.kind === 'call')).toEqual([
        expect.objectContaining({ sessionId: echoSession.id, mode: 'echo', signal: true, aborted: false }),
      ])
      expect(
        provider.requests.some((request) => request.includes(`service answered ${echoSession.id}`)),
        'the service result reaches the next model request',
      ).toBe(true)

      // The tool's abort signal reaches the service when the turn is cancelled.
      const waitSession = await client.session.new({ cwd: root, sessionKey: 'bundled-app-wait' })
      const waiting = waitSession.prompt('BUNDLED_APP_WAIT_PROBE')
      void waiting.catch(() => undefined)
      await until(
        () => events(exchange).find((event) => event.kind === 'call' && event.mode === 'wait'),
        'waiting tool call',
      )
      await bounded(waitSession.cancel(), 'cancel acknowledgement')
      expect((await bounded(waiting, 'cancelled turn')).reason).toBe('aborted')
      expect(
        await until(
          () => events(exchange).find((event) => event.kind === 'aborted'),
          'service observes cancellation',
        ),
      ).toMatchObject({ sessionId: waitSession.id })

      // Disabling the plugin stops its service: no callbacks and no child process afterwards.
      await operation(await client.packages.disable({ ...(await command()), id: PACKAGE }))
      await until(
        () => events(exchange).find((event) => event.kind === 'shutdown'),
        'service shutdown on disable',
      )
      const settled = events(exchange).length
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS))
      expect(events(exchange).slice(settled), 'no callbacks after disable').toEqual([])
      expect(probeChild !== undefined && alive(probeChild), 'no child process after disable').toBe(false)
    } catch (error) {
      failures.push(new Error(`${String(error)}\nSource daemon stderr:\n${stderr}`, { cause: error }))
    } finally {
      for (const close of [
        () => sdk?.close(),
        () => stop(daemon, exited),
        () => provider.close(),
        () => {
          if (probeChild !== undefined && alive(probeChild)) process.kill(probeChild, 'SIGKILL')
        },
        () => {
          rmSync(root, { recursive: true, force: true })
          if (socketPath) rmSync(dirname(socketPath), { recursive: true, force: true })
        },
      ]) {
        try {
          await close()
        } catch (error) {
          failures.push(error)
        }
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'bundled app e2e and cleanup failed')
  },
  180_000,
)
