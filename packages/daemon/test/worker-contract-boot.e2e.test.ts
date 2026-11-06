import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ResolvedProfile, resolveProfile } from '@agnes/host'
import { publicErrorContract } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { expect, it } from 'vitest'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/supervisor/config.js'
import { workerStderrEvidence } from '../src/supervisor/runtime-log.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { daemonSocketPaths } from '../src/supervisor/socket-paths.js'
import { startSupervisor } from '../src/supervisor/supervisor.js'
import { WorkerPool } from '../src/supervisor/worker-pool.js'
import { localSdkTransport } from './local-socket-path.js'
import { sourceTranspileCache } from './source-transpile-cache.js'

// These are loader/session contracts; allow the production startup budget and shutdown grace.
const sourceWorkerTestTimeoutMs = DEFAULT_LIMITS.workerStartupMs + DEFAULT_LIMITS.shutdownGraceMs

// No testkit, buildHost, package loader or extension loader injection: the executable must load
// the official plugins through the production jiti graph before it can announce hello.
it(
  'boots the source worker through the real extension loader and answers after hello',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-worker-contract-'))
    const profile = await sourceProfile(root)
    const profileFile = join(root, 'profile.json')
    writeFileSync(profileFile, JSON.stringify(profile))
    const config: DaemonConfig = {
      home: root,
      profileName: profile.name,
      dataDir: profile.dataDir,
      socketPath: join(root, 'c.sock'),
      workersSocketPath:
        process.platform === 'win32'
          ? `\\\\.\\pipe\\${root.split(/[\\/]/).pop()}-worker`
          : join(root, 'w.sock'),
      limits: { ...DEFAULT_LIMITS },
    }
    let stderr = ''
    const stderrEvidence = workerStderrEvidence()
    const auditEvidence = workerStderrEvidence()
    const auditKinds: string[] = []
    const auditCodes: string[] = []
    let closeObserved = false
    let termination: { code: number | null; signal: NodeJS.Signals | null } | undefined
    let failure: { error: unknown } | undefined
    const pool = new WorkerPool({
      config,
      profile,
      profileFile,
      clock: Date.now,
      workerEntry: fileURLToPath(new URL('../src/worker/main.ts', import.meta.url)),
      // Exercise the production default executable, including when PATH selects another Node.
      execArgv: [
        '--import',
        'tsx',
        '--import',
        'data:text/javascript,console.error("AGH_TOOLCHAIN_RUNTIME "+JSON.stringify({version:process.version,execPath:process.execPath}))',
      ],
      // Node's spawn overloads cannot be implemented by the three-argument call the pool makes.
      spawn: ((...args: Parameters<typeof spawn>) => {
        const options = args[2]
        const child = spawn(args[0], Array.isArray(args[1]) ? args[1] : [], {
          ...(options && typeof options === 'object' ? options : {}),
          stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'ipc'],
        })
        child.stderr?.on('data', (chunk: Buffer | string) => {
          stderr = (stderr + String(chunk)).slice(0, 64 * 1024)
          stderrEvidence.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        })
        child.once('close', (code, signal) => {
          termination = { code, signal }
          closeObserved = true
        })
        return child
      }) as typeof spawn,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      onRuntimeLog: (record) => {
        const line = JSON.stringify(record) ?? ''
        auditEvidence.push(Buffer.from(line))
        if (/^worker\.(?:start_failed|exited|stderr)$/.test((record as { kind: string }).kind))
          auditKinds.push((record as { kind: string }).kind)
        const code = (record as { detail?: { code?: unknown } }).detail?.code
        if (typeof code === 'string' && publicErrorContract(code)) auditCodes.push(code)
      },
      notices: { emit() {} },
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      const worker = await pool.acquireSharedWorker()
      expect(await worker.hello).toMatchObject({ workerKey: '@shared', profileHash: profile.hash })
      const runtime = /AGH_TOOLCHAIN_RUNTIME (\{[^\n]+\})/.exec(stderr)?.[1]
      if (!runtime) throw new Error('Worker did not report its runtime')
      expect(JSON.parse(runtime)).toEqual({ version: process.version, execPath: process.execPath })
      console.log(`Worker runtime ${runtime}`)
      await expect(worker.command('ping', {})).resolves.toBeDefined()
    } catch (error) {
      failure = { error }
    } finally {
      try {
        await pool.closeAll(2000).catch(() => pool.killAll())
        await pool.waitForExitRecovery()
        await server.close()
      } catch (error) {
        failure ??= { error }
      } finally {
        console.error(
          'WORKER_BOOT_EVIDENCE',
          JSON.stringify({
            stderr: stderrEvidence.snapshot(),
            audit: auditEvidence.snapshot(),
            kinds: auditKinds.slice(-8),
            codes: auditCodes.slice(-8),
            termination,
            closeObserved,
          }),
        )
        rmSync(root, { recursive: true, force: true })
      }
    }
    if (failure) throw failure.error
  },
  sourceWorkerTestTimeoutMs,
)

