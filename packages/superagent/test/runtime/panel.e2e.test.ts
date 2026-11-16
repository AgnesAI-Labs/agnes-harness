import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeHome } from '@agnes/host'
import type { PackageOperationReceipt } from '@agnes/protocol'
import { type Client, createClient, memoryJournal } from '@agnes/sdk'
import { expect, it } from 'vitest'
import { Store } from '../../src/app/store.js'
import { SettingsSchema } from '../../src/policy.js'
import { hostFloor, socketDirectoryOf } from '../fixtures/daemon-harness.js'

// The panel on a real source daemon: the shipped payload's browser module is rostered with its services, and the panel
// services answer from the plugin's own database through the Host's query and effect paths.
const sourceDaemon = fileURLToPath(
  new URL('../../../daemon/test/fixtures/source-loop-daemon.ts', import.meta.url),
)
const payloadDirectory = fileURLToPath(
  new URL('../../../package-manager/bundled-plugins/superagent/', import.meta.url),
)
const PROFILE = 'local-dev'
const PACKAGE = '@agnes/superagent'
const ROW = 'ext:agnes.superagent/main'
const EXTENSION = `plugin/${createHash('sha256').update(ROW).digest('hex').slice(0, 16)}`
const STEP_MS = 60_000
const TICKET = 't-e2e'

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
async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + STEP_MS
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`${label} timed out`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

