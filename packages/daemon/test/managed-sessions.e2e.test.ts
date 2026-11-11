import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { managedServiceCapabilities } from '@agnes/extension-api'
import { initializeHome } from '@agnes/host'
import type { PackageOperationReceipt } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { expect, it } from 'vitest'
import { startLoopProvider } from './fixtures/loop-provider.js'
import { sourceTranspileCache } from './source-transpile-cache.js'

const sourceDaemon = fileURLToPath(new URL('./fixtures/source-loop-daemon.ts', import.meta.url))
const PACKAGE = '@acme/managed-probe'
const SERVICE = 'probe'
const ANSWER = 'Refund window is 30 days.'
const STEP_MS = 60_000

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), STEP_MS)
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

// The plugin runs inside the daemon's session worker, so the test drives its `init.sessions` port
// through request and reply files in a directory the plugin names; nothing else reaches it.
function pluginSource(exchange: string) {
  return `
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const exchange = ${JSON.stringify(exchange)}
const pending = new Set()
const reply = (id, body) => {
  writeFileSync(join(exchange, id + '.tmp'), JSON.stringify(body))
  renameSync(join(exchange, id + '.tmp'), join(exchange, 'res-' + id + '.json'))
}
async function answer(sessions, file) {
  const id = file.slice(4, -5)
  try {
    const { op, args } = JSON.parse(readFileSync(join(exchange, file), 'utf8'))
    reply(id, { ok: true, value: await sessions[op](...args) })
  } catch (error) {
    reply(id, { ok: false, error: { message: String(error?.message), code: error?.code, data: error?.data } })
  }
}
export const main = {
  inject: ['profileRuntime'],
  apply(ctx) {
    ctx.profileRuntime.register({
      id: ${JSON.stringify(SERVICE)},
      configSchema: { type: 'object', properties: {}, additionalProperties: false },
      defaultConfig: {},
      async start(init) {
        const timer = setInterval(() => {
          for (const file of readdirSync(exchange))
            if (file.startsWith('req-') && !pending.has(file)) {
              pending.add(file)
              void answer(init.sessions, file)
            }
        }, 50)
        init.onShutdown(async () => {
          clearInterval(timer)
          return { state: 'settled' }
        })
        init.ready()
        return {}
      },
    })
  },
}
`
}

function writePlugin(directory: string, exchange: string) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: PACKAGE,
      version: '1.0.0',
      license: 'MIT',
      type: 'module',
      exports: './index.mjs',
      agnes: {
        provides: ['bundle'],
        plugins: [
          {
            id: 'ext:acme/managed-probe/main',
            export: 'main',
            apiRange: '^5.0.0',
            runtime: 'in-process',
            inject: ['profileRuntime'],
            capabilities: {
              store: true,
              managedServices: [
                {
                  id: SERVICE,
                  scope: 'profile',
                  artifact: { kind: 'in-process' },
                  healthPath: '/health',
                  listeners: [],
                  startupTimeoutMs: 30_000,
                  shutdownTimeoutMs: 5_000,
                  apiVersion: '1.0.0',
                  requires: [],
                  sessions: true,
                },
              ],
              services: managedServiceCapabilities(SERVICE, {
                type: 'object',
                properties: {},
                additionalProperties: false,
              }),
            },
          },
        ],
        bundles: {
          worker: {
            presets: {
              'probe-worker': { name: 'probe-worker', extends: 'standard', surfaces: ['daemon', 'sdk'] },
            },
            launch: {
              title: { en: 'Probe worker' },
              description: { en: 'Runs one task for the managed-session end-to-end test.' },
              preset: 'probe-worker',
            },
          },
        },
      },
    }),
  )
  writeFileSync(join(directory, 'index.mjs'), pluginSource(exchange))
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

