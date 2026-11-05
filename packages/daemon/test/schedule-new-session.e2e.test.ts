import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDaemonScheduleDb, openScheduleCatalog } from '@agnes/base/schedule'
import { JobsRepo } from '@agnes/daemon-foundation/jobs/repo'
import {
  canonicalJson,
  createSqliteStorage,
  DEFAULT_COMPUTER_USE,
  hashInput,
  type ResolvedProfile,
  sha256hex,
} from '@agnes/host'
import { createClient, memoryJournal } from '@agnes/sdk'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { afterEach, expect, it, vi } from 'vitest'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/supervisor/config.js'
import { daemonSocketPaths } from '../src/supervisor/socket-paths.js'
import { adaptHostTables } from '../src/supervisor/storage-adapters.js'
import { startSupervisor } from '../src/supervisor/supervisor.js'
import { localSdkTransport } from './local-socket-path.js'

vi.mock('@agnes/host-infrastructure/documents-directory', async (original) => ({
  ...(await original<typeof import('@agnes/host-infrastructure/documents-directory')>()),
  resolveDocumentsDirectory: (await import('./managed-documents-fixture.js')).fixtureDocumentsDirectory,
}))

// The same real-worker fixture as supervisor.e2e.test.ts: a real worker process over the internal
// wire, with a scripted model instead of credentials.
const workerSpawnOpts = {
  workerExecPath: process.execPath,
  workerEntry: fileURLToPath(new URL('./schedule-worker-entry.ts', import.meta.url)),
  workerExecArgv: ['--import', 'tsx'],
}
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
    home: dir,
    dataDir: dir,
    ...paths,
    limits: { ...DEFAULT_LIMITS, jobsTickMs: 250 },
  }
}

type Run = { outcome: string; sessionKey?: string; reason?: string; detail?: string; endedAt?: number }
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
          expect(run, run?.detail ?? run?.reason).toMatchObject({ outcome: 'ran' })
        },
        { timeout: 30_000, interval: 250 },
      )
      const sessionKey = run?.sessionKey
      expect(sessionKey).toBeTruthy()
      expect(sessionKey).not.toBe(origin.id)
      expect(run?.endedAt).toBeGreaterThan(0)

      const history = await sdk.call<import('@agnes/protocol').SchedulesHistoryResult>(
        '_agnes/v1/schedules.history',
        { id: created.id },
      )
      const receipt = history.runs[0]
      expect(receipt).toMatchObject({
        outcome: 'ran',
        read: false,
        sessionKey,
        snapshot: { title: 'Daily report', prompt: 'go', target: { kind: 'new-session', cwd } },
      })
      expect(receipt?.summary).toBeTypeOf('string')
      expect(
        await sdk.call('_agnes/v1/schedules.receipt', {
          id: created.id,
          runId: receipt?.id,
          read: true,
        }),
      ).toEqual({ updated: true })
      const unread = await sdk.call<import('@agnes/protocol').SchedulesHistoryResult>(
        '_agnes/v1/schedules.history',
        { id: created.id, unreadOnly: true },
      )
      expect(unread.runs).toEqual([])

      const reminder = await sdk.call<Task>('_agnes/v1/schedules.upsert', {
        title: 'Workspace reminder',
        prompt: 'Later',
        selector: { every_seconds: 3600 },
        target: { kind: 'session', sessionKey: origin.id },
      })
      const workspaceTasks = await sdk.call<{ schedules: Task[] }>('_agnes/v1/schedules.list', {
        scope: 'all',
        workspace: cwd,
        targetKind: 'session',
        search: 'Workspace reminder',
      })
      expect(workspaceTasks.schedules.map((task) => task.id)).toEqual([reminder.id])
      const elsewhere = await sdk.call<{ schedules: Task[] }>('_agnes/v1/schedules.list', {
        scope: 'all',
        workspace: join(dir, 'elsewhere'),
        targetKind: 'session',
      })
      expect(elsewhere.schedules).toEqual([])
      const independent = await sdk.call<{ schedules: Task[] }>('_agnes/v1/schedules.list', {
        scope: 'all',
        includeArchived: true,
        workspace: cwd,
        targetKind: 'new-session',
        search: 'Daily report',
      })
      expect(independent.schedules.map((task) => task.id)).toEqual([created.id])

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
  DEFAULT_LIMITS.workerStartupMs + 60_000,
)

