import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createArtifactReadAuthorityPort,
  createAuthenticatedArtifactReadHandler,
  PersistentArtifactReadAuthorityIndex,
} from '@agnes/daemon/local'
import type { ArtifactsSeam } from '@agnes/extension-api/seams'
import { createLocalArtifactReadStore } from '@agnes/host'
import { baseSeamFactories, createTestHost } from '@agnes/host/testkit'
import {
  type ArtifactReadParams,
  attachmentLink,
  type EventEnvelope,
  sessionArtifactRoots,
} from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import { hasPrivateDaclSync } from '@agnes/system-node'
import { expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { formatAgnes } from '../src/commands/export.js'
import { importFile } from '../src/commands/import.js'
import { bundleOriginals, readNativeBundle, writeNativeBundle } from '../src/commands/native-bundle.js'
import { memoryAdmission, openAdmittedSession } from './import-admission.js'

const original = Buffer.from('synthetic original bytes')
const ref = {
  sha256: createHash('sha256').update(original).digest('hex'),
  size: original.length,
  mime: 'text/plain',
}
const syntheticEvents = (): EventEnvelope[] => [
  {
    seq: 1,
    ts: '2026-10-15T00:00:00Z',
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
    type: 'user/message',
    lane: 'main',
    data: { content: [attachmentLink(ref, 'original.txt')] },
    actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    origin: 'principal',
    trust: 'trusted',
  },
]
const client = (bytes = original, sessionId = 's') =>
  ({
    call: async (_method: string, p: ArtifactReadParams) => {
      expect(_method).toBe('_agnes/v1/artifact.read')
      expect(p.sessionId).toBe(sessionId)
      expect(p.range).toBe(`bytes=0-${ref.size - 1}`)
      expect(p.laneId).toBe('main')
      expect(p.artifact).toEqual(ref)
      return {
        ok: true,
        status: 206,
        artifact: ref,
        acceptRanges: 'bytes',
        contentLength: bytes.length,
        contentRange: `bytes 0-${ref.size - 1}/${ref.size}`,
        etag: `"${ref.sha256}"`,
        base64: bytes.toString('base64'),
      }
    },
  }) as unknown as Client

it('round-trips current-product rows and original bytes through the public artifact seam', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-native-'))
  let failConfirmationFor: string | undefined
  const { host } = await createTestHost({
    dataDir: dir,
    seamFactories: {
      artifacts: async (init) => {
        const seam = (await baseSeamFactories.artifacts(init)) as ArtifactsSeam
        const attachments = seam.attachments
        if (!attachments) throw new Error('missing local attachment capability')
        return {
          ...seam,
          attachments: {
            ...attachments,
            confirm: async (scope, id) => {
              if (scope.sessionKey === failConfirmationFor) throw new Error('synthetic confirmation failure')
              await attachments.confirm(scope, id)
            },
          },
        } satisfies ArtifactsSeam
      },
    },
  })
  const admission = await memoryAdmission(host, dir)
  const source = await openAdmittedSession(host, admission, 'agnes:local:default:cli:dm:source', dir)
  try {
    const store = source.d.runtime.attachmentStore()
    expect(store).toBeDefined()
    const scope = { sessionKey: source.key, lane: 'main' }
    const receipt = await store?.store(scope, original, ref.mime, new AbortController().signal)
    if (!receipt || !store) throw new Error('missing selected attachment store')
    expect(receipt.artifact).toEqual(ref)
    expect(await store.authorize({ ...scope, lane: 'other' }, receipt, new AbortController().signal)).toBe(
      false,
    )
    const thumbnailBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    )
    const thumbnailReceipt = await store.store(
      scope,
      thumbnailBytes,
      'image/png',
      new AbortController().signal,
    )
    expect(await store.pendingRoots()).toMatchObject({
      complete: true,
      roots: expect.arrayContaining([ref, thumbnailReceipt.artifact]),
    })
    await source.append([
      {
        type: 'user/message',
        data: {
          kind: 'prompt',
          content: [
            attachmentLink(ref, 'original.txt', {
              thumbnail: thumbnailReceipt.artifact,
              receiptId: receipt.id,
            }),
          ],
        },
        actor: source.d.actor,
        origin: 'system',
        trust: 'trusted',
      },
    ])
    const rows = (await source.scan({ limit: 50 })) as EventEnvelope[]
    await store.confirm(scope, receipt.id)
    await store.confirm(scope, thumbnailReceipt.id)
    expect(await store.pendingRoots()).toEqual({ complete: true, roots: [] })
    const authorityDb = new DatabaseSync(':memory:')
    const authority = new PersistentArtifactReadAuthorityIndex({
      exec: (sql, params = []) => {
        authorityDb.prepare(sql).run(...(params as never[]))
      },
      get: <T>(sql: string, params: readonly unknown[] = []) =>
        authorityDb.prepare(sql).get(...(params as never[])) as T | undefined,
      all: <T>(sql: string, params: readonly unknown[] = []) =>
        authorityDb.prepare(sql).all(...(params as never[])) as T[],
      transaction: (fn) => {
        authorityDb.exec('BEGIN')
        try {
          const value = fn()
          authorityDb.exec('COMMIT')
          return value
        } catch (error) {
          authorityDb.exec('ROLLBACK')
          throw error
        }
      },
    })
    try {
      for (const row of rows)
        for (const artifact of sessionArtifactRoots(row) ?? []) {
          expect(
            authority.append(
              {
                permission: 'append',
                sessionId: source.key,
                laneId: row.lane ?? 'main',
                principalId: 'local',
              },
              { sessionId: source.key, laneId: row.lane ?? 'main', ownerId: 'local', artifact },
            ),
          ).toMatchObject({ ok: true })
        }
      const bytesStore = createLocalArtifactReadStore({ dataDir: dir, maxArtifactBytes: 1024 * 1024 })
      const read = createAuthenticatedArtifactReadHandler({
        authority: createArtifactReadAuthorityPort(authority),
        artifacts: { get: bytesStore.get, readRange: bytesStore.readRange },
        limits: { maxArtifactBytes: 1024 * 1024, maxResponseBytes: 1024 * 1024 },
        operationTimeoutMs: 1000,
      })
      const caller = { principalId: 'local', sessionId: source.key, laneId: 'main', authKind: 'local' }
      expect(
        await read({ sessionId: source.key, laneId: 'other', artifact: ref }, { ...caller, laneId: 'other' }),
      ).toMatchObject({ ok: false })
      const realClient = {
        call: async (_method: string, params: ArtifactReadParams) => {
          const result = await read(params, caller)
          return result.ok
            ? { ...result, ...result.headers, base64: Buffer.from(result.body).toString('base64') }
            : result
        },
      } as unknown as Client
      const path = join(dir, 'bundle.agnes')
      await writeNativeBundle(path, rows, formatAgnes(rows), realClient, source.key)
      const checked = await readNativeBundle(path, readFileSync(path))
      expect(Buffer.from(checked?.raw ?? [])).toEqual(Buffer.from(formatAgnes(rows)))
      expect(await checked?.readOriginal(ref)).toEqual(original)
      expect(await checked?.readOriginal(thumbnailReceipt.artifact)).toEqual(thumbnailBytes)
      // The thumbnail remains intact while the original is damaged; it cannot satisfy verification.
      writeFileSync(join(`${path}.artifacts`, ref.sha256), Buffer.alloc(original.length))
      await expect(readNativeBundle(path, readFileSync(path))).rejects.toThrow('digest')
      writeFileSync(join(`${path}.artifacts`, ref.sha256), original)
      const io = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } }
      const key = 'agnes:local:default:cli:dm:imported'
      await expect(
        importFile(parseArgs(['import', path, '--key', key]), { env: {}, cwd: dir, host, admission, io }),
      ).resolves.toBe(0)
      const imported = await openAdmittedSession(host, admission, key, dir)
      try {
        expect(Buffer.from(await imported.d.runtime.artifactGet(ref))).toEqual(original)
        expect(Buffer.from(await imported.d.runtime.artifactGet(thumbnailReceipt.artifact))).toEqual(
          thumbnailBytes,
        )
        const body = await imported.scan({ fromSeq: 2, limit: 50 })
        // Imported rows keep their sequence but arrive as untrusted history, never under their own labels.
        expect(body.map((row) => row.seq)).toEqual(rows.slice(1).map((row) => row.seq))
        for (const row of body) expect(row).toMatchObject({ origin: 'import:agnes', trust: 'untrusted' })
        expect(await imported.d.runtime.attachmentStore()?.pendingRoots()).toEqual({
          complete: true,
          roots: [],
        })
      } finally {
        await imported.close()
      }
      const failedKey = 'agnes:local:default:cli:dm:failed-import'
      failConfirmationFor = failedKey
      await expect(
        importFile(parseArgs(['import', path, '--key', failedKey]), {
          env: {},
          cwd: dir,
          host,
          admission,
          io,
        }),
      ).rejects.toThrow('rolled back')
      failConfirmationFor = undefined
      expect(await store.pendingRoots()).toEqual({ complete: true, roots: [] })
      const retry = await openAdmittedSession(host, admission, failedKey, dir)
      try {
        expect(retry.lastSeq).toBe(1)
      } finally {
        await retry.close()
      }
    } finally {
      authorityDb.close()
    }
  } finally {
    await source.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each(['changed', 'missing', 'symlink', 'manifest', 'ledger'] as const)(
  'rejects a %s original bundle before reserving a target',
  async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-native-refusal-'))
    const path = join(dir, 'bundle.agnes')
    const events = syntheticEvents()
    try {
      await writeNativeBundle(path, events, formatAgnes(events), client(), 's')
      const target = join(`${path}.artifacts`, ref.sha256)
      if (mode === 'changed') writeFileSync(target, Buffer.alloc(original.length))
      if (mode === 'missing') rmSync(target)
      if (mode === 'symlink') {
        rmSync(target)
        writeFileSync(join(dir, 'other'), original)
        symlinkSync(join(dir, 'other'), target)
      }
      if (mode === 'manifest')
        writeFileSync(
          path,
          readFileSync(path, 'utf8').replace(`"size":${formatAgnes(events).length}`, '"size":0'),
        )
      if (mode === 'ledger') writeFileSync(path, `${readFileSync(path, 'utf8')}{}\n`)
      const reserve = vi.fn()
      await expect(
        importFile(parseArgs(['import', path]), {
          env: {},
          cwd: dir,
          host: {} as never,
          admission: { reserve } as never,
          io: { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } },
        }),
      ).rejects.toThrow()
      expect(reserve).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

it('publishes nothing when the authorized original bytes have the wrong digest and preserves existing bundles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-native-export-'))
  const path = join(dir, 'bundle.agnes')
  const events = syntheticEvents()
  try {
    await expect(
      writeNativeBundle(path, events, formatAgnes(events), client(Buffer.alloc(original.length)), 's'),
    ).rejects.toThrow('digest')
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.artifacts`)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
    await writeNativeBundle(path, events, formatAgnes(events), client(), 's')
    expect(hasPrivateDaclSync(path)).toBe(true)
    expect(hasPrivateDaclSync(`${path}.artifacts`)).toBe(true)
    const before = readFileSync(path)
    await expect(writeNativeBundle(path, events, formatAgnes(events), client(), 's')).rejects.toThrow()
    expect(readFileSync(path)).toEqual(before)
    expect(readFileSync(join(`${path}.artifacts`, ref.sha256))).toEqual(original)
    expect(readdirSync(dir).sort()).toEqual(['bundle.agnes', 'bundle.agnes.artifacts'])
    expect(() => bundleOriginals([{ data: { uri: `artifact://${ref.sha256}` } }])).toThrow('identity')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
