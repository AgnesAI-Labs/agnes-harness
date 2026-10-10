import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProfile } from '@agnes/host'
import { expect, it } from 'vitest'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/supervisor/config.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { WorkerPool } from '../src/supervisor/worker-pool.js'

// No testkit, buildHost, package loader or extension loader injection: the executable must load
// the official plugins through the production jiti graph before it can announce hello.
it('boots the source worker through the real extension loader and answers after hello', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-worker-contract-'))
  const profile = await resolveProfile(
    {
      builtin: 'local-dev',
      user: { dataDir: join(root, 'data'), cacheDir: join(root, 'cache'), computerUse: { enabled: false } },
      lock: {
        packages: Object.fromEntries(
          ['@agnes/base', '@agnes/code', '@agnes/ai'].map((id) => [
            id,
            { version: '0.0.0', integrity: 'sha512-fixture', trust: 'builtin', enabled: true },
          ]),
        ),
      },
    },
    {
      platform: { os: process.platform, arch: process.arch, capabilities: {} },
      agnesVersion: '0.0.0',
      now: '2026-10-11T00:00:00Z',
      homeDir: root,
    },
  )
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
    workerEntry: fileURLToPath(new URL('../src/worker/main.ts', import.meta.url)),
    execPath: process.execPath,
    execArgv: ['--import', 'tsx'],
    spawn: (command, args, options) => {
      const child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
      child.stderr?.on('data', (data) => {
        stderr += String(data)
      })
      return child
    },
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
    await expect(worker.command('ping', {})).resolves.toBeDefined()
  } finally {
    await pool.closeAll(2000).catch(() => pool.killAll())
    await pool.waitForExitRecovery()
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)

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
    'feedbackKind',
    'intelligentUiKind',
    'uiDataSourceKind',
    'gitWorktreeKind',
    'deferredProducerKind',
    'deferredQueueKind',
  ])
}, 30_000)
