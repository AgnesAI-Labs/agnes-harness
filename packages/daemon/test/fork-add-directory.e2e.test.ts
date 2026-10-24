import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canonicalJson,
  createSqliteStorage,
  DEFAULT_COMPUTER_USE,
  hashInput,
  type ResolvedProfile,
  sha256hex,
} from '@agnes/host'
import { createClient, memoryJournal } from '@agnes/sdk'
import { afterEach, expect, it } from 'vitest'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/supervisor/config.js'
import { daemonSocketPaths } from '../src/supervisor/socket-paths.js'
import { adaptHostTables } from '../src/supervisor/storage-adapters.js'
import { startSupervisor } from '../src/supervisor/supervisor.js'
import { localSdkTransport } from './local-socket-path.js'

// A real supervisor and a real worker process (scripted model) over the internal wire: the path
// `/add-dir` takes, which the in-process endpoint tests never reach.
const workerSpawnOpts = {
  workerExecPath: process.execPath,
  workerEntry: fileURLToPath(new URL('./fake-worker-entry.ts', import.meta.url)),
  workerExecArgv: ['--import', 'tsx'],
}
const processIdentity = async (pid: number) =>
  pid === process.pid ? ({ state: 'alive', startId: 'fork-dir-e2e' } as const) : ({ state: 'dead' } as const)

function buildProfile(dataDir: string): ResolvedProfile {
  const body = {
    name: 'local-dev',
    dataDir,
    seams: { principals: { provider: 'local' } },
    approvals: { mode: 'manual' },
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

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const step of cleanup.splice(0)) step()
})
const tempDir = (prefix: string): string => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function configFor(dir: string): DaemonConfig {
  const paths = daemonSocketPaths({ dataDir: dir, ipc: process.platform === 'win32' ? 'pipe' : 'unix' })
  if (process.platform !== 'win32' && dirname(paths.socketPath) !== join(dir, 'daemon')) {
    const socketDir = dirname(paths.socketPath)
    cleanup.push(() => rmSync(socketDir, { recursive: true, force: true }))
  }
  return {
    profileName: 'local-dev',
    dataDir: dir,
    ...paths,
    limits: { ...DEFAULT_LIMITS, workerStartupMs: 20_000 },
  }
}

it('forks a session into one that can read an added directory, leaving the parent fenced out', async () => {
  const dir = tempDir('agnes-fork-dir-data-')
  const workspace = tempDir('agnes-fork-dir-ws-')
  const extra = tempDir('agnes-fork-dir-extra-')
  mkdirSync(join(extra, 'lib'))
  const secret = join(extra, 'lib', 'note.txt')
  writeFileSync(secret, 'library-marker-7341')
  const profile = buildProfile(dir)
  const profileFile = join(dir, 'profile.json')
  writeFileSync(profileFile, JSON.stringify(profile))
  const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
  const tables = adaptHostTables(storage.tables('@agnes/daemon'))
  process.env.AGNES_FAKE_WORKER_READ = '1'
  process.env.AGNES_FAKE_WORKER_TURNS = '4'
  const sup = await startSupervisor({
    config: configFor(dir),
    profile,
    profileDir: join(dir, 'profiles', 'local-dev'),
    profileFile,
    workspaceRoot: workspace,
    jobTables: tables,
    processIdentity,
    ...workerSpawnOpts,
  }).finally(() => {
    delete process.env.AGNES_FAKE_WORKER_READ
    delete process.env.AGNES_FAKE_WORKER_TURNS
  })
  const sdk = createClient({
    transport: localSdkTransport(sup.socketPath),
    journal: memoryJournal('fork-dir-e2e'),
  })
  try {
    const parent = await sdk.session.new({ cwd: workspace })
    await expect(parent.prompt('first turn')).resolves.toMatchObject({ reason: 'completed' })
    const { timeline } = await parent.projectUIOpening({ surface: 'tui' })
    const at = timeline.turns.findLast((t) => t.forkable && t.endSeq !== undefined)?.endSeq
    if (at === undefined) throw new Error('no completed turn to fork at')

    await sdk.workspace.add(extra)
    const child = await sdk.session.fork(parent.id, at, { additionalDirectories: [extra] })
    expect(child.id).not.toBe(parent.id)

    const listed = await sdk.session.list({ limit: 10 })
    const byId = new Map(listed.items.map((item) => [item.sessionId, item]))
    expect(byId.get(child.id)?.additionalDirectories).toEqual([extra])
    expect(byId.get(parent.id)).not.toHaveProperty('additionalDirectories')

    await expect(child.prompt(`read ${secret}`)).resolves.toMatchObject({ reason: 'completed' })
    await expect(parent.prompt(`read ${secret}`)).resolves.toMatchObject({ reason: 'completed' })
    const log = readFileSync(join(dir, 'read-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { path: string; isError: boolean; text: string })
    expect(log).toHaveLength(2)
    // The child's `read` saw the file; the parent's was refused by the file fence.
    expect(log[0]).toMatchObject({ isError: false })
    expect(log[0]?.text).toContain('library-marker-7341')
    expect(log[1]).toMatchObject({ isError: false, text: 'FS_ERROR:E_FS_DENIED' })
  } finally {
    await sdk.close()
    await sup.close()
    storage.close()
  }
}, 120_000)
