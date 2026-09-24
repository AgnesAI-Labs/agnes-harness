import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteStorage } from '@agnes/host'
import type { EventEnvelope } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createArtifactReadAuthorityPort,
  PersistentArtifactReadAuthorityIndex,
} from '../src/local/artifact-read-authority.js'
import { composeProductionProjectedArtifactRead } from '../src/supervisor/artifact-read.js'
import { WorkerRegistry } from '../src/supervisor/registry.js'
import type { WorkerPool } from '../src/supervisor/worker-pool.js'
import { sqliteTables } from './sqlite-tables.js'
import { workspaceBinding } from './workspace-authority.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A data directory whose one screenshot was reclaimed by retention: tombstone, no bytes. */
async function reclaimedStore(options: { tombstone: boolean }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agnes-reclaimed-open-'))
  roots.push(dataDir)
  const bytes = new TextEncoder().encode('screenshot reclaimed by retention')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (options.tombstone) {
    const metadataRoot = join(dataDir, 'artifacts', 'computer-use-meta')
    const shard = join(metadataRoot, sha256.slice(0, 2))
    await mkdir(shard, { recursive: true, mode: 0o700 })
    for (const directory of [join(dataDir, 'artifacts'), metadataRoot, shard]) await chmod(directory, 0o700)
    const path = join(shard, `${sha256}.json`)
    await writeFile(
      path,
      `${JSON.stringify(
        { schemaVersion: 2, sha256, size: bytes.byteLength, createdAtMs: 0, collectedAtMs: 1 },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
    await chmod(path, 0o600)
  }
  const tables = sqliteTables()
  const index = new PersistentArtifactReadAuthorityIndex(tables.table('artifact-read-authority'))
  const projected = composeProductionProjectedArtifactRead(dataDir, {
    authority: createArtifactReadAuthorityPort(index),
    writer: Object.freeze({ append: index.append.bind(index), revoke: index.revoke.bind(index) }),
    ownership: Object.freeze({ resolve: async () => Object.freeze({ active: true, principalId: 'local' }) }),
    limits: { maxArtifactBytes: 1024, maxResponseBytes: 1024 },
    operationTimeoutMs: 1_000,
    scopeTimeoutMs: 1_000,
  })
  return { dataDir, sha256, size: bytes.byteLength, tables, projected }
}

function screenshotRow(sha256: string): EventEnvelope {
  return {
    seq: 3,
    ts: '2026-09-17T00:00:00.000Z',
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0Z03',
    lane: 'main',
    type: 'tool/result',
    v: 1,
    actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    origin: 'tool:computer_use',
    trust: 'untrusted',
    sourceEventSeqs: [2],
    data: {
      toolUseId: 'call-1',
      content: [{ type: 'resource_link', name: 'image', uri: `artifact://${sha256}`, mimeType: 'image/png' }],
      isError: false,
      enforcement: { level: 'full', scope: [] },
      authz: { decisionId: 'n/a' },
    },
  } as unknown as EventEnvelope
}

/** Opens `key` on a worker whose replay scan is `scan` (by default: just the screenshot row). */
async function openOnWorker(
  store: Awaited<ReturnType<typeof reclaimedStore>>,
  key: string,
  scan: (params: Record<string, unknown>) => Promise<unknown> = async () => [screenshotRow(store.sha256)],
): Promise<{ opened: Promise<unknown>; retire: ReturnType<typeof vi.fn> }> {
  const link = {
    alive: true,
    hello: Promise.resolve({
      kind: 'hello' as const,
      token: `token-${key}`,
      sessionKey: key,
      writerRunId: `run-${key}`,
      generation: 1,
      profileHash: 'sha256-profile',
    }),
    onExit: vi.fn(),
    closeSession: vi.fn(async () => undefined),
    command: vi.fn(async (method: string, params: Record<string, unknown>) =>
      method === 'scan' ? scan(params) : undefined,
    ),
  }
  const retire = vi.fn()
  const registry = new WorkerRegistry(
    { acquire: vi.fn(async () => link), retire } as unknown as WorkerPool,
    store.projected.projection,
  )
  const opened = registry.open({
    key,
    cwd: '/workspace',
    resume: true,
    binding: await workspaceBinding(key, '/workspace'),
  })
  return { opened, retire }
}

