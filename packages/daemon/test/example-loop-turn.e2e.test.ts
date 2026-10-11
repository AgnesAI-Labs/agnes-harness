import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeHome } from '@agnes/host'
import type { PackageOperationReceipt } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { expect, it } from 'vitest'
import { startLoopProvider } from './fixtures/loop-provider.js'

const sourceDaemon = fileURLToPath(new URL('./fixtures/source-loop-daemon.ts', import.meta.url))
const examples = fileURLToPath(new URL('../../../examples/loops/', import.meta.url))

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 30_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function operation(sdk: ReturnType<typeof createClient>, receipt: PackageOperationReceipt) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const result = await sdk.packages.operation.get({
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

async function runExample(kind: 'react' | 'dag') {
  const root = mkdtempSync(join(tmpdir(), 'agnes-source-loop-'))
  const provider = await startLoopProvider()
  const profileDir = join(root, 'profiles', 'local-dev')
  initializeHome(root, 'local-dev')
  const secretDir = join(root, 'secrets')
  mkdirSync(join(secretDir, 'fixture'), { mode: 0o700 })
  writeFileSync(join(secretDir, 'fixture', 'model'), 'synthetic-loop-fixture', { mode: 0o600 })
  const model = {
    id: 'loop-script',
    name: 'Scripted loop fixture',
    route: 'loop-fixture',
    api: 'openai-completions',
    baseUrl: provider.baseUrl,
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
    join(profileDir, 'profile.yaml'),
    JSON.stringify({
      name: 'local-dev',
      computerUse: { enabled: false },
      adapters: { secrets: { kind: 'file', path: secretDir } },
      provider: {
        package: '@agnes/ai',
        adapters: ['@agnes/ai'],
        catalog: { include: [] },
        routes: [
          {
            route: model.route,
            api: 'openai-completions',
            baseUrl: provider.baseUrl,
            credentialRef: 'secret://fixture/model',
            models: [model],
          },
        ],
      },
    }),
  )
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
  let stage = 'boot'
  const failures: unknown[] = []
  try {
    await bounded(ready, 'source daemon boot')
    const owner = JSON.parse(readFileSync(join(root, 'daemon', 'owner.json'), 'utf8'))
    socketPath = owner.socketPath
    sdk = createClient({ journal: memoryJournal(), transport: { kind: 'unix', path: owner.socketPath } })
    await sdk.initialize()
    stage = 'install'
    const source = { type: 'file' as const, ref: `file:${join(examples, `${kind}-loop`)}` }
    const common = { profile: 'local-dev', clientId: await sdk.clientId() }
    const inspection = await operation(
      sdk,
      await sdk.packages.inspect({ ...common, commandId: 'inspect', source }),
    )
    expect(inspection.preview?.blockers).toEqual([])
    const preview = inspection.preview!
    await operation(
      sdk,
      await sdk.packages.install({
        ...common,
        commandId: 'install',
        source,
        expectedIntegrity: preview.integrity,
      }),
    )
    await operation(
      sdk,
      await sdk.packages.trust({
        ...common,
        commandId: 'trust',
        id: `@agnes-example/${kind}-loop`,
        expectedIntegrity: preview.integrity,
        capabilityHash: preview.capabilityHash ?? '',
      }),
    )
    await operation(
      sdk,
      await sdk.packages.enable({ ...common, commandId: 'enable', id: `@agnes-example/${kind}-loop` }),
    )
    const loop = { id: `example.${kind}`, version: '1.0.0' }
    expect(await sdk.sessionSelection.loops()).toContainEqual(
      expect.objectContaining({
        ...loop,
        sourcePackage: `@agnes-example/${kind}-loop`,
      }),
    )
    stage = 'complete'
    const session = await sdk.session.new({
      cwd: root,
      sessionKey: `source-${kind}-turn`,
      loop,
      preset: 'standard',
    })
    const result = await bounded(
      session.prompt('Summarize the refund window using the selected loop.'),
      `${kind} completion`,
    )
    expect(result.reason).toBe('completed')
    expect(JSON.stringify((await session.projectUI()).nodes)).toContain('Refund window is 30 days.')
    if (kind === 'dag')
      expect(provider.requests.some((request) => request.includes('<dag-planner-protocol>'))).toBe(true)

    stage = 'cancel'
    const blocked = provider.block()
    const cancelled = session.prompt('Cancel this blocked turn')
    void cancelled.catch(() => undefined)
    await bounded(blocked.entered, `${kind} active inference`)
    await bounded(session.cancel(), `${kind} cancel acknowledgement`)
    expect((await bounded(cancelled, `${kind} cancelled turn`)).reason).toBe('aborted')
    await bounded(blocked.disconnected, `${kind} provider abort`)
    provider.unblock()
    stage = 'recover'
    expect(
      (await bounded(session.prompt('Summarize again after cancellation.'), `${kind} recovery`)).reason,
    ).toBe('completed')
  } catch (error) {
    failures.push(
      new Error(`${kind} ${stage}: ${String(error)}\nSource daemon stderr:\n${stderr}`, { cause: error }),
    )
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
  if (failures.length > 1) throw new AggregateError(failures, 'source loop fixture and cleanup failed')
}

// POSIX signal shutdown and Unix transport; Windows stop-request coverage lives in daemon lifecycle tests.
it.skipIf(process.platform === 'win32').each(['react', 'dag'] as const)(
  'completes, cancels and resumes the %s example through the source daemon and production loader',
  async (kind) => {
    await runExample(kind)
  },
  150_000,
)
