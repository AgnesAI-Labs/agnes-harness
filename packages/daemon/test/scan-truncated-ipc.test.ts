import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canonicalJson,
  DEFAULT_COMPUTER_USE,
  hashInput,
  type ResolvedProfile,
  scanAll,
  sha256hex,
} from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { expect, it } from 'vitest'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/config.js'
import { RemoteSession } from '../src/supervisor/remote-session.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { WorkerPool } from '../src/supervisor/worker-pool.js'
import { workspaceBinding } from './workspace-authority.js'

// A real worker process (runWorker over a testkit Host on SQLite) behind a real WorkerPool: the
// E_SCAN_TRUNCATED a worker's adapter raises has to arrive at the daemon with enough in its message
// to find the scan, because only code, message and a public reason cross the worker boundary.
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

it('a truncated scan in the worker reaches the daemon with its range, and paging reads through it', async () => {
  // The binding below comes from a test authority that takes the root as given, so hand it the
  // native spelling the daemon resolves the workspace to (Windows expands 8.3 short names).
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-scan-ipc-')))
  const key = 'agnes:local:default:daemon:dm:scan-ipc'
  try {
    // Seed the ledger before any worker owns it.
    const seeded = await createTestHost({ dataDir: dir, script: [] })
    const session = await seeded.host.createSession({ key, cwd: dir })
    const notes = Array.from({ length: 1_232 }, (_, n) =>
      session.ev('x/agnes/scan-test/note', { n }, { ignorable: true }),
    )
    for (let i = 0; i < notes.length; i += 250) await session.append(notes.slice(i, i + 250))
    const lastSeq = session.lastSeq
    await session.close()
    await seeded.host.close()
    expect(lastSeq).toBeGreaterThan(1_200)

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
      notices: { emit() {} },
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      const link = await pool.acquire(key, {
        resume: true,
        cwd: dir,
        binding: await workspaceBinding(key, dir),
      })
      const hello = await link.hello
      const remote = new RemoteSession(key, hello.writerRunId, hello.generation, link, dir)

      const err = (await remote.scan({ toSeq: lastSeq }).catch((e: unknown) => e)) as Record<string, unknown>
      expect(err.code).toBe('E_SCAN_TRUNCATED')
      expect(err.message).toBe(
        `E_SCAN_TRUNCATED: scan matched more than 500 rows (pageMax=500 requested=all fromSeq=start toSeq=${lastSeq} order=asc)`,
      )
      expect(err).not.toHaveProperty('detail')

      const read = (q: object) => remote.scan(q) as Promise<Array<{ seq: number }>>
      const rows = await scanAll(read, { toSeq: lastSeq })
      expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: lastSeq }, (_, i) => i + 1))
    } finally {
      await pool.closeAll(2_000)
      await server.close()
    }
  } finally {
    // On Windows a worker's database files can stay locked for a moment after the process exits;
    // retry the removal (rm retries EPERM and EBUSY with a linear backoff) instead of failing on it.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 90_000)
