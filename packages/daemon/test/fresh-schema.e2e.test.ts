import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalJson,
  createPlatform,
  DEFAULT_COMPUTER_USE,
  hashInput,
  type ResolvedProfile,
  sha256hex,
  sqlitePersistenceProvider,
} from '@agnes/host'
import { describe, expect, it } from 'vitest'
import { openHistoryIndex } from '../../history-index/src/store.js'
import { openArtifactRefIndex } from '../../host-artifacts/src/artifact-ref-index.js'
import { DATA_DIR_VERSION } from '../../host-infrastructure/src/adapters/storage-sqlite.js'
import { buildConfig, type DaemonConfig, DEFAULT_LIMITS } from '../src/supervisor/config.js'
import { type StartSupervisorOptions, startProductionSupervisor } from '../src/supervisor/supervisor.js'

function profile(dataDir: string): ResolvedProfile {
  const body = {
    name: 'local-dev',
    dataDir,
    transports: [],
    approvals: { mode: 'manual' },
    computerUse: DEFAULT_COMPUTER_USE,
    presets: { default: 'standard', allowed: ['standard'] },
  } as unknown as Omit<ResolvedProfile, 'hash'>
  return { ...body, hash: `sha256-${sha256hex(canonicalJson(hashInput(body)))}` }
}

function config(dataDir: string): DaemonConfig {
  return {
    ...buildConfig({
      args: { profile: 'local-dev' },
      profile: profile(dataDir),
      home: dataDir,
      ipc: createPlatform().snapshot().os === 'win32' ? 'pipe' : 'unix',
    }),
    limits: { ...DEFAULT_LIMITS, jobsTickMs: 60_000 },
  }
}

function options(dataDir: string): Omit<StartSupervisorOptions, 'jobTables'> {
  return {
    config: config(dataDir),
    profile: profile(dataDir),
    profileDir: join(dataDir, 'profiles', 'local-dev'),
    profileFile: join(dataDir, 'profile.json'),
    processIdentity: async (pid) =>
      pid === process.pid ? { state: 'alive', startId: 'production-storage-test' } : { state: 'dead' },
  }
}

const FILES = [
  'sessions.db',
  'tables/_40agnes_2fdaemon.db',
  'tables/_40agnes_2fdaemon_2fartifact-read-authority.db',
  'tables/metadata_3a_40agnes_2fbase.db',
  'history-index.db',
  'artifacts/computer-use-ref-index.db',
] as const

// Tables that earlier builds created and that no current code creates.
const RETIRED_TABLES = [
  'tool_index',
  'usage_ledger',
  'refine_queue',
  'approval_grants',
  'approval_grant_meta',
  'locked_package_receipts',
  'locked_package_receipt_meta',
  'computer_use_effects',
  'computer_use_effect_meta',
  'persistence_kv_migrations',
]

interface Shape {
  version: number
  objects: unknown[]
  tables: string[]
  columns: Record<string, string[]>
}

function read(file: string): Shape {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
    const columns = Object.fromEntries(
      tables.map((t) => [
        t,
        (db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>).map((c) => c.name),
      ]),
    )
    return {
      version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      objects: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all(),
      tables,
      columns,
    }
  } finally {
    db.close()
  }
}

describe('fresh data directory schema', () => {
  it('creates every database at its final schema from an empty data directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-fresh-schema-'))
    try {
      const o = options(dir)
      writeFileSync(o.profileFile, JSON.stringify(o.profile))
      const supervisor = await startProductionSupervisor(o)
      await supervisor.close()
      // Host-owned files are created by a worker; open their owners in-process over the same directory.
      const store = await sqlitePersistenceProvider.open({ dataDir: dir })
      if (!store.metadata) throw new Error('the sqlite provider must expose metadata')
      store.metadata.namespace('@agnes/base', 'fresh-schema')
      await store.close()
      openHistoryIndex(join(dir, 'history-index.db')).close()
      ;(await openArtifactRefIndex(dir)).close()

      const db = Object.fromEntries(FILES.map((f) => [f, read(join(dir, f))])) as Record<
        (typeof FILES)[number],
        Shape
      >
      expect(
        Object.fromEntries(FILES.map((f) => [f, { version: db[f].version, objects: db[f].objects }])),
      ).toMatchSnapshot()

      const sessions = db['sessions.db']
      expect(sessions.tables).toEqual([
        'budget_reservations',
        'budget_scopes',
        'child_ordinals',
        'child_tasks',
        'child_workspaces',
        'child_writer_gens',
        'cost_origins',
        'events',
        'ledger_integrity_failure_v1',
        'ledger_verified_head_v1',
        'registers',
        'sessions',
        'writer_claims',
      ])
      expect(sessions.version).toBe(DATA_DIR_VERSION)
      expect(sessions.columns.sessions).toEqual(
        expect.arrayContaining(['head_version', 'head_seq', 'head_digest']),
      )

      const daemon = db['tables/_40agnes_2fdaemon.db']
      for (const retired of [
        'approval_ticket_schema',
        'composite_target_overlays',
        'composite_target_commands',
        'schedule_targets',
        'schedule_run_progress',
        'session_bookmarks',
      ])
        expect(daemon.tables).not.toContain(retired)
      expect(daemon.columns.schedules).toEqual(expect.arrayContaining(['target', 'origin', 'search_text']))
      expect(daemon.columns.schedule_runs).toEqual(expect.arrayContaining(['progress']))
      expect(daemon.columns.schedule_run_receipts).toEqual([
        'run_rowid',
        'id',
        'snapshot',
        'summary',
        'is_read',
        'schedule_id',
      ])
      expect(daemon.columns.session_preferences).toEqual(expect.arrayContaining(['pinned_at', 'bookmarks']))
      expect(daemon.columns.workspace_registry).toEqual(expect.arrayContaining(['listed']))
      expect(daemon.columns.session_workspaces).toEqual(
        expect.arrayContaining([
          'title',
          'last_active_at',
          'loop_pin',
          'message_at',
          'message_seq',
          'sidebar_sort_at',
          'sidebar_failed',
          'sidebar_group',
          'sidebar_target_seq',
        ]),
      )

      expect(db['tables/metadata_3a_40agnes_2fbase.db'].tables).toEqual(['persistence_kv'])

      const history = db['history-index.db']
      expect(history.version).toBe(4)
      expect(history.columns.sessions).toContain('principal')
      expect(history.tables).not.toContain('readers')
      expect(history.tables).not.toContain('docs_fts_content')

      const tableFiles = readdirSync(join(dir, 'tables')).filter((f) => f.endsWith('.db'))
      expect(tableFiles.length).toBeGreaterThan(0)
      for (const file of tableFiles) {
        const { tables } = read(join(dir, 'tables', file))
        for (const retired of RETIRED_TABLES)
          expect(tables, `${file} still has ${retired}`).not.toContain(retired)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
