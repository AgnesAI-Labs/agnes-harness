import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteStorage } from '@agnes/host'
import type { ArtifactRef, EventEnvelope } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import { workspaceBinding } from '../../daemon-foundation/test/workspace-authority.js'
import {
  createArtifactReadAuthorityPort,
  PersistentArtifactReadAuthorityIndex,
} from '../src/local/artifact-read-authority.js'
import { composeProductionProjectedArtifactRead } from '../src/supervisor/artifact-read.js'
import { WorkerRegistry } from '../src/supervisor/registry.js'
import type { WorkerPool } from '../src/supervisor/worker-pool.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A data directory whose one screenshot was reclaimed by retention: tombstone, no bytes. */
async function reclaimedStore(options: { tombstone: boolean; maxArtifactBytes?: number }) {
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
  const tables = sqliteTables(join(dataDir, 'authority.sqlite'))
  const compose = (tables: ReturnType<typeof sqliteTables>) => {
    const index = new PersistentArtifactReadAuthorityIndex(tables.table('artifact-read-authority'))
    return composeProductionProjectedArtifactRead(dataDir, {
      authority: createArtifactReadAuthorityPort(index),
      writer: Object.freeze({ append: index.append.bind(index), revoke: index.revoke.bind(index) }),
      ownership: Object.freeze({
        resolve: async () => Object.freeze({ active: true, principalId: 'local' }),
      }),
      limits: { maxArtifactBytes: options.maxArtifactBytes ?? 1024, maxResponseBytes: 1024 },
      operationTimeoutMs: 1_000,
      scopeTimeoutMs: 1_000,
    })
  }
  return { dataDir, sha256, size: bytes.byteLength, tables, projected: compose(tables), compose }
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
) {
  const link = {
    alive: true,
    hello: Promise.resolve({
      kind: 'hello' as const,
      token: `token-${key}`,
      sessionKey: key,
      writerRunId: `run-${key}`,
      generation: 1,
      profileHash: 'sha256-profile',
      lastSeq: 3,
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
  return { opened, retire, registry }
}

describe.skipIf(process.platform === 'win32')('reopening a session whose screenshot was reclaimed', () => {
  it.each([
    { scenario: 'large storage', metadata: {} },
    { scenario: 'MIME aliases', metadata: {} },
    { scenario: 'remote provider', metadata: {} },
    { scenario: 'MIME parameters', metadata: { mime: 'text/plain; charset=utf-8' } },
    { scenario: 'MIME case', metadata: { mime: 'Text/Plain' } },
    { scenario: 'empty MIME', metadata: { mime: '' } },
    { scenario: 'MIME trailing terminator', metadata: { mime: 'text/plain\n' } },
    { scenario: 'MIME controls', metadata: { mime: 'text/plain\r\nX-Fixture: synthetic\u0000' } },
    { scenario: 'MIME Unicode at length bound', metadata: { mime: '😀'.repeat(64) } },
    { scenario: 'MIME unpaired surrogate', metadata: { mime: 'text/\ud800' } },
    { scenario: 'wide size', metadata: { size: 2 ** 53 } },
    { scenario: 'maximum number size', metadata: { size: Number.MAX_VALUE } },
  ] satisfies { scenario: string; metadata: Partial<ArtifactRef> }[])(
    'keeps the ordered tail and cold recovery usable after $scenario',
    async ({ scenario, metadata }) => {
      const store = await reclaimedStore({ tombstone: false, maxArtifactBytes: 32 * 1024 * 1024 })
      const key = `storage-${scenario}`
      const small = new TextEncoder().encode('ordinary strict read')
      const ordinary: ArtifactRef = {
        sha256: createHash('sha256').update(small).digest('hex'),
        size: small.byteLength,
        mime: 'text/plain',
      }
      const problematic: ArtifactRef =
        scenario === 'large storage'
          ? {
              sha256: createHash('sha256')
                .update(new Uint8Array(33 * 1024 * 1024))
                .digest('hex'),
              size: 33 * 1024 * 1024,
              mime: 'application/octet-stream',
            }
          : scenario === 'remote provider'
            ? {
                sha256: createHash('sha256').update('remote-only bytes').digest('hex'),
                size: 17,
                mime: 'text/plain',
              }
            : {
                ...ordinary,
                sha256:
                  'size' in metadata ? createHash('sha256').update(scenario).digest('hex') : ordinary.sha256,
                mime: 'text/html',
                ...metadata,
              }
      const put = async (ref: ArtifactRef, bytes: Uint8Array) => {
        const shard = join(store.dataDir, 'artifacts', 'sha256', ref.sha256.slice(0, 2))
        await mkdir(shard, { recursive: true })
        await writeFile(join(shard, ref.sha256), bytes)
      }
      await put(ordinary, small)
      const laterBytes = new TextEncoder().encode('normal file stored after the unsupported reference')
      const later = {
        ...ordinary,
        sha256: createHash('sha256').update(laterBytes).digest('hex'),
        size: laterBytes.byteLength,
      }
      await put(later, laterBytes)
      if (scenario === 'large storage') await put(problematic, new Uint8Array(problematic.size))
      const registration = (artifact: ArtifactRef, seq: number): EventEnvelope =>
        ({
          ...screenshotRow(artifact.sha256),
          seq,
          type: 'x/core/artifact.registered',
          origin: 'system',
          trust: 'trusted',
          data: { artifact },
        }) as EventEnvelope
      const rows = [registration(ordinary, 1), registration(problematic, 2), registration(later, 3)]
      const read = (artifact: ArtifactRef, laneId = 'main') =>
        store.projected.rpc.read(
          { sessionId: key, laneId, artifact },
          { principalId: 'local', authKind: 'local', sessionId: key, laneId },
        )
      try {
        const live = await openOnWorker(store, key, async () => [])
        await live.opened
        const seen: number[] = []
        const stop = live.registry.subscribe(key, (event) => seen.push(event.seq))
        // Exercise the actual ordered queue, including events queued after the storage fact.
        const delivered = rows.map((row) => live.registry.deliver(key, row))
        await expect(Promise.all(delivered)).resolves.toBeDefined()
        expect(seen).toEqual([1, 2, 3])
        await expect(live.registry.ensureArtifactAuthority(key, 3)).resolves.toBeUndefined()
        await expect(read(later)).resolves.toMatchObject({ ok: true, artifact: later })
        stop()
        await store.tables.close()
        const reopened = sqliteTables(join(store.dataDir, 'authority.sqlite'))
        store.tables = reopened
        store.projected = store.compose(reopened)
        const cold = await openOnWorker(store, key, async () => rows)
        await expect(cold.opened).resolves.toBeDefined()
        expect(cold.retire).not.toHaveBeenCalled()
        await expect(read(later)).resolves.toMatchObject({ ok: true, artifact: later })
        await expect(read(ordinary)).resolves.toMatchObject({
          ok: true,
          artifact: ordinary,
          headers: { contentType: ordinary.mime },
        })
        await expect(read({ ...ordinary, size: ordinary.size + 1 })).resolves.toMatchObject({
          ok: false,
          status: 409,
        })
        await expect(read({ ...ordinary, sha256: 'f'.repeat(64) })).resolves.toMatchObject({
          ok: false,
          status: 404,
        })
        await expect(read(ordinary, 'other')).resolves.toMatchObject({ ok: false })
        if (scenario === 'MIME aliases') {
          await expect(read(problematic)).resolves.toMatchObject({
            ok: true,
            artifact: problematic,
            headers: { contentType: problematic.mime },
          })
          await expect(read({ ...ordinary, mime: 'image/png' })).resolves.toMatchObject({ ok: false })
          store.projected.projection.revokeLane(key, 'main')
          await expect(read(ordinary)).resolves.toMatchObject({ ok: false })
          await expect(read(problematic)).resolves.toMatchObject({ ok: false })
        } else {
          await expect(read(problematic)).resolves.toMatchObject({
            ok: false,
            status: scenario === 'large storage' ? 413 : scenario === 'remote provider' ? 500 : 400,
            code:
              scenario === 'large storage'
                ? 'artifact_too_large'
                : scenario === 'remote provider'
                  ? 'artifact_unavailable'
                  : 'invalid_request',
          })
        }
      } finally {
        await store.tables.close()
      }
    },
  )

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