it.each(['due', 'run-now'] as const)(
  'runs a never-run legacy task (%s) twice with distinct durable identities and preserves old files after restart and deletion',
  async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-legacy-schedule-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    mkdirSync(join(dir, 'chats'))
    const legacy = nativeRealpathSync(join(dir, 'chats'))
    writeFileSync(join(legacy, 'report.md'), 'old report')
    const profile = buildProfile(dir)
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify(profile))
    const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    const tables = adaptHostTables(storage.tables('@agnes/daemon'))
    const repo = new JobsRepo(tables.table('jobs'), Date.now)
    const catalog = openScheduleCatalog(openDaemonScheduleDb(tables.table('schedules')), repo.scheduleJobs())
    const task = catalog.create({
      title: 'Old report',
      prompt: 'go',
      selector: { every_seconds: 3600 },
      target: { kind: 'new-session', cwd: legacy },
    })
    if (mode === 'due') catalog.control(task.id, 'run')
    const open = () =>
      startSupervisor({
        config: configFor(dir),
        profile,
        profileDir: join(dir, 'profiles', 'local-dev'),
        profileFile,
        workspaceRoot: dir,
        jobTables: tables,
        ...workerSpawnOpts,
      })
    let sup = await open()
    let sdk = createClient({
      transport: localSdkTransport(sup.socketPath),
      journal: memoryJournal('legacy-schedule'),
    })
    const sessions: string[] = []
    const runIds: string[] = []
    let stage = 'copy'
    try {
      await expect(
        sdk.call('_agnes/v1/schedules.upsert', {
          title: 'Copied',
          prompt: 'go',
          selector: { every_seconds: 3600 },
          target: { kind: 'new-session', cwd: legacy },
        }),
      ).rejects.toBeDefined()
      for (let index = 0; index < 2; index++) {
        stage = `cycle ${index} control`
        if (index === 0 && mode === 'run-now') {
          await sdk.call('_agnes/v1/schedules.control', { id: task.id, action: 'pause' })
          await sdk
            .call('_agnes/v1/schedules.upsert', {
              id: task.id,
              title: 'Edited report',
              prompt: 'go again',
              selector: { every_seconds: 7200 },
              target: { kind: 'new-session', cwd: legacy, unattendedApproval: 'refuse' },
            })
            .catch((error) => {
              throw new Error(`legacy edit failed: ${JSON.stringify(error.data)}`)
            })
          await sdk.call('_agnes/v1/schedules.control', { id: task.id, action: 'resume' })
        }
        if (index > 0 || mode === 'run-now')
          await sdk.call('_agnes/v1/schedules.control', { id: task.id, action: 'run' })
        stage = `cycle ${index} history`
        await vi.waitFor(
          async () => {
            const history = await sdk.call<{ runs: { id: string; sessionKey: string; outcome: string }[] }>(
              '_agnes/v1/schedules.history',
              { id: task.id },
            )
            expect(history.runs).toHaveLength(index + 1)
            expect(history.runs[0]?.outcome).toBe('ran')
            sessions[index] = history.runs[0]!.sessionKey
            runIds[index] = history.runs[0]!.id
          },
          { timeout: 30000, interval: 250 },
        )
        stage = `cycle ${index} file read`
        expect(
          await sdk.call('_agnes/v1/session.workspace.read', {
            sessionId: sessions[index],
            path: 'report.md',
          }),
        ).toMatchObject({ text: 'old report' })
      }
      if (mode === 'run-now') {
        stage = 'current/legacy workspace isolation and file entry points'
        const legacySession = sessions[0]
        if (!legacySession) throw new Error('first legacy run has no session')
        const entries = await sdk.call<{ items: { path: string; managedRole?: string }[] }>(
          '_agnes/v1/workspace.list',
          {},
        )
        const current = entries.items.find((entry) => entry.managedRole === 'current')?.path
        if (!current) throw new Error('current managed chats root missing')
        expect(current).not.toBe(legacy)
        cleanup.push(() => rmSync(current, { recursive: true, force: true }))
        writeFileSync(join(current, 'report.md'), 'new report')
        writeFileSync(join(current, 'current-only.txt'), 'new root')
        writeFileSync(join(legacy, 'legacy-only.txt'), 'old root')
        const manual = await sdk.createSession({ cwd: current, sessionKey: randomUUID() })
        for (const [sessionId, expected, own, other] of [
          [manual.id, 'new report', 'current-only.txt', 'legacy-only.txt'],
          [legacySession, 'old report', 'legacy-only.txt', 'current-only.txt'],
        ] as const) {
          const files = await sdk.call<{ entries: { name: string }[] }>('_agnes/v1/session.workspace.list', {
            sessionId,
          })
          expect(files.entries.map((entry) => entry.name)).toContain(own)
          expect(files.entries.map((entry) => entry.name)).not.toContain(other)
          expect(
            await sdk.call('_agnes/v1/session.workspace.read', { sessionId, path: 'report.md' }),
          ).toMatchObject({ text: expected })
          stage = `references search ${own}`
          const references = await sdk.call<{ items: { source: string; id: string }[] }>(
            '_agnes/v1/session.references.search',
            { sessionId, query: `file ${own}` },
          )
          expect(references.items).toContainEqual(expect.objectContaining({ source: 'file', id: own }))
          stage = `references exclusion ${own}`
          const forbidden = await sdk.call<{ items: { id: string }[] }>(
            '_agnes/v1/session.references.search',
            { sessionId, query: `file ${other}` },
          )
          expect(forbidden.items).toEqual([])
          stage = `resolve @file ${own}`
          const selected = await sdk.session.load(sessionId, {
            cwd: expected === 'old report' ? legacy : current,
          })
          expect(
            await selected.prompt('check selected file', { references: [{ source: 'file', id: own }] }),
          ).toMatchObject({ reason: 'completed' })
          const uploadId = randomUUID()
          const bytes = Buffer.from(`uploaded to ${own}`)
          const sha256 = sha256hex(bytes.toString())
          const upload = (input: Record<string, unknown>) =>
            sdk.call<{ attachment?: { uri: string } }>('_agnes/v1/session.fileUpload', {
              sessionId,
              uploadId,
              ...input,
            })
          stage = `upload start ${own}`
          await upload({ operation: 'start', name: 'upload.txt', mimeType: 'text/plain', size: bytes.length })
          stage = `upload chunk ${own}`
          await upload({ operation: 'chunk', offset: 0, data: bytes.toString('base64'), sha256 })
          stage = `upload finish ${own}`
          const finished = await upload({ operation: 'finish', sha256 })
          expect(finished.attachment?.uri).toMatch(/^agnes-upload:\/\//)
          stage = `upload read ${own}`
          const uploadedPath = `.agnes-attachments/${sha256hex(sessionId)}/${uploadId}/${sha256}`
          expect(
            await sdk.call('_agnes/v1/session.workspace.read', { sessionId, path: uploadedPath }),
          ).toMatchObject({ text: bytes.toString() })
          expect(await sdk.call('_agnes/v1/session.workspace.changes', { sessionId })).toMatchObject({
            scope: 'session',
            files: expect.any(Array),
          })
        }
        stage = 'legacy fork'
        const parent = await sdk.session.load(legacySession, { cwd: legacy })
        const { timeline } = await parent.projectUIOpening({ surface: 'tui' })
        const at = timeline.turns.findLast((turn) => turn.forkable && turn.endSeq !== undefined)?.endSeq
        if (at === undefined) throw new Error('legacy scheduled run has no forkable boundary')
        const child = await sdk.session.fork(parent.id, at)
        expect(
          await sdk.call('_agnes/v1/session.workspace.read', { sessionId: child.id, path: 'report.md' }),
        ).toMatchObject({ text: 'old report' })
      }
      expect(sessions[0]).not.toBe(sessions[1])
      expect(runIds[0]).not.toBe(runIds[1])
      stage = 'archive'
      await sdk.call('_agnes/v1/schedules.archive', { id: task.id })
      await sdk.close()
      await sup.close()
      stage = 'restart'
      sup = await open()
      sdk = createClient({
        transport: localSdkTransport(sup.socketPath),
        journal: memoryJournal('legacy-restarted'),
      })
      stage = 'restarted load/read'
      for (const sessionId of sessions) {
        await sdk.session.load(sessionId, { cwd: legacy })
        stage = 'restarted file read'
        expect(
          await sdk.call('_agnes/v1/session.workspace.read', { sessionId, path: 'report.md' }),
        ).toMatchObject({ text: 'old report' })
      }
    } catch (error) {
      throw new Error(
        `${stage}: ${error instanceof Error ? error.message : error}; data=${JSON.stringify((error as { data?: unknown }).data)}`,
      )
    } finally {
      await sdk.close()
      await sup.close()
      await storage.close()
    }
  },
  DEFAULT_LIMITS.workerStartupMs + 90000,
)