it('shares every service-kind token with loader-loaded plugins in a fresh process', async () => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./fixtures/worker-contract-audit.ts', import.meta.url))],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  let error = ''
  child.stdout.on('data', (data) => {
    output += String(data)
  })
  child.stderr.on('data', (data) => {
    error += String(data)
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('contract audit timed out'))
    }, 20_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  expect(code, error).toBe(0)
  expect(JSON.parse(output)).toEqual([
    'observabilityKind',
    'intelligentUiKind',
    'uiDataSourceKind',
    'gitWorktreeKind',
    'deferredProducerKind',
    'deferredQueueKind',
    'approval',
    'principals',
    'billing',
    'checkpoint',
    'artifacts',
    'verifier',
    'repair',
  ])
}, 30_000)

async function sourceProfile(root: string): Promise<ResolvedProfile> {
  const hostRequire = createRequire(createRequire(import.meta.url).resolve('@agnes/host'))
  const { demoProvider } = await import(hostRequire.resolve('@agnes/host-common/profile/demo'))
  const os = process.platform
  if (os !== 'darwin' && os !== 'linux' && os !== 'win32') throw new Error(`unsupported platform ${os}`)
  return resolveProfile(
    {
      builtin: 'local-dev',
      user: {
        name: 'local-dev',
        dataDir: join(root, 'data'),
        cacheDir: sourceTranspileCache(),
        computerUse: { enabled: false },
        provider: demoProvider(),
      },
      lock: {
        packages: Object.fromEntries(
          ['@agnes/base', '@agnes/code', '@agnes/ai'].map((id) => [
            id,
            {
              version: '0.0.0',
              source: { type: 'builtin' as const, ref: 'builtin' },
              integrity: 'builtin:0.0.0',
              trust: 'builtin',
              enabled: true,
            },
          ]),
        ),
      },
    },
    {
      platform: { os, arch: process.arch, capabilities: {} },
      agnesVersion: '0.0.0',
      now: '2026-10-11T00:00:00Z',
      homeDir: root,
    },
  )
}

it(
  'opens a client session through the source daemon and its production worker',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-source-daemon-'))
    const profile = await sourceProfile(root)
    const profileFile = join(root, 'profile.json')
    writeFileSync(profileFile, JSON.stringify(profile))
    const paths = daemonSocketPaths({
      dataDir: profile.dataDir,
      ipc: process.platform === 'win32' ? 'pipe' : 'unix',
    })
    const tables = sqliteTables(join(root, 'daemon.sqlite'))
    let supervisor: Awaited<ReturnType<typeof startSupervisor>> | undefined
    let sdk: ReturnType<typeof createClient> | undefined
    const started = performance.now()
    const phase = (phase: string) =>
      console.error(
        'SOURCE_DAEMON_PHASE',
        JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started) }),
      )
    try {
      phase('supervisor.begin')
      supervisor = await startSupervisor({
        config: {
          home: root,
          profileName: profile.name,
          dataDir: profile.dataDir,
          ...paths,
          limits: { ...DEFAULT_LIMITS, jobsTickMs: 60_000 },
        },
        profile,
        profileFile,
        profileDir: join(root, 'profiles', profile.name),
        workspaceRoot: root,
        jobTables: tables,
        processIdentity: async (pid) =>
          pid === process.pid ? { state: 'alive', startId: 'source-daemon-fixture' } : { state: 'dead' },
        workerExecPath: process.execPath,
        workerExecArgv: ['--import', 'tsx'],
        workerEntry: fileURLToPath(new URL('../src/worker/main.ts', import.meta.url)),
      })
      phase('supervisor.ready')
      sdk = createClient({ journal: memoryJournal(), transport: localSdkTransport(supervisor.socketPath) })
      phase('session.new.begin')
      const session = await sdk.session.new({
        cwd: root,
        sessionKey: 'source-worker-boot',
        preset: profile.presets.default,
      })
      phase('session.new.done')
      expect(session.id).toBe('source-worker-boot')
    } finally {
      phase('sdk.close.begin')
      await sdk?.close()
      phase('supervisor.close.begin')
      await supervisor?.close()
      phase('tables.close.begin')
      await tables.close()
      phase('cleanup.done')
      rmSync(root, { recursive: true, force: true })
      if (process.platform !== 'win32') rmSync(dirname(paths.socketPath), { recursive: true, force: true })
    }
  },
  sourceWorkerTestTimeoutMs,
)