function writeProfile(root: string) {
  const usage = {
    type: 'usage',
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    creditSource: 'estimated',
  }
  writeFileSync(
    join(root, 'profiles', PROFILE, 'profile.yaml'),
    JSON.stringify({
      name: PROFILE,
      computerUse: { enabled: false },
      limits: { 'worker.startup_ms': 120_000 },
      adapters: { secrets: { kind: 'file', path: join(root, 'secrets') } },
      provider: {
        package: '@agnes/ai',
        catalog: { include: [] },
        routes: [
          {
            route: 'main',
            api: 'scripted',
            baseUrl: 'https://scripted.invalid',
            compat: {
              replies: [[{ type: 'text_delta', delta: 'Done.' }, usage, { type: 'done', reason: 'stop' }]],
              repeatLast: true,
            },
            models: [
              {
                id: 'main-1',
                name: 'main-1',
                route: 'main',
                api: 'scripted',
                baseUrl: 'https://scripted.invalid',
                reasoning: false,
                input: ['text'],
                contextWindow: 200000,
                maxTokens: 8192,
                toolCallFormats: ['native'],
                thinkingReplay: 'drop',
                contract_id: null,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        ],
      },
    }),
  )
}

/** A GitHub ticket as the Engine leaves it once it ran: a listed sender's request, accepted, dispatched and reported. */
function seedTicket(databasePath: string) {
  const at = new Date().toISOString()
  const store = new Store(databasePath)
  try {
    store.saveSettings(
      SettingsSchema.parse({
        policy: {
          sources: { github: { allowed: [{ id: 'alice' }] } },
          rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix copy' }],
        },
      }),
    )
    store.threads.save({
      key: 'github:42',
      ref: { source: 'github', id: '42' },
      createdAt: at,
      subscriptions: [],
      correlated: [],
      pending: [],
      meta: {},
    })
    store.triggers.save({
      id: 'github:42:c1',
      source: 'github',
      threads: [{ source: 'github', id: '42' }],
      actor: { source: 'github', id: 'alice' },
      human: true,
      addressed: 'mention',
      at,
      text: '@agent please fix the typo in the README',
      meta: {},
    })
    store.decisions.save({
      id: 'd-e2e',
      evalId: 'eval-1',
      threadKey: 'github:42',
      triggerIds: ['github:42:c1'],
      policyVersion: 'v',
      at,
      kind: 'accept',
      reason: [{ code: 'explicitRouted' }],
      strength: 'explicit',
      ticketId: TICKET,
    })
    store.tickets.save({
      id: TICKET,
      title: 'Fix the README typo',
      decisionId: 'd-e2e',
      channels: [],
      undelivered: [],
      createdAt: at,
      updatedAt: at,
      mandate: {
        strength: 'explicit',
        policyVersion: 'v',
        basis: { via: 'listed', sender: 'alice', addressed: 'mention' },
        actor: { source: 'github', id: 'alice' },
        scope: 'README only',
      },
      origin: { triggerId: 'github:42:c1', triggerIds: ['github:42:c1'] },
      assignments: [
        {
          id: 'a1',
          state: 'running',
          createdAt: at,
          startedAt: at,
          report: { state: 'ready', summary: 'Opened the pull request', at },
        },
      ],
      inputs: [],
    })
  } finally {
    store.close()
  }
}

it('the panel module is rostered and its services answer a seeded GitHub ticket through the Host', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-superagent-panel-')))
  try {
    initializeHome(root, PROFILE)
    writeProfile(root)
  } catch (error) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    throw error
  }
  const daemon: ChildProcess = spawn(process.execPath, ['--import', 'tsx', sourceDaemon, root, root], {
    env: { ...hostFloor(), PATH: process.env.PATH, TMPDIR: tmpdir(), AGH_HOME: root },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve))
  let stderr = ''
  const ready = new Promise<void>((resolve, reject) => {
    daemon.once('error', reject)
    daemon.stderr?.on('data', (data) => {
      stderr = (stderr + String(data)).slice(-64 * 1024)
      if (stderr.includes('agnesd listening on ')) resolve()
    })
    daemon.once('exit', (code) => reject(new Error(`source daemon exited ${code}`)))
  })
  let sdk: Client | undefined
  let socketDirectory: string | undefined
  const failures: unknown[] = []
  try {
    await bounded(ready, 'source daemon boot')
    const owner = JSON.parse(readFileSync(join(root, 'daemon', 'owner.json'), 'utf8'))
    socketDirectory = socketDirectoryOf(owner.socketPath, root)
    const client = createClient({
      journal: memoryJournal(),
      auth: { kind: 'local' },
      transport: { kind: 'unix', path: owner.socketPath },
      timeouts: { request: STEP_MS },
    })
    sdk = client
    await bounded(client.initialize(), 'SDK initialize')

    const operation = async (receipt: PackageOperationReceipt) =>
      until(async () => {
        const result = await client.packages.operation.get(receipt)
        if (['failed', 'cancelled', 'rolled-back'].includes(result.state))
          throw new Error(`package ${result.operation}: ${JSON.stringify(result.error)}`)
        return result.state === 'completed' ? result : undefined
      }, `package ${receipt.operationId}`)
    const common = async (step: string) => ({
      profile: PROFILE,
      clientId: await client.clientId(),
      commandId: `superagent-panel-${step}`,
    })
    const source = { type: 'file' as const, ref: 'file:./bundled-plugins/superagent' }
    const preview = (await operation(await client.packages.inspect({ ...(await common('inspect')), source })))
      .preview
    if (!preview?.capabilityHash) throw new Error('the payload preview has no capability hash')
    expect(preview.blockers, 'the shipped payload, panel included, installs without blockers').toEqual([])
    await operation(
      await client.packages.install({
        ...(await common('install')),
        source,
        expectedIntegrity: preview.integrity,
      }),
    )
    await operation(
      await client.packages.trust({
        ...(await common('trust')),
        id: PACKAGE,
        expectedIntegrity: preview.integrity,
        capabilityHash: preview.capabilityHash,
      }),
    )
    await operation(await client.packages.enable({ ...(await common('enable')), id: PACKAGE }))
    await until(async () => {
      const result = await client.extensions
        .callScoped({ extension: EXTENSION, service: 'superagent.status', input: {} })
        .catch(() => undefined)
      const output = result?.output as { state?: string } | undefined
      if (output?.state === 'failed') throw new Error(`managed service failed: ${JSON.stringify(output)}`)
      return output?.state === 'ready' ? output : undefined
    }, 'managed service ready')

    // The browser module: rostered for the profile with the panel services, and served as the shipped bytes.
    const descriptor = JSON.parse(
      readFileSync(join(payloadDirectory, 'src', 'agnes.client.json'), 'utf8'),
    ) as {
      client: { services: string[] }
    }
    expect(descriptor.client.services).toHaveLength(25)
    const roster = await client.clientModules.list(PROFILE)
    const row = roster.rows.find((item) => item.packageId === PACKAGE)
    expect(row).toMatchObject({
      enabled: true,
      phase: 'ready',
      services: [...descriptor.client.services].sort(),
      binding: { lifetime: 'profile' },
    })
    if (!row?.entryUrl) throw new Error('installed browser entry unavailable')
    const asset = await client.clientModules.read(PROFILE, row.entryUrl)
    if (!asset.found) throw new Error('installed browser bytes unavailable')
    expect(Buffer.from(asset.base64, 'base64').toString()).toBe(
      readFileSync(join(payloadDirectory, 'src', 'client.js'), 'utf8'),
    )
    // Its stylesheet is a file the page loads (the page's CSP refuses an inline <style>), served as the panel's own.
    const [styleUrl, ...extra] = row.styleUrls ?? []
    expect({ styleUrl: !!styleUrl, extra }).toEqual({ styleUrl: true, extra: [] })
    if (!styleUrl) throw new Error('panel stylesheet not rostered')
    const sheet = await client.clientModules.read(PROFILE, styleUrl)
    if (!sheet.found) throw new Error('installed panel stylesheet unavailable')
    expect(Buffer.from(sheet.base64, 'base64').toString()).toBe(
      readFileSync(new URL('../../../superagent-ui/src/superagent.css', import.meta.url), 'utf8'),
    )

    // The service writes its database in the directory the platform chose; a ticket seeded there is what the panel
    // services read back (no part of the plugin that runs tickets is wired on this branch).
    const { dataDir } = JSON.parse(readFileSync(join(root, 'daemon', 'discovery.json'), 'utf8'))
    const appRoot = join(dataDir, 'bundled-apps')
    const states = readdirSync(appRoot).filter((name) => existsSync(join(appRoot, name, 'superagent.sqlite')))
    expect(states).toHaveLength(1)
    seedTicket(join(appRoot, states[0] as string, 'superagent.sqlite'))

    const query = async (service: string, input: Record<string, unknown> = {}) =>
      (await client.extensions.callScoped({ extension: EXTENSION, service, input: input as never })) as {
        output: Record<string, unknown>
      }
    const overview = (await query('superagent.overview')).output as { person: { id: string }[] }
    expect(overview).not.toHaveProperty('failure')
    expect(overview.person.map((ticket) => ticket.id)).toContain(TICKET)
    const listed = (await query('superagent.tickets.list', { state: 'open' })).output as {
      items: { id: string }[]
    }
    expect(listed.items.map((ticket) => ticket.id)).toEqual([TICKET])
    const detail = (await query('superagent.tickets.get', { id: TICKET })).output as {
      id: string
      mandate: { actor: { id: string }; strength: string; scope: string }
      basis: { facts: { name: string; value?: unknown }[]; legacy: boolean }
      assignments: { id: string; state: string; report: { state: string; summary: string } }[]
      decision: { kind: string }
      threads: { key: string }[]
    }
    // The ticket, the authorization it runs under, and its dispatch record.
    expect(detail).toMatchObject({
      id: TICKET,
      mandate: { actor: { id: 'alice' }, strength: 'explicit', scope: 'README only' },
      assignments: [
        { id: 'a1', state: 'running', report: { state: 'ready', summary: 'Opened the pull request' } },
      ],
      decision: { kind: 'accept' },
      basis: {
        facts: [
          { name: 'sender', value: 'alice' },
          { name: 'addressed', value: 'mention' },
        ],
        legacy: false,
      },
    })
    expect(JSON.stringify(detail)).not.toContain('"ref":"superagent:worker:')

    // A failure stays a result with the route's status and body, not an unknown outcome or a transport error.
    const missing = (await query('superagent.tickets.get', { id: 'nope' })).output
    expect(missing).toEqual({ failure: { status: 404, error: 'Ticket not found' } })
    await expect(query('superagent.tickets.get', { id: TICKET, extra: true })).rejects.toThrow()

    // An effect needs no approval from the owner acting in their own panel. The panel is wired with the engine from
    // the start, so a retry of a ticket whose assignment still runs is refused by the engine (400), as a completed
    // effect rather than an unknown outcome.
    const receipt = await client.extensions.callScoped({
      extension: EXTENSION,
      service: 'superagent.tickets.retry',
      input: { id: TICKET },
      operationId: 'panel-e2e-retry',
    })
    expect(receipt).toMatchObject({
      state: 'completed',
      operationId: 'panel-e2e-retry',
      output: { failure: { status: 400 } },
    })
    const replay = await client.extensions.readOperation({
      extension: EXTENSION,
      service: 'superagent.tickets.retry',
      operationId: 'panel-e2e-retry',
    })
    expect(replay).toMatchObject({ state: 'completed' })

    // Disabled, none of it answers.
    await operation(await client.packages.disable({ ...(await common('disable')), id: PACKAGE }))
    await expect(query('superagent.overview')).rejects.toThrow()
    const after = await client.clientModules.list(PROFILE)
    expect(after.rows.filter((item) => item.packageId === PACKAGE && item.phase === 'ready')).toEqual([])
  } catch (error) {
    failures.push(
      new Error(`${String(error)}\nSource daemon stderr:\n${stderr.slice(-8000)}`, { cause: error }),
    )
  } finally {
    for (const close of [
      () => sdk?.close(),
      async () => {
        if (daemon.exitCode !== null || daemon.signalCode !== null) return
        daemon.kill('SIGTERM')
        try {
          await bounded(exited, 'daemon shutdown', 25_000)
        } catch (error) {
          daemon.kill('SIGKILL')
          await exited
          throw error
        }
      },
      () => {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        if (socketDirectory)
          rmSync(socketDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
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
  if (failures.length > 1) throw new AggregateError(failures, 'panel e2e and cleanup failed')
}, 240_000)
