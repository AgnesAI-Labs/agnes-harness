import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { managedServiceCapabilities } from '@agnes/extension-api'
import type { PackageOperationReceipt } from '@agnes/protocol'
import type { createClient } from '@agnes/sdk'
import { sourceTranspileCache } from '../source-transpile-cache.js'

export const PACKAGE = '@acme/managed-probe'
const SERVICE = 'probe'
export const STEP_MS = 60_000

export async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
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

/** A source daemon child with its exit and its stderr, ready once it logs its listening line. */
export function spawnDaemon(entry: string, args: readonly string[], root: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
    env: { PATH: process.env.PATH, TMPDIR: tmpdir(), AGH_HOME: root },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  const output = { stderr: '' }
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.stderr?.on('data', (data) => {
      output.stderr += String(data)
      if (output.stderr.includes('agnesd listening on ')) resolve()
    })
    child.once('exit', (code) => reject(new Error(`source daemon exited ${code}: ${output.stderr}`)))
  })
  return { child, exited, ready, output }
}

export async function stopDaemon(child: ChildProcess, exited: Promise<number | null>) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    const code = await bounded(exited, 'daemon shutdown')
    if (code !== 0) throw new Error(`daemon exited ${code}`)
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
import { join } from 'node:path'
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

export function writePlugin(directory: string, exchange: string) {
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

export function writeProfile(root: string, baseUrl: string) {
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

/** Inspects, installs, trusts and enables the probe plugin from its directory. */
export async function installProbe(client: ReturnType<typeof createClient>, pluginDirectory: string) {
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
  const preview = (await operation(await client.packages.inspect({ ...(await command()), source }))).preview
  if (!preview?.capabilityHash) throw new Error('plugin preview has no capability hash')
  if (preview.blockers.length) throw new Error(`plugin blockers: ${JSON.stringify(preview.blockers)}`)
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
}

export type PluginReply = {
  ok: boolean
  value?: {
    sessionId?: string
    state?: string
    events?: { kind: string; status?: string; text?: string }[]
  }
  error?: { message: string; code?: number; data?: { code?: string; reason?: string } }
}

/** Calls the plugin's `init.sessions[op]` through the exchange directory and waits for its reply. */
export function pluginCaller(exchange: string) {
  return async (op: string, ...args: unknown[]): Promise<PluginReply> => {
    const id = randomUUID()
    const request = join(exchange, `${id}.tmp`)
    writeFileSync(request, JSON.stringify({ op, args }))
    renameSync(request, join(exchange, `req-${id}.json`))
    const file = join(exchange, `res-${id}.json`)
    const deadline = Date.now() + STEP_MS
    for (;;) {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as PluginReply
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (Date.now() > deadline) throw new Error(`plugin did not answer ${op}`)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }
}
