import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, DEFAULT_COMPUTER_USE, hashInput, type ResolvedProfile, sha256hex } from '@agnes/host'
import { expect, it } from 'vitest'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/config.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { WorkerPool } from '../src/supervisor/worker-pool.js'
import { workspaceBinding } from './workspace-authority.js'

// A real worker process behind a real WorkerPool: the record a worker sends when it opens a
// session has to come out of the pool's `onRecord`, with the session named by hash only.
const fakeWorkerEntry = fileURLToPath(new URL('./fake-worker-entry.ts', import.meta.url))

function buildProfile(dataDir: string): ResolvedProfile {
  const body = {
    name: 'local-dev',
    dataDir,
    seams: { principals: '@agnes/base' },
    computerUse: DEFAULT_COMPUTER_USE,
    presets: { default: 'standard', allowed: ['standard'] },
    provider: {
      routes: [
        {
          route: 'faux',
          api: 'faux',
          baseUrl: 'https://invalid.test',
          models: [{ route: 'faux', id: 'faux-1' }],
        },
      ],
    },
  } as unknown as Omit<ResolvedProfile, 'hash'>
  return { ...body, hash: `sha256-${sha256hex(canonicalJson(hashInput(body)))}` }
}

it('hands the worker session.open record to the pool observer', async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-open-record-')))
  const key = 'agnes:local:default:daemon:dm:open-record'
  try {
    const profile = buildProfile(dir)
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify(profile))
    const config: DaemonConfig = {
      profileName: 'local-dev',
      dataDir: dir,
      socketPath: join(dir, 'a.sock'),
      workersSocketPath:
        process.platform === 'win32' ? `\\\\.\\pipe\\${basename(dir)}-w` : join(dir, 'w.sock'),
      limits: { ...DEFAULT_LIMITS, workerStartupMs: 30_000 },
    }
    const records: Array<{ sessionKey: string; kind: string; detail: Record<string, unknown> }> = []
    const pool = new WorkerPool({
      config,
      profile,
      profileFile,
      execPath: process.execPath,
      workerEntry: fakeWorkerEntry,
      execArgv: ['--import', 'tsx'],
      clock: () => Date.now(),
      onEvent: () => undefined,
      onRequest: async () => undefined,
      onRecord: (sessionKey, record) => records.push({ sessionKey, ...record }),
      notices: { emit() {} },
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      const link = await pool.acquire(key, {
        resume: false,
        cwd: dir,
        binding: await workspaceBinding(key, dir),
      })
      await link.hello
      await expect.poll(() => records.length).toBe(1)
      expect(records[0]).toMatchObject({
        sessionKey: key,
        kind: 'session.open',
        detail: { outcome: 'ok', lastSeq: expect.any(Number), ms: { total: expect.any(Number) } },
      })
      expect(records[0]?.detail.session).toMatch(/^[0-9a-f]{16}$/)
      expect(JSON.stringify(records[0]?.detail)).not.toContain('open-record')
    } finally {
      await pool.closeAll(2_000)
      await server.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 90_000)
