import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import {
  canonicalJson,
  DEFAULT_COMPUTER_USE,
  hashInput,
  type ResolvedProfile,
  scanAll,
  sha256hex,
} from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { attachmentLink } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { workspaceBinding } from '../../daemon-foundation/test/workspace-authority.js'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/supervisor/config.js'
import { RemoteSession } from '../src/supervisor/remote-session.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { WorkerPool } from '../src/supervisor/worker-pool.js'

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
    // Seed the ledger before any worker owns it. Store actual original bytes: the generic
    // testkit artifact seam returns a placeholder digest that is invalid in stored attachments.
    const originals = join(dir, 'originals')
    mkdirSync(originals)
    const seeded = await createTestHost({
      dataDir: dir,
      script: [],
      seams: {
        artifacts: {
          async put(bytes, meta) {
            const sha256 = createHash('sha256').update(bytes).digest('hex')
            writeFileSync(join(originals, sha256), bytes)
            return { sha256, size: bytes.length, mime: meta?.mime ?? 'application/octet-stream' }
          },
        },
      },
      profileInputs: {
        user: {
          name: 'local-dev',
          provider: {
            package: '@agnes/ai',
            routes: [
              {
                route: 'faux',
                api: 'faux',
                baseUrl: 'https://invalid.test',
                models: [fakeModel({ route: 'faux', id: 'faux-1' })],
              },
            ],
          },
        },
      },
    })
    const session = await seeded.host.createSession({ key, cwd: dir })
    const notes = Array.from({ length: 1_232 }, (_, n) =>
      session.ev('x/agnes/scan-test/note', { n }, { ignorable: true }),
    )
    for (let i = 0; i < notes.length; i += 250) await session.append(notes.slice(i, i + 250))
    // Fixed original-heavy companion dataset: originals stay in the artifact provider, never IPC
    // ledger frames. The worker must reopen and page the reference history under the same budget.
    for (let index = 0; index < 5; index++) {
      const original = await session.d.runtime.artifactPut(Buffer.alloc(20 * 1024 * 1024, index + 1), {
        mime: 'application/octet-stream',
      })
      await session.append([
        session.ev('user/message', {
          kind: 'prompt',
          content: [attachmentLink(original, `original-${index}.bin`)],
        }),
      ])
    }
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
    const rssFile = join(dir, 'opening-worker-rss.json')
    // A test-only Node preload records this real child process's cumulative peak, including
    // startup and restore. It creates no production RPC, environment switch or alternate worker.
    const probe =
      'data:text/javascript,' +
      encodeURIComponent(`
      import {writeFileSync} from 'node:fs';
      const record = () => writeFileSync(${JSON.stringify(rssFile)}, JSON.stringify({peakRssBytes:process.resourceUsage().maxRSS*1024}));
      record(); setInterval(record,100).unref(); process.on('exit',record);
    `)
    const pool = new WorkerPool({
      config,
      profile,
      profileFile,
      execPath: process.execPath,
      workerEntry: fakeWorkerEntry,
      execArgv: ['--import', 'tsx', '--import', probe],
      clock: () => Date.now(),
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    try {
      const coldStarted = performance.now()
      const link = await pool.acquire(key, {
        resume: true,
        cwd: dir,
        binding: await workspaceBinding(key, dir),
      })
      const hello = await link.hello
      const coldStartMs = performance.now() - coldStarted
      expect(coldStartMs).toBeLessThan(30_000)
      const remote = new RemoteSession(key, hello.writerRunId, hello.generation, link, dir)

      const openingMs: number[] = []
      for (let index = 0; index < 5; index++) {
        const started = performance.now()
        const opening = await remote.projectUIOpening({ maxNodes: 200, maxBytes: 8 * 1024 * 1024 })
        openingMs.push(performance.now() - started)
        expect(JSON.stringify(opening).length).toBeLessThan(8 * 1024 * 1024)
        expect(JSON.stringify(opening)).toContain('original-4.bin')
      }
      expect(Math.max(...openingMs)).toBeLessThan(1000)
      expect(process.resourceUsage().maxRSS * 1024).toBeLessThan(1024 * 1024 * 1024)
      console.info(
        JSON.stringify({
          dataset: 'ipc-1232-notes-5x20MiB-originals-v1',
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          coldStartMs,
          openingMs,
          peakParentRssBytes: process.resourceUsage().maxRSS * 1024,
        }),
      )
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
      const worker = JSON.parse(readFileSync(rssFile, 'utf8')) as { peakRssBytes: number }
      expect(worker.peakRssBytes).toBeGreaterThan(0)
      expect(worker.peakRssBytes).toBeLessThan(1024 * 1024 * 1024)
      console.info(
        JSON.stringify({
          dataset: 'ipc-1232-notes-5x20MiB-originals-v1',
          peakWorkerRssBytes: worker.peakRssBytes,
        }),
      )
    }
  } finally {
    // On Windows a worker's database files can stay locked for a moment after the process exits;
    // retry the removal (rm retries EPERM and EBUSY with a linear backoff) instead of failing on it.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 90_000)