describe.skipIf(process.platform === 'win32')('reopening a session whose screenshot was reclaimed', () => {
  it('opens an old session without retiring it, and readers see the screenshot as reclaimed', async () => {
    const key = 'old-session'
    {
      const store = await reclaimedStore({ tombstone: true })
      const { opened, retire } = await openOnWorker(store, key)
      await expect(opened).resolves.toBeDefined()
      expect(retire).not.toHaveBeenCalled()
      const artifact = { sha256: store.sha256, size: store.size, mime: 'image/png' }
      await expect(
        store.projected.rpc.read(
          { sessionId: key, laneId: 'main', artifact },
          { principalId: 'local', authKind: 'local', sessionId: key, laneId: 'main' },
        ),
      ).resolves.toMatchObject({ ok: false, status: 410, code: 'artifact_reclaimed' })
      await expect(
        store.projected.workerRead({
          sessionId: key,
          laneId: 'main',
          ownerId: 'local',
          sha256: store.sha256,
        }),
      ).resolves.toEqual({ reclaimed: true })
      // A lane the screenshot was never bound to learns nothing, reclaimed or not.
      await expect(
        store.projected.workerRead({
          sessionId: key,
          laneId: 'side',
          ownerId: 'local',
          sha256: store.sha256,
        }),
      ).resolves.toBeUndefined()
      await store.tables.close()
    }
  })

  it('opens a real fork whose inherited screenshot was reclaimed, and nothing past its fork point', async () => {
    const store = await reclaimedStore({ tombstone: true })
    const storage = createSqliteStorage({
      file: join(store.dataDir, 'sessions.db'),
      tablesDir: join(store.dataDir, 'tables'),
    })
    try {
      const later = createHash('sha256').update('parent screenshot after the fork').digest('hex')
      const shot = (sha256: string) => {
        const row = screenshotRow(sha256) as unknown as Record<string, unknown>
        const { seq: _seq, ...prepared } = row
        return { ...prepared, id: `01J6ZM2Q3R4S5T6V7W8X9Y0Z${sha256 === later ? '06' : '03'}` }
      }
      await storage.open('parent', { writerRunId: 'r1', ttlMs: 1_000 })
      await storage.commit('parent', { events: [shot(store.sha256) as never], expectedWriterRunId: 'r1' })
      await storage.createChild('parent', 1, 'child')
      await storage.commit('parent', { events: [shot(later) as never], expectedWriterRunId: 'r1' })
      const { opened, retire } = await openOnWorker(store, 'child', (params) =>
        storage.scan('child', params as never),
      )
      await expect(opened).resolves.toBeDefined()
      expect(retire).not.toHaveBeenCalled()
      const read = (sha256: string) =>
        store.projected.rpc.read(
          { sessionId: 'child', laneId: 'main', artifact: { sha256, size: store.size, mime: 'image/png' } },
          { principalId: 'local', authKind: 'local', sessionId: 'child', laneId: 'main' },
        )
      await expect(read(store.sha256)).resolves.toMatchObject({
        ok: false,
        status: 410,
        code: 'artifact_reclaimed',
      })
      await expect(read(later)).resolves.toMatchObject({ ok: false, status: 404 })
    } finally {
      await storage.close()
      await store.tables.close()
    }
  })

  it('still retires a session whose screenshot is missing without a tombstone', async () => {
    const store = await reclaimedStore({ tombstone: false })
    const { opened, retire } = await openOnWorker(store, 'lost-session')
    await expect(opened).rejects.toThrow()
    expect(retire).toHaveBeenCalledWith(['lost-session'], 'artifact-authority-replay-failed')
    await store.tables.close()
  })
})