it.skipIf(process.platform === 'win32')(
  'runs a plugin-managed session turn and reports a refused workspace reason to the plugin',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-managed-sessions-')))
    const exchange = join(root, 'exchange')
    const workspace = join(root, 'managed-workspace')
    const pluginDirectory = join(root, 'plugin')
    const provider = await startLoopProvider()
    initializeHome(root, 'local-dev')
    mkdirSync(exchange)
    mkdirSync(workspace)
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
    let sdk: ReturnType<typeof createClient> | undefined
    let socketPath: string | undefined
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
      await client.workspace.add(workspace)

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
      expect(preview.blockers, 'the managed-session plugin installs without blockers').toEqual([])
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
      await client.session.new({ cwd: root })

      const asPlugin = async (op: string, ...args: unknown[]) => {
        const id = randomUUID()
        const request = join(exchange, `${id}.tmp`)
        writeFileSync(request, JSON.stringify({ op, args }))
        renameSync(request, join(exchange, `req-${id}.json`))
        const file = join(exchange, `res-${id}.json`)
        const deadline = Date.now() + STEP_MS
        for (;;) {
          try {
            return JSON.parse(readFileSync(file, 'utf8')) as {
              ok: boolean
              value?: { sessionId: string; events?: { kind: string; status?: string; text?: string }[] }
              error?: { message: string; code?: number; data?: { code?: string; reason?: string } }
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            if (Date.now() > deadline) throw new Error(`plugin did not answer ${op}`)
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
        }
      }
      const startInput = {
        bundle: `${PACKAGE}#worker`,
        workspace,
        input: 'Summarize the refund window.',
        startKey: 'task-1',
        retention: 'task',
      }

      const refused = await asPlugin('start', startInput)
      expect(refused.ok, 'a start in an ungranted workspace is refused').toBe(false)
      expect(refused.error?.data, 'the refusal reaches the plugin with its reason').toMatchObject({
        reason: 'WORKSPACE_NOT_AUTHORIZED',
      })

      const grant = await client.request('_agnes/v1/admin.managedWorkspaces.grant', {
        packageId: PACKAGE,
        workspace,
      })
      expect(grant, 'the owner grants the workspace over the admin connection').toMatchObject({
        packageId: PACKAGE,
        changed: true,
      })

      const started = await asPlugin('start', startInput)
      expect(started.ok, `start after the grant: ${JSON.stringify(started.error)}`).toBe(true)
      const sessionId = started.value?.sessionId
      if (!sessionId) throw new Error('start returned no session id')
      const answered = async () => (await asPlugin('result', sessionId)).value
      const waitForTurns = async (completed: number) => {
        const deadline = Date.now() + STEP_MS
        for (;;) {
          const events = (await asPlugin('events', sessionId)).value?.events ?? []
          const turns = events.filter(
            (event: { kind: string; status?: string }) =>
              event.kind === 'turn' && event.status === 'completed',
          )
          if (turns.length >= completed) return events
          if (Date.now() > deadline)
            throw new Error(`managed session ran ${turns.length} of ${completed} turns`)
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      const firstEvents = await waitForTurns(1)
      expect(
        firstEvents.some(
          (event: { kind: string; text?: string }) => event.kind === 'text' && event.text?.includes(ANSWER),
        ),
        'the first input ran a turn whose assistant text reached the plugin events',
      ).toBe(true)
      expect(await answered(), 'the plugin reads the turn result').toMatchObject({
        turn: { status: 'completed' },
        text: ANSWER,
      })

      const sent = await asPlugin('send', sessionId, {
        text: 'And the shipping window?',
        idempotencyKey: 'send-1',
      })
      expect(sent.value, 'a send to the idle session is accepted').toEqual({ state: 'started' })
      await waitForTurns(2)
      expect(provider.requests.filter((request) => request.includes('shipping window'))).not.toHaveLength(0)
    } catch (error) {
      failures.push(new Error(`${String(error)}\nSource daemon stderr:\n${stderr}`, { cause: error }))
    } finally {
      for (const close of [
        () => sdk?.close(),
        () => stop(daemon, exited),
        () => provider.close(),
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
    if (failures.length > 1) throw new AggregateError(failures, 'managed session e2e and cleanup failed')
  },
  150_000,
)
