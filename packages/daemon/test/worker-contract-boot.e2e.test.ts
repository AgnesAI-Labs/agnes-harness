import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ResolvedProfile, resolveProfile } from '@agnes/host'
import type { InstalledPackage } from '@agnes/package-manager'
import { createClient, memoryJournal } from '@agnes/sdk'
import { expect, it } from 'vitest'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/supervisor/config.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { daemonSocketPaths } from '../src/supervisor/socket-paths.js'
import { startSupervisor } from '../src/supervisor/supervisor.js'
import { WorkerPool } from '../src/supervisor/worker-pool.js'
import { localSdkTransport } from './local-socket-path.js'
import { createWorkerByteFixture } from './plugin-byte-fixture.js'

// No testkit, buildHost, package loader or extension loader injection: the executable must load
// the official plugins through the production jiti graph before it can announce hello.
it.each([false, true])(
  'boots the source worker through the real extension loader (owner admission %s)',
  async (admitted) => {
    const fixture = await createWorkerByteFixture()
    const root = fixture.home
    if (fixture) await new Promise((resolve) => setTimeout(resolve, 1100))
    const extra = fixture ? (await fixture.reader().inventory(fixture.profileDir)).packages[0] : undefined
    const profile = await sourceProfile(root, fixture?.home, extra)
    const trace = join(root, 'worker-byte-hashes.jsonl')
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
      limits: { ...DEFAULT_LIMITS, workerStartupMs: 30_000 },
    }
    let stderr = ''
    const pool = new WorkerPool({
      config,
      profile,
      profileFile,
      clock: Date.now,
      ...(admitted
        ? {
            preparePackageAdmission: async () => {
              await fixture.reader().runtimePluginSnapshots(fixture.profileDir)
              return fixture.verification.admission()
            },
          }
        : {}),
      workerEntry: fileURLToPath(new URL('../src/worker/main.ts', import.meta.url)),
      // Exercise the production default executable, including when PATH selects another Node.
      execArgv: [
        '--import',
        'tsx',
        '--import',
        fileURLToPath(new URL('../../../tools/bench-verification-preload.mjs', import.meta.url)),
        '--import',
        'data:text/javascript,console.error("AGH_TOOLCHAIN_RUNTIME "+JSON.stringify({version:process.version,execPath:process.execPath}))',
      ],
      // Node's spawn overloads cannot be implemented by the three-argument call the pool makes.
      spawn: ((...args: Parameters<typeof spawn>) => {
        const options = args[2]
        const child = spawn(args[0], Array.isArray(args[1]) ? args[1] : [], {
          ...(options && typeof options === 'object' ? options : {}),
          env: {
            ...(options && typeof options === 'object' ? options.env : {}),
            AGH_VERIFICATION_TRACE: trace,
          },
          stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'ipc'],
        })
        child.stderr?.on('data', (chunk: Buffer | string) => {
          stderr += String(chunk)
        })
        return child
      }) as typeof spawn,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      const worker = await pool.acquireSharedWorker().catch((error) => {
        throw new Error(`${String(error)}\n${stderr}`)
      })
      expect(await worker.hello).toMatchObject({ workerKey: '@shared', profileHash: profile.hash })
      const runtime = /AGH_TOOLCHAIN_RUNTIME (\{[^\n]+\})/.exec(stderr)?.[1]
      if (!runtime) throw new Error(`Worker did not report its runtime\n${stderr}`)
      expect(JSON.parse(runtime)).toEqual({ version: process.version, execPath: process.execPath })
      console.log(`Worker runtime ${runtime}`)
      await expect(worker.command('ping', {})).resolves.toBeDefined()
      if (fixture) {
        expect(readFileSync(join(root, 'applied.txt'), 'utf8')).toContain('applied')
        const appliedBefore = readFileSync(join(root, 'applied.txt'), 'utf8').length
        expect(JSON.stringify(await worker.command('pluginGenerations.status', {}))).toContain(
          '@synthetic/load-0',
        )
        expect(pool.retireSharedWorkerNow()).toBe(true)
        expect(await pool.waitForGenerationExit('@shared', (await worker.hello).workerGeneration, 5000)).toBe(
          true,
        )
        const replacement = await pool.acquireSharedWorker()
        expect((await replacement.hello).workerGeneration).not.toBe((await worker.hello).workerGeneration)
        await expect(replacement.command('ping', {})).resolves.toBeDefined()
        expect(readFileSync(join(root, 'applied.txt'), 'utf8').length).toBeGreaterThan(appliedBefore)
        pool.stopPluginExecution()
        expect(
          await pool.waitForGenerationExit('@shared', (await replacement.hello).workerGeneration, 5000),
        ).toBe(true)
        const hashes = existsSync(trace)
          ? readFileSync(trace, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : []
        const initialReads: unknown[] = []
        const imported = new Set<number>()
        for (const row of hashes) {
          if (row.phase === 'plugin-import') imported.add(row.pid)
          else if (
            !imported.has(row.pid) &&
            (row.directory?.includes('/.runtime-snapshots/') || row.directory?.includes('/packages/'))
          )
            initialReads.push(row)
        }
        expect(imported.size).toBe(2)
        const records = (await fixture.verification.admission()).trees.length
        console.log(
          'worker boot verification',
          JSON.stringify({
            admitted,
            records,
            fullBeforeImport: initialReads.length,
            totalFull: hashes.filter((row) => row.directory).length,
          }),
        )
        if (admitted && records) expect(initialReads).toEqual([])
        else expect(initialReads.length).toBeGreaterThan(0)
      }
    } finally {
      await pool.closeAll(2000).catch(() => pool.killAll())
      await pool.waitForExitRecovery()
      await server.close()
      if (fixture) await fixture.close()
      else rmSync(root, { recursive: true, force: true })
    }
  },
  45_000,
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

async function sourceProfile(
  root: string,
  dataDir = join(root, 'data'),
  extra?: InstalledPackage,
): Promise<ResolvedProfile> {
  const hostRequire = createRequire(createRequire(import.meta.url).resolve('@agnes/host'))
  const { demoProvider } = await import(hostRequire.resolve('@agnes/host-common/profile/demo'))
  const os = process.platform
  if (os !== 'darwin' && os !== 'linux' && os !== 'win32') throw new Error(`unsupported platform ${os}`)
  return resolveProfile(
    {
      builtin: 'local-dev',
      user: {
        name: 'local-dev',
        ...(extra
          ? {
              packages: [
                ...['@agnes/base', '@agnes/code', '@agnes/ai'].map((id) => ({ id, source: 'builtin' })),
                { id: extra.id, source: extra.entry.source.ref },
              ],
            }
          : {}),
        dataDir,
        cacheDir: join(root, 'cache'),
        computerUse: { enabled: false },
        provider: demoProvider(),
      },
      lock: {
        packages: {
          ...Object.fromEntries(
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
          ...(extra ? { [extra.id]: { ...extra.entry, trust: 'trusted' as const, enabled: true } } : {}),
        },
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

it('opens a client session through the source daemon and its production worker', async () => {
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
  try {
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
    sdk = createClient({ journal: memoryJournal(), transport: localSdkTransport(supervisor.socketPath) })
    const session = await sdk.session.new({
      cwd: root,
      sessionKey: 'source-worker-boot',
      preset: profile.presets.default,
    })
    expect(session.id).toBe('source-worker-boot')
  } finally {
    await sdk?.close()
    await supervisor?.close()
    await tables.close()
    rmSync(root, { recursive: true, force: true })
    if (process.platform !== 'win32') rmSync(dirname(paths.socketPath), { recursive: true, force: true })
  }
}, 45_000)
