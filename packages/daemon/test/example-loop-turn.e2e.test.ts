import { type ChildProcess, spawn } from 'node:child_process'
import {
  cpSync,
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
import { initializeHome } from '@agnes/host'
import { HARNESS_VERSION, type PackageOperationReceipt, type RuntimeAdminSnapshot } from '@agnes/protocol'
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-source-loop-')))
  const provider = await startLoopProvider()
  const profileDir = join(root, 'profiles', 'local-dev')
  initializeHome(root, 'local-dev')
  // Keep the example itself intact; the installed copy adds a session-only review bundle.
  const loopPackage = join(root, 'loop-package')
  cpSync(join(examples, `${kind}-loop`), loopPackage, { recursive: true })
  const packageFile = join(loopPackage, 'package.json')
  const manifest = JSON.parse(readFileSync(packageFile, 'utf8'))
  manifest.agnes.plugins[0].export = 'reviewFixture'
  manifest.agnes.provides = ['bundle', 'loop']
  manifest.agnes.bundles = {
    review: {
      profile: {
        providers: { loop: { provider: `example.${kind}`, version: '1.0.0' } },
        toolPolicy: { readOnly: true },
      },
      presets: {
        review: {
          name: 'review',
          extends: 'standard',
          providers: { 'tool-policy': { provider: `fixture.${kind}` } },
        },
      },
    },
  }
  writeFileSync(packageFile, JSON.stringify(manifest))
  const entry = join(loopPackage, 'index.mjs')
  writeFileSync(
    entry,
    readFileSync(entry, 'utf8') +
      `
    import { defaultToolPolicy, toolPolicyKind } from '@agnes/extension-api';
    export const reviewFixture = {
      inject: ['providers'],
      apply(ctx, config) {
        plugin.apply(ctx, config);
        ctx.providers.register(toolPolicyKind, { ...defaultToolPolicy, id: 'fixture.${kind}' });
      }
    };
  `,
  )
  const deployDir = join(profileDir, 'deploy', 'review')
  mkdirSync(join(deployDir, 'profile'), { recursive: true })
  mkdirSync(join(deployDir, 'fixtures'))
  writeFileSync(join(deployDir, 'profile', 'profile.yaml'), '{}')
  writeFileSync(
    join(deployDir, 'manifest.json'),
    JSON.stringify({
      id: 'review',
      version: '1.0.0',
      harnessRange: `^${HARNESS_VERSION}`,
      extensions: [],
      profileFragment: 'profile/profile.yaml',
      presets: [],
      fixtures: 'fixtures/in',
    }),
  )
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
  let cancelSessionId: string | undefined
  const cancellation: {
    requestedAt: number | null
    acknowledgedAt: number | null
    turnReturnedAt: number | null
    turnReason: string | null
  } = { requestedAt: null, acknowledgedAt: null, turnReturnedAt: null, turnReason: null }
  try {
    await bounded(ready, 'source daemon boot')
    const owner = JSON.parse(readFileSync(join(root, 'daemon', 'owner.json'), 'utf8'))
    socketPath = owner.socketPath
    sdk = createClient({ journal: memoryJournal(), transport: { kind: 'unix', path: owner.socketPath } })
    await sdk.initialize()
    stage = 'workspace trust'
    const runtime = () => sdk!.call<RuntimeAdminSnapshot>('_agnes/v1/sessionSelection.runtime', {})
    const deployment = {
      deployDir,
      path: 'deploy/review',
      manifestId: 'review',
      trustHash: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
    }
    expect((await runtime()).workspaceDeployments).toContainEqual({ ...deployment, state: 'untrusted' })
    const trust = await sdk.packages.trustWorkspace({
      profile: 'local-dev',
      clientId: await sdk.clientId(),
      commandId: 'trust-workspace',
      deployDir,
    })
    expect(trust.hash).toMatch(/^sha256-[a-f0-9]{64}$/)
    expect((await runtime()).workspaceDeployments).toContainEqual({ ...deployment, state: 'trusted' })
    writeFileSync(join(deployDir, 'fixtures', 'changed.txt'), 'changed fixture')
    expect((await runtime()).workspaceDeployments).toContainEqual({ ...deployment, state: 'changed' })
    rmSync(join(deployDir, 'fixtures', 'changed.txt'))
    // A manifest outside the running harness range is neither offered nor accepted.
    const incompatible = join(profileDir, 'deploy', 'incompatible')
    cpSync(deployDir, incompatible, { recursive: true })
    const deployManifest = JSON.parse(readFileSync(join(incompatible, 'manifest.json'), 'utf8'))
    writeFileSync(
      join(incompatible, 'manifest.json'),
      JSON.stringify({ ...deployManifest, harnessRange: '^99.0.0' }),
    )
    expect((await runtime()).workspaceDeployments?.some((item) => item.deployDir === incompatible)).toBe(
      false,
    )
    await expect(
      sdk.packages.trustWorkspace({
        profile: 'local-dev',
        clientId: await sdk.clientId(),
        commandId: 'trust-incompatible',
        deployDir: incompatible,
      }),
    ).rejects.toMatchObject({ data: { code: 'SEMANTIC_REJECTED', reason: 'E_PACKAGE_BLOCKED' } })
    stage = 'install'
    const source = { type: 'file' as const, ref: `file:${loopPackage}` }
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

    // Through the real supervisor and worker: a new session's appended system prompt reaches its pinned prompt.
    stage = 'system prompt append'
    const appended = await sdk.session.new({
      cwd: root,
      sessionKey: `source-${kind}-append`,
      systemPromptAppend: 'APPENDED_PROMPT_PROBE',
    })
    expect(
      (await sdk.systemPrompt.get({ sessionId: appended.id })).sections.some((section) =>
        section.text.includes('APPENDED_PROMPT_PROBE'),
      ),
    ).toBe(true)

    stage = 'session bundle'
    const bundle = `@agnes-example/${kind}-loop#review`
    const selected = await sdk.session.new({ cwd: root, bundles: [bundle] })
    const selectedRuntime = await sdk.session.runtime(selected.id)
    expect(selectedRuntime).toMatchObject({
      preset: { name: 'review', bundles: [bundle] },
      loop,
      policy: { readOnly: true, toolPolicy: `fixture.${kind}` },
    })
    expect(await sdk.session.runtime(session.id)).toMatchObject({
      preset: { name: 'standard' },
      policy: { readOnly: false, toolPolicy: 'default' },
    })
    await expect(sdk.session.new({ cwd: root, preset: 'review' })).rejects.toMatchObject({
      data: { code: 'PRESET_SWITCH_REJECTED' },
    })
    await expect(sdk.session.new({ cwd: root, bundles: ['@fixture/missing#review'] })).rejects.toMatchObject({
      code: -32011,
      data: { code: 'BUNDLE_UNAVAILABLE' },
    })
    await expect(sdk.session.new({ cwd: root, bundles: [bundle], preset: 'absent' })).rejects.toMatchObject({
      data: { code: 'PRESET_SWITCH_REJECTED' },
    })
    if (kind === 'react') {
      // Read-only compositions hide mutating tools. Even a scripted native call must fail closed.
      expect((await selected.tools()).tools.some((tool) => tool.name === 'write')).toBe(false)
      await expect(selected.prompt('BUNDLE_WRITE_PROBE')).rejects.toMatchObject({
        data: { code: 'TURN_ERROR', error: { code: 'REACT_FAILED', message: 'Error: unknown tool write' } },
      })
      expect(existsSync(join(root, 'bundle-must-not-write.txt'))).toBe(false)
    }
    stage = 'cancel'
    const blocked = provider.block()
    const cancelled = session.prompt('Cancel this blocked turn')
    void cancelled.catch(() => undefined)
    await bounded(blocked.entered, `${kind} active inference`)
    cancelSessionId = session.id
    await sdk.session.rename(session.id, 'Review fixture session')
    const generationSession = async () =>
      (await sdk!.packages.generations({ profile: 'local-dev' })).generations
        .flatMap((generation) => generation.sessions ?? [])
        .find((item) => item.key === session.id)
    expect(await generationSession()).toMatchObject({
      key: session.id,
      open: true,
      title: 'Review fixture session',
      run: 'running',
    })
    cancellation.requestedAt = Date.now()
    await bounded(session.cancel(), `${kind} cancel acknowledgement`)
    cancellation.acknowledgedAt = Date.now()
    const cancelledTurn = await bounded(cancelled, `${kind} cancelled turn`)
    cancellation.turnReturnedAt = Date.now()
    cancellation.turnReason = cancelledTurn.reason
    expect(cancelledTurn.reason).toBe('aborted')
    expect(await generationSession()).toMatchObject({ title: 'Review fixture session', run: 'idle' })
    await bounded(blocked.disconnected, `${kind} provider abort`)
    provider.unblock()
    stage = 'recover'
    expect(
      (await bounded(session.prompt('Summarize again after cancellation.'), `${kind} recovery`)).reason,
    ).toBe('completed')
  } catch (error) {
    let signalEvidence: unknown = { unavailable: true }
    if (sdk && cancelSessionId) {
      try {
        const trace = await sdk.requestTrace.get({ sessionId: cancelSessionId }, { timeoutMs: 2_000 })
        signalEvidence = {
          // Passive adapter evidence; the worker's in-memory signal is not exposed by RPC.
          source: 'provider-attempt-status',
          workerSignalState: 'not-directly-observed',
          callId: trace.snapshot?.id,
          attempts: trace.snapshot?.attempts.map(({ attemptId, status, index }) => ({
            attemptId,
            status,
            index,
          })),
          unavailable: trace.unavailable,
        }
      } catch {
        signalEvidence = { unavailable: 'trace-read-failed' }
      }
    }
    const diagnostics = { cancellation, signalEvidence, sockets: provider.diagnostics() }
    failures.push(
      new Error(
        `${kind} ${stage}: ${String(error)}\nCancellation diagnostics: ${JSON.stringify(diagnostics)}\nSource daemon stderr:\n${stderr}`,
        { cause: error },
      ),
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
