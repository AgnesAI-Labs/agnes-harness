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
import type { EventEnvelope, PackageOperationReceipt } from '@agnes/protocol'
import { type Client, createClient, memoryJournal } from '@agnes/sdk'
import { expect, it } from 'vitest'
import { daemonTransport, hostFloor, readOwner, socketDirectoryOf } from '../fixtures/daemon-harness.js'

// The shipped payload on a real source daemon: the release grant reaches the managed service, and the plugin's hooks
// leave the owner's own sessions alone.
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
const MARKER = 'owner-session-tool-ran'
const STEP_MS = 60_000

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
  const replies = [
    [
      {
        type: 'toolcall_end',
        call: { toolUseId: 'owner-read', name: 'read', args: { path: 'marker.txt' }, ordinal: 0 },
      },
      usage,
      { type: 'done', reason: 'toolUse' },
    ],
    [{ type: 'text_delta', delta: 'Done.' }, usage, { type: 'done', reason: 'stop' }],
  ]
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
            compat: { replies, repeatLast: true },
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

it('the shipped payload starts its managed service with the bundled-app grant and leaves owner sessions alone', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-superagent-payload-')))
  try {
    initializeHome(root, PROFILE)
    writeProfile(root)
    writeFileSync(join(root, 'marker.txt'), `${MARKER}\n`)
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
    const owner = readOwner(root)
    socketDirectory = socketDirectoryOf(owner.socketPath, root)
    const client = createClient({
      journal: memoryJournal(),
      auth: { kind: 'local' },
      transport: daemonTransport(owner),
      timeouts: { request: STEP_MS },
    })
    sdk = client
    await bounded(client.initialize(), 'SDK initialize')

    const operation = async (receipt: PackageOperationReceipt) => {
      let last: unknown
      return until(async () => {
        const result = await client.packages.operation.get(receipt)
        last = result
        if (['failed', 'cancelled', 'rolled-back'].includes(result.state))
          throw new Error(`package ${result.operation}: ${JSON.stringify(result.error)}`)
        return result.state === 'completed' ? result : undefined
      }, `package ${receipt.operationId}`).catch((error: unknown) => {
        // Where the operation stopped: its stage, state and packages.
        throw new Error(`${String(error)}\nlast state: ${JSON.stringify(last)?.slice(0, 4000)}`, {
          cause: error,
        })
      })
    }
    const common = async (step: string) => ({
      profile: PROFILE,
      clientId: await client.clientId(),
      commandId: `superagent-${step}`,
    })
    const source = { type: 'file' as const, ref: 'file:./bundled-plugins/superagent' }
    const preview = (await operation(await client.packages.inspect({ ...(await common('inspect')), source })))
      .preview
    if (!preview?.capabilityHash) throw new Error('the payload preview has no capability hash')
    expect(preview.blockers, 'the shipped payload installs without blockers').toEqual([])
    // The daemon reports the shipped copy and its app access apart from publisher evidence, which stays unverified.
    expect(preview.bundledOrigin).toEqual({ ownerApplication: true })
    expect(preview.provenance.signatureVerified).toBe(false)
    // The fact is derived: the package-operation journal on disk never carries it.
    const journal = join(root, 'daemon', 'package-operations', 'operations.json')
    expect(readFileSync(journal, 'utf8')).toContain(preview.integrity)
    expect(readFileSync(journal, 'utf8')).not.toContain('bundledOrigin')
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
    const listed = (await client.packages.list({ profile: PROFILE })).packages.find(
      (pkg) => pkg.id === PACKAGE,
    )
    expect(listed?.bundledOrigin, 'the installed copy is proven again for enable and details').toEqual({
      ownerApplication: true,
    })
    expect(readFileSync(journal, 'utf8')).not.toContain('bundledOrigin')

    // start() refuses without a grant carrying a state directory, an SDK client and channels, so a ready service
    // shows the grant reached it; its database sits in the directory the platform chose for it.
    const status = await until(async () => {
      const result = await client.extensions
        .callScoped({ extension: EXTENSION, service: 'superagent.status', input: {} })
        .catch(() => undefined)
      const output = result?.output as { state?: string } | undefined
      if (output?.state === 'failed') throw new Error(`managed service failed: ${JSON.stringify(output)}`)
      return output?.state === 'ready' ? output : undefined
    }, 'managed service ready')
    expect(status).toMatchObject({ state: 'ready' })
    const { dataDir } = JSON.parse(readFileSync(join(root, 'daemon', 'discovery.json'), 'utf8'))
    const appRoot = join(dataDir, 'bundled-apps')
    const states = readdirSync(appRoot).filter((name) => existsSync(join(appRoot, name, 'superagent.sqlite')))
    expect(states, 'one platform state directory holds the database').toHaveLength(1)

    // Each bundle resolves with its preset, and every tool it names is a real one, the plugin's orchestrator_* tools
    // included.
    const manifest = JSON.parse(readFileSync(join(payloadDirectory, 'package.json'), 'utf8')) as {
      agnes: { bundles: Record<'router' | 'worker', { profile: { tools: string[] } }> }
    }
    for (const role of ['router', 'worker'] as const) {
      const opened = await client.session.new({
        cwd: root,
        sessionKey: `bundle-check-${role}`,
        bundles: [`${PACKAGE}#${role}`],
        preset: `superagent-${role}`,
      })
      const tools = await opened.tools()
      expect(tools.capabilities).toMatchObject({
        preset: `superagent-${role}`,
        bundles: [`${PACKAGE}#${role}`],
      })
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
        [...manifest.agnes.bundles[role].profile.tools].sort(),
      )
    }

    // An owner's session, even one whose key looks like Superagent's, runs its tools untouched by the hooks.
    const session = await client.session.new({ cwd: root, sessionKey: 'superagent:owner-made' })
    const events: EventEnvelope[] = []
    const iterator = session.events({ types: ['tool/result', 'turn/end'] })[Symbol.asyncIterator]()
    const collect = (async () => {
      for (;;) {
        const item = await iterator.next()
        if (item.done) break
        events.push(item.value)
        if (item.value.type === 'turn/end') break
      }
    })()
    void collect.catch(() => undefined)
    const turn = await bounded(session.prompt('Read the marker file.'), 'owner turn')
    await bounded(collect, 'owner turn events', 10_000)
    await iterator.return?.()
    expect(turn.reason).toBe('completed')
    const results = events.filter((event) => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data).not.toMatchObject({ isError: true })
    expect(JSON.stringify(results[0]?.data)).toContain(MARKER)
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
  if (failures.length > 1) throw new AggregateError(failures, 'payload e2e and cleanup failed')
}, 240_000)