it.each(['committed', 'opened'] as const)(
  'recovers an authenticated scheduled owner after failure at %s without replaying its prompt',
  async (phase) => {
    const { ManagedChatAuthority } = await import('@agnes/daemon-foundation/storage/managed-chat-authority')
    const { SessionPrincipalOwnershipIndex } = await import(
      '@agnes/daemon-foundation/storage/session-ownership'
    )
    const dir = mkdtempSync(join(tmpdir(), 'agnes-legacy-recover-owner-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    mkdirSync(join(dir, 'chats'))
    const legacy = nativeRealpathSync(join(dir, 'chats'))
    writeFileSync(join(legacy, 'report.md'), 'old report')
    const profile = buildProfile(dir)
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify(profile))
    const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    const tables = adaptHostTables(storage.tables('@agnes/daemon'))
    const repo = new JobsRepo(tables.table('jobs'), Date.now)
    const catalog = openScheduleCatalog(openDaemonScheduleDb(tables.table('schedules')), repo.scheduleJobs())
    const task = catalog.create({
      title: 'Interrupted',
      prompt: 'must not replay',
      selector: { every_seconds: 3600 },
      target: { kind: 'new-session', cwd: legacy },
    })
    const originalCommit = ManagedChatAuthority.prototype.commitScheduledBinding
    const fault =
      phase === 'committed'
        ? vi.spyOn(ManagedChatAuthority.prototype, 'commitScheduledBinding').mockImplementationOnce(function (
            this: InstanceType<typeof ManagedChatAuthority>,
            key,
          ) {
            originalCommit.call(this, key)
            throw new Error('injected after source commit')
          })
        : vi
            .spyOn(SessionPrincipalOwnershipIndex.prototype, 'activateNew')
            .mockImplementationOnce(() => false)
    const open = () =>
      startSupervisor({
        config: configFor(dir),
        profile,
        profileDir: join(dir, 'profiles', 'local-dev'),
        profileFile,
        workspaceRoot: dir,
        jobTables: tables,
        ...workerSpawnOpts,
      })
    let sup = await open()
    let sdk = createClient({
      transport: localSdkTransport(sup.socketPath),
      journal: memoryJournal('recover-pending-owner'),
    })
    try {
      await sdk.call('_agnes/v1/schedules.control', { id: task.id, action: 'run' })
      let sessionId = ''
      await vi.waitFor(
        async () => {
          const history = await sdk.call<{ runs: { outcome: string; sessionKey: string }[] }>(
            '_agnes/v1/schedules.history',
            { id: task.id },
          )
          expect(history.runs).toHaveLength(1)
          expect(history.runs[0]?.outcome).toBe('failed')
          sessionId = history.runs[0]?.sessionKey ?? ''
          expect(sessionId).not.toBe('')
        },
        { timeout: 30000, interval: 250 },
      )
      fault.mockRestore()
      const ownership = new SessionPrincipalOwnershipIndex(tables.table('session_principal_ownership'))
      expect(ownership.resolve(sessionId)).toBeUndefined()
      expect(ownership.ownsNewReservation(sessionId, 'local')).toBe(true)
      await sdk.call('_agnes/v1/schedules.archive', { id: task.id })
      await sdk.close()
      await sup.close()
      sup = await open()
      sdk = createClient({
        transport: localSdkTransport(sup.socketPath),
        journal: memoryJournal('recover-pending-owner-restarted'),
      })
      await sdk.session.load(sessionId, { cwd: legacy })
      expect(ownership.resolve(sessionId)).toMatchObject({ principalId: 'local', active: true })
      expect(
        await sdk.call('_agnes/v1/session.workspace.read', { sessionId, path: 'report.md' }),
      ).toMatchObject({ text: 'old report' })
      await sdk.session.load(sessionId, { cwd: legacy })
      const history = await sdk.call<{ runs: unknown[] }>('_agnes/v1/schedules.history', { id: task.id })
      expect(history.runs).toHaveLength(1)
    } finally {
      fault.mockRestore()
      await sdk.close()
      await sup.close()
      await storage.close()
    }
  },
  DEFAULT_LIMITS.workerStartupMs + 60000,
)
