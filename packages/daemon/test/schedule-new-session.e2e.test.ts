import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { afterEach, expect, it, vi } from 'vitest'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/supervisor/config.js'
import { daemonSocketPaths } from '../src/supervisor/socket-paths.js'
import { adaptHostTables } from '../src/supervisor/storage-adapters.js'
import { startSupervisor } from '../src/supervisor/supervisor.js'
import { localSdkTransport } from './local-socket-path.js'

// The same real-worker fixture as supervisor.e2e.test.ts: a real worker process over the internal
// wire, with a scripted model instead of credentials.
const workerSpawnOpts = {
  workerExecPath: process.execPath,
  workerEntry: fileURLToPath(new URL('./fake-worker-entry.ts', import.meta.url)),
  workerExecArgv: ['--import', 'tsx'],
}
const processIdentity = async (pid: number) =>
  pid === process.pid ? ({ state: 'alive', startId: 'schedule-e2e' } as const) : ({ state: 'dead' } as const)

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

function configFor(dir: string): DaemonConfig {
  const paths = daemonSocketPaths({ dataDir: dir, ipc: process.platform === 'win32' ? 'pipe' : 'unix' })
  if (process.platform !== 'win32' && dirname(paths.socketPath) !== join(dir, 'daemon')) {
    const socketDir = dirname(paths.socketPath)
    cleanup.push(() => rmSync(socketDir, { recursive: true, force: true }))
  }
  // A short tick so a task due in one second runs within the test.
  return {
    profileName: 'local-dev',
    dataDir: dir,
    ...paths,
    limits: { ...DEFAULT_LIMITS, workerStartupMs: 20_000, jobsTickMs: 250 },
  }
}

type Run = { outcome: string; sessionKey?: string; reason?: string; endedAt?: number }
type Task = { id: string; runs: Run[]; status: string; nextRunAt: number | null; target: { kind: string } }

it.each(['due', 'run-now'] as const)(
  'runs a %s new-session task in a fresh session of its workspace and finishes the turn',
  async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-schedule-new-session-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const profile = buildProfile(dir)
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify(profile))
    // Use the production table adapter, including its SQL scope and transaction checks.
    const storage = createSqliteStorage({
      file: join(dir, 'sessions.db'),
      tablesDir: join(dir, 'tables'),
    })
    const tables = adaptHostTables(storage.tables('@agnes/daemon'))
    const sup = await startSupervisor({
      config: configFor(dir),
      profile,
      profileDir: join(dir, 'profiles', 'local-dev'),
      profileFile,
      workspaceRoot: dir,
      jobTables: tables,
      processIdentity,
      ...workerSpawnOpts,
    })
    const sdk = createClient({
      transport: localSdkTransport(sup.socketPath),
      journal: memoryJournal('schedule-e2e'),
    })
    try {
      // Opening a session registers the workspace the task will name.
      const origin = await sdk.session.new({ cwd: dir })
      const workspaces = await sdk.call<{ items: { path: string }[] }>('_agnes/v1/workspace.list', {})
      const cwd = workspaces.items[0]?.path
      if (!cwd) throw new Error('no workspace registered')

      // A workspace that is not registered is refused before anything is saved.
      await expect(
        sdk.call('_agnes/v1/schedules.upsert', {
          title: 'Nowhere',
          prompt: 'go',
          selector: { every_seconds: 3600 },
          target: { kind: 'new-session', cwd: join(dir, 'not-a-workspace') },
        }),
      ).rejects.toMatchObject({ data: { code: 'workspace_missing' } })

      const created = await sdk.call<Task>('_agnes/v1/schedules.upsert', {
        title: 'Daily report',
        prompt: 'go',
        selector:
          mode === 'due' ? { after_seconds: 1 } : { daily: { time: '12:00', timeZone: 'Asia/Shanghai' } },
        target: {
          kind: 'new-session',
          cwd,
          ...(mode === 'run-now' ? { model: { route: 'faux', model: 'faux-1' } } : {}),
        },
      })
      expect(created.target).toMatchObject({ kind: 'new-session', cwd })
      if (mode === 'run-now') {
        expect(created.nextRunAt).toBeGreaterThan(Date.now())
        const queued = await sdk.call<Task>('_agnes/v1/schedules.control', { id: created.id, action: 'run' })
        expect(queued).toMatchObject({ id: created.id, status: 'active' })
        expect(queued.nextRunAt).toBeLessThanOrEqual(Date.now())
      }

      let run: Run | undefined
      await vi.waitFor(
        async () => {
          const listed = await sdk.call<{ schedules: Task[] }>('_agnes/v1/schedules.list', {
            scope: 'all',
            includeArchived: true,
          })
          run = listed.schedules.find((task) => task.id === created.id)?.runs.at(-1)
          expect(run).toMatchObject({ outcome: 'ran' })
        },
        { timeout: 30_000, interval: 250 },
      )
      const sessionKey = run?.sessionKey
      expect(sessionKey).toBeTruthy()
      expect(sessionKey).not.toBe(origin.id)
      expect(run?.endedAt).toBeGreaterThan(0)

      // The run's session is an ordinary session in that workspace, titled after the task and time.
      const sessions = await sdk.call<{ items: { sessionId: string; title?: string; cwd?: string }[] }>(
        '_agnes/v1/session.list',
        { limit: 50 },
      )
      const made = sessions.items.find((item) => item.sessionId === sessionKey)
      expect(made?.title).toMatch(/^Daily report · /)
      expect(made?.cwd).toBe(cwd)
      const opened = await sdk.session.load(sessionKey as string, { cwd })
      const timeline = await opened.projectUI()
      expect(timeline.turns).toHaveLength(1)
      expect(timeline.nodes.filter((node) => node.kind === 'user').map((node) => node.content)).toEqual([
        [{ type: 'text', text: 'go' }],
      ])
      // A one-time task ends after its run.
      const after = await sdk.call<{ schedules: Task[] }>('_agnes/v1/schedules.list', {
        scope: 'all',
        includeArchived: true,
      })
      const settled = after.schedules.find((task) => task.id === created.id)
      expect(settled?.status).toBe(mode === 'due' ? 'ended' : 'active')
      if (mode === 'run-now') {
        expect(settled?.nextRunAt).toBeGreaterThan(Date.now())
        // Run again from the same saved task: every occurrence must get its own conversation.
        await sdk.call('_agnes/v1/schedules.control', { id: created.id, action: 'run' })
        await vi.waitFor(
          async () => {
            const listed = await sdk.call<{ schedules: Task[] }>('_agnes/v1/schedules.list', { scope: 'all' })
            const task = listed.schedules.find((entry) => entry.id === created.id)
            expect(task?.runs.map((entry) => entry.outcome)).toEqual(['ran', 'ran'])
            expect(new Set(task?.runs.map((entry) => entry.sessionKey)).size).toBe(2)
            expect(task?.runs.at(-1)?.sessionKey).not.toBe(origin.id)
            expect(task?.nextRunAt).toBeGreaterThan(Date.now())
          },
          { timeout: 30_000, interval: 250 },
        )
      }
    } finally {
      await sdk.close()
      await sup.close()
      await storage.close()
    }
  },
  90_000,
)
