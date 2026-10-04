import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { createConformanceHarness, SCENARIOS } from '@agnes/extension-api/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TransferContractPort } from '../../../../packages/extension-api/testkit/runtime/contracts/authority-transfer.js'
import type { BlobContractPort } from '../../../../packages/extension-api/testkit/runtime/contracts/blob.js'
import { createReferenceRegistry } from '../index.js'
import { BLOB_PROVIDER, type BlobStore, type BlobStoreOptions, openBlobStore, PIECE_BYTES } from './blob.js'
import { bindBlobContract, damage } from './blob-contract.js'
import type { TransferMaintenance } from './blob-transfer.js'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const bytesOf = (size: number) => new Uint8Array(size).map((_, index) => (index * 13) % 256)

function ctx(authorizationRef = 'reader', signal = new AbortController().signal): CallContext {
  return {
    principalRef: 'user-1',
    scope: { kind: 'runtime', installationId: 'install-1', runtimeId: 'runtime-1' },
    bindingId: 'binding-1',
    invocationId: 'invocation-1',
    deadline: '2026-10-02T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef,
    signal,
  }
}

const refused = (outcome: Outcome<unknown>) => (outcome.ok ? null : outcome.error.detailCode)

function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.value
}

async function collect(stream: { chunks: AsyncIterable<Uint8Array> }): Promise<number[]> {
  const sizes: number[] = []
  for await (const chunk of stream.chunks) sizes.push(chunk.byteLength)
  return sizes
}

let directory: string
let path: string
let store: BlobStore

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'reference-blob-'))
  path = join(directory, 'blob.sqlite')
  store = openBlobStore(path, { authorizeRead: (context) => context.authorizationRef === 'reader' })
})

afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('reference blob store', () => {
  it('reads ranges across piece boundaries and streams one piece per pull', async () => {
    const bytes = bytesOf(PIECE_BYTES * 2 + 5)
    const ref = store.seed(bytes, 'application/pdf')
    expect(ref).toMatchObject({ bytes: bytes.byteLength, digest: sha(bytes), mediaType: 'application/pdf' })
    const across = must(await store.blobRead.readRange({ ref, offset: PIECE_BYTES - 2, length: 4 }, ctx()))
    expect(across).toEqual({
      bytes: bytes.subarray(PIECE_BYTES - 2, PIECE_BYTES + 2),
      offset: PIECE_BYTES - 2,
      totalBytes: bytes.byteLength,
      digest: sha(bytes.subarray(PIECE_BYTES - 2, PIECE_BYTES + 2)),
    })
    const stream = must(await store.blobRead.openRead({ ref, offset: 3 }, ctx()))
    expect(await collect(stream)).toEqual([PIECE_BYTES - 3, PIECE_BYTES, 5])
    expect(await stream.ended).toEqual({
      ok: true,
      value: { bytes: bytes.byteLength - 3, digest: sha(bytes.subarray(3)) },
    })
  })

  it('refuses every read without a Host read check, and a reference to another object', async () => {
    const ref = store.seed(bytesOf(4))
    const unchecked = openBlobStore(path)
    try {
      expect(refused(await unchecked.blobRead.readRange({ ref, offset: 0, length: 1 }, ctx()))).toBe(
        'blocked',
      )
    } finally {
      unchecked.close()
    }
    const other = store.seed(bytesOf(5))
    const forged = { ...ref, pinId: other.pinId }
    expect(refused(await store.blobRead.readRange({ ref: forged, offset: 0, length: 1 }, ctx()))).toBe(
      'not_found',
    )
    expect(refused(await store.blobRead.openRead({ ref: { ...ref, bytes: 5 }, offset: 0 }, ctx()))).toBe(
      'not_found',
    )
  })

  it('finds a damaged piece at the read that needs it', async () => {
    const bytes = bytesOf(PIECE_BYTES + 10)
    const ref = store.seed(bytes)
    const changed = bytes.slice()
    changed[PIECE_BYTES + 1] = (changed[PIECE_BYTES + 1] ?? 0) ^ 1
    damage(path, ref.blobId, changed)
    expect(must(await store.blobRead.readRange({ ref, offset: 0, length: 8 }, ctx())).bytes).toEqual(
      bytes.subarray(0, 8),
    )
    expect(refused(await store.blobRead.readRange({ ref, offset: PIECE_BYTES, length: 8 }, ctx()))).toBe(
      'integrity',
    )
  })

  it('keeps pinned objects across a reopen and refuses every call once closed', async () => {
    const bytes = bytesOf(9)
    const ref = store.seed(bytes)
    store.close()
    expect(() => store.seed(bytes)).toThrow('blob store is closed')
    expect(refused(await store.blobRead.readRange({ ref, offset: 0, length: 9 }, ctx()))).toBe('blocked')
    expect(existsSync(path)).toBe(true)
    store = openBlobStore(path, { authorizeRead: () => true })
    expect(must(await store.blobRead.readRange({ ref, offset: 0, length: 9 }, ctx())).digest).toBe(sha(bytes))
  })

  it('promotes a sealed upload, pins it once per owner and reports the pin', async () => {
    const bytes = bytesOf(PIECE_BYTES + 3)
    const upload = store.upload(bytes, 'text/plain')
    const wrong = { upload, expectedDigest: sha(bytesOf(1)) }
    expect(refused(await store.promote(wrong, ctx()))).toBe('integrity')
    const stagedBlob = must(await store.promote({ upload, expectedDigest: upload.digest }, ctx()))
    const ownerRef = { kind: 'artifact', value: { artifactId: 'artifact-1', version: 1 } } as const
    const pinned = must(await store.pin({ stagedBlob, ownerRef, retentionUntil: null }, ctx()))
    expect(must(await store.pin({ stagedBlob, ownerRef, retentionUntil: null }, ctx()))).toEqual(pinned)
    expect(must(await store.inspect({ ref: { kind: 'blob', value: pinned } }, ctx()))).toEqual({
      status: 'pinned',
      bytes: bytes.byteLength,
      digest: sha(bytes),
      ownerRefs: [ownerRef],
    })
    const tail = must(await store.blobRead.readRange({ ref: pinned, offset: PIECE_BYTES, length: 9 }, ctx()))
    expect(tail.bytes).toEqual(bytes.subarray(PIECE_BYTES))
  })

  it('releases a pin once and logs it; gc collects only what no pin or sealed upload holds', async () => {
    const kept = store.seed(bytesOf(3))
    const dropped = store.seed(bytesOf(PIECE_BYTES + 1))
    const upload = store.upload(bytesOf(4))
    const stagedBlob = must(await store.promote({ upload, expectedDigest: upload.digest }, ctx()))
    const ownerRef = { kind: 'artifact', value: { artifactId: 'artifact-1', version: 1 } } as const
    const held = must(await store.pin({ stagedBlob, ownerRef, retentionUntil: null }, ctx()))
    const unpin = (ref: { pinId: string }, expectedRevision = 1) =>
      store.unpin({ pinId: ref.pinId, expectedRevision }, ctx())
    expect(refused(await unpin(dropped, 2))).toBe('revision_conflict')
    expect(refused(await unpin({ pinId: 'missing' }))).toBe('not_found')
    expect(must(await unpin(dropped))).toEqual({ released: true })
    expect(must(await unpin(dropped))).toEqual({ released: false })
    expect(must(await unpin(held))).toEqual({ released: true })
    expect(refused(await store.blobRead.readRange({ ref: dropped, offset: 0, length: 1 }, ctx()))).toBe(
      'revoked',
    )
    expect(must(await store.inspect({ ref: { kind: 'blob', value: dropped } }, ctx())).status).toBe('staged')
    expect(store.deletionWatermark()).toBe(2)

    const gc = (over: object = {}) =>
      store.gc({ scopeRef: ctx().scope, dryRun: false, cursor: null, limit: 1, ...over }, ctx())
    expect(refused(await gc({ limit: 0 }))).toBe('invalid_request')
    expect(refused(await gc({ scopeRef: { kind: 'installation', installationId: 'install-2' } }))).toBe(
      'permission_denied',
    )
    const collected = {
      kind: 'staged-blob',
      value: expect.objectContaining({ blobId: dropped.blobId, digest: dropped.digest }),
    }
    expect(must(await gc({ dryRun: true, limit: 10 }))).toEqual({
      eligibleRefs: [collected],
      deletedRefs: [],
      nextCursor: null,
    })
    expect(store.deletionWatermark()).toBe(2)
    const deleted: unknown[] = []
    let cursor: string | null = null
    do {
      const page = must(await gc({ cursor }))
      expect(page.eligibleRefs.length).toBeLessThanOrEqual(1)
      deleted.push(...page.deletedRefs)
      cursor = page.nextCursor
    } while (cursor !== null)
    expect(deleted).toEqual([collected])
    expect(must(await gc({ limit: 10 })).eligibleRefs).toEqual([])

    expect(store.deletions()).toEqual([
      {
        seq: 1,
        kind: 'pin-released',
        ref: { kind: 'blob', value: dropped },
        digest: dropped.digest,
        at: expect.any(Number),
      },
      {
        seq: 2,
        kind: 'pin-released',
        ref: { kind: 'blob', value: held },
        digest: held.digest,
        at: expect.any(Number),
      },
      { seq: 3, kind: 'blob-deleted', ref: collected, digest: dropped.digest, at: expect.any(Number) },
    ])
    expect(store.deletionWatermark()).toBe(3)
    const db = new DatabaseSync(path)
    try {
      const count = (blobId: string) =>
        (db.prepare('SELECT COUNT(*) AS n FROM pieces WHERE blob_id = ?').get(blobId) as { n: number }).n
      expect([count(dropped.blobId), count(kept.blobId), count(held.blobId)]).toEqual([0, 1, 1])
    } finally {
      db.close()
    }
    expect(refused(await store.blobRead.readRange({ ref: dropped, offset: 0, length: 1 }, ctx()))).toBe(
      'artifact_deleted',
    )
    expect(must(await store.inspect({ ref: { kind: 'blob', value: dropped } }, ctx())).status).toBe('deleted')
    expect(must(await store.blobRead.readRange({ ref: kept, offset: 0, length: 3 }, ctx())).bytes).toEqual(
      bytesOf(3),
    )
    const again = must(await store.pin({ stagedBlob, ownerRef, retentionUntil: null }, ctx()))
    expect(again.pinId).not.toBe(held.pinId)
    expect(must(await store.blobRead.readRange({ ref: again, offset: 0, length: 4 }, ctx())).bytes).toEqual(
      bytesOf(4),
    )
  })
})

describe('reference blob authority transfer', () => {
  const MAINTAINER = ctx('maintainer')
  const UPGRADE = 'upgrade-1'
  const expected = { authorityId: 'reference-blob', tenantId: 'tenant-1', authorityEpoch: 1 }
  const opened: BlobStore[] = []
  afterEach(() => {
    for (const each of opened.splice(0)) each.close()
  })

  /** A store at `locationRef` with a maintenance assembly; an import reads from `source`. */
  function at(locationRef: string, options: BlobStoreOptions = {}, source?: BlobStore): BlobStore {
    const maintenance: TransferMaintenance = {
      authorize: (context) => context.authorizationRef === 'maintainer',
      tenantId: 'tenant-1',
      locationRef,
      readRoute: async () => {
        throw new Error('these stores are never activated or aborted')
      },
      readSource: (ref, context) => {
        if (!source) throw new Error('this store imports nothing')
        return source.readExport(ref, context)
      },
      planFingerprint: sha(bytesOf(1)),
    }
    const opening = openBlobStore(join(directory, `${locationRef}.sqlite`), {
      authorizeRead: (context) => context.authorizationRef === 'reader',
      maintenance,
      ...options,
    })
    opened.push(opening)
    return opening
  }

  async function exported(source: BlobStore) {
    const fence = must(
      await source.transfer.fence(
        { upgradeId: UPGRADE, expected, cohortDigest: sha(bytesOf(2)) },
        MAINTAINER,
      ),
    )
    return {
      fence,
      exported: must(
        await source.transfer.export({ upgradeId: UPGRADE, fenceId: fence.fenceId }, MAINTAINER),
      ),
    }
  }

  it('refuses every business write as blocked while fenced, keeps reads, and a candidate serves nothing', async () => {
    const source = at('source')
    const ref = source.seed(bytesOf(5))
    const upload = source.upload(bytesOf(6))
    const stagedBlob = must(await source.promote({ upload, expectedDigest: upload.digest }, ctx()))
    await exported(source)
    const ownerRef = { kind: 'artifact', value: { artifactId: 'artifact-1', version: 1 } } as const
    expect(() => source.seed(bytesOf(1))).toThrow('store is fenced or a transfer candidate')
    expect(() => source.upload(bytesOf(1))).toThrow('store is fenced or a transfer candidate')
    expect(refused(await source.pin({ stagedBlob, ownerRef, retentionUntil: null }, ctx()))).toBe('blocked')
    expect(refused(await source.unpin({ pinId: ref.pinId, expectedRevision: 1 }, ctx()))).toBe('blocked')
    const gc = { scopeRef: ctx().scope, dryRun: false, cursor: null, limit: 10 }
    expect(refused(await source.gc(gc, ctx()))).toBe('blocked')
    expect(must(await source.blobRead.readRange({ ref, offset: 0, length: 5 }, ctx())).bytes).toEqual(
      bytesOf(5),
    )
    const candidate = at('target', { candidate: true })
    expect(() => candidate.seed(bytesOf(1))).toThrow('store is fenced or a transfer candidate')
    expect(refused(await candidate.blobRead.readRange({ ref, offset: 0, length: 1 }, ctx()))).toBe('blocked')
  })

  it('pages more than 500 parts through a two-level manifest and imports every one of them', async () => {
    const source = at('source', { exportPart: { records: 1, bytes: PIECE_BYTES } })
    for (let index = 0; index < 200; index += 1) source.seed(bytesOf(1))
    const { fence, exported: manifest } = await exported(source)
    expect(manifest).toMatchObject({ partCount: 600, collectionCount: 3, deletionWatermark: 0 })
    const root = manifest.manifestRoot
    if (root.kind !== 'blob') throw new Error('manifest root is not a blob')
    expect(root.blob.bytes).toBeLessThanOrEqual(1024 * 1024)
    const pieces: Uint8Array[] = []
    for await (const piece of source.readExport(root.blob, MAINTAINER)) pieces.push(piece)
    const top = JSON.parse(Buffer.concat(pieces).toString('utf8')) as {
      level: number
      entries: { count: number }[]
    }
    expect([top.level, top.entries.map((entry) => entry.count)]).toEqual([1, [500, 100]])

    const page = (over: object) =>
      source.transfer.exportPage(
        {
          upgradeId: UPGRADE,
          fenceId: fence.fenceId,
          manifestDigest: root.blob.digest,
          cursor: null,
          limit: 500,
          ...over,
        },
        MAINTAINER,
      )
    expect(refused(await page({ limit: 501 }))).toBe('invalid_request')
    expect(refused(await page({ cursor: 'not-a-cursor' }))).toBe('invalid_request')
    const first = must(await page({}))
    expect([first.items.length, first.complete]).toEqual([500, false])
    expect(refused(await page({ cursor: first.nextCursor, manifestDigest: sha(bytesOf(3)) }))).toBe(
      'revision_conflict',
    )
    const rest = must(await page({ cursor: first.nextCursor }))
    expect([rest.items.length, rest.nextCursor, rest.complete]).toEqual([100, null, true])

    const target = at('target', { candidate: true }, source)
    const imported = must(
      await target.transfer.import(
        { upgradeId: UPGRADE, source: manifest, targetLocationRef: 'target' },
        MAINTAINER,
      ),
    )
    expect(imported.targetCheckpoint).toMatchObject({
      snapshotDigest: fence.checkpoint.snapshotDigest,
      recordCount: 600,
    })
  })

  it('exports the same manifest for the same records and never imports past the deletion watermark', async () => {
    let source = at('source')
    const dropped = source.seed(bytesOf(3))
    source.seed(bytesOf(PIECE_BYTES + 1))
    must(await source.unpin({ pinId: dropped.pinId, expectedRevision: 1 }, ctx()))
    must(await source.gc({ scopeRef: ctx().scope, dryRun: false, cursor: null, limit: 10 }, ctx()))
    source.close()
    copyFileSync(join(directory, 'source.sqlite'), join(directory, 'copy.sqlite'))
    source = at('source')
    const original = (await exported(source)).exported
    expect((await exported(at('copy'))).exported.manifestRoot).toEqual(original.manifestRoot)
    expect(original.deletionWatermark).toBe(2)

    const request = (manifest: typeof original, targetLocationRef: string) => ({
      upgradeId: UPGRADE,
      source: manifest,
      targetLocationRef,
    })
    const short = at('short', { candidate: true }, source)
    expect(
      refused(
        await short.transfer.import(request({ ...original, deletionWatermark: 1 }, 'short'), MAINTAINER),
      ),
    ).toBe('integrity')
    const target = at('target', { candidate: true }, source)
    must(await target.transfer.import(request(original, 'target'), MAINTAINER))
    expect(target.deletions().map((row) => [row.kind, row.digest])).toEqual(
      source.deletions().map((row) => [row.kind, row.digest]),
    )
    const db = new DatabaseSync(join(directory, 'target.sqlite'))
    try {
      expect(
        db
          .prepare(
            'SELECT deleted, (SELECT COUNT(*) FROM pieces WHERE blob_id = ?) AS pieces FROM objects WHERE blob_id = ?',
          )
          .get(dropped.blobId, dropped.blobId),
      ).toEqual({ deleted: 1, pieces: 0 })
    } finally {
      db.close()
    }
  })
})

describe('reference blob: conformance', () => {
  it('fills the blob slot of the reference registry', () => {
    const slot = createReferenceRegistry([BLOB_PROVIDER]).find((item) => item.contract === 'agh.blob')
    expect(slot?.provider).toEqual(BLOB_PROVIDER)
    expect(slot?.providerFile).toBe('examples/runtime-reference/src/providers/blob.ts')
    expect(existsSync(new URL(`../../../../${slot?.providerFile}`, import.meta.url))).toBe(true)
  })

  async function runContract(
    change: (port: BlobContractPort) => BlobContractPort,
    changeTransfer: (port: TransferContractPort) => TransferContractPort = (port) => port,
  ) {
    const harness = createConformanceHarness()
    const bound = bindBlobContract(harness, 'reference-blob-conformance', { change, changeTransfer })
    try {
      return await harness.run({
        contracts: ['agh.blob'],
        providers: [BLOB_PROVIDER.id],
        command: 'reference-blob-conformance',
        clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
      })
    } finally {
      bound.close()
    }
  }

  it('passes select, normal, deny, cancel, recover and dispose for reads and for authority transfer', async () => {
    const report = await runContract((port) => port)
    expect(report.assertions.map((item) => [item.id, item.status])).toEqual(
      ['', '/authority-transfer'].flatMap((suite) =>
        SCENARIOS.map((scenario) => [`agh.blob/${BLOB_PROVIDER.id}${suite}/${scenario}`, 'passed']),
      ),
    )
    expect(report.status).toBe('passed')
    expect(report.failures).toEqual([])
  })

  it('fails a scenario whose observations break the contract', async () => {
    const report = await runContract(
      (port) => ({
        ...port,
        recover: async (context) => ({ ...(await port.recover(context)), after: { refused: 'not_found' } }),
      }),
      (port) => ({
        ...port,
        deny: async (context) => ({ ...(await port.deny(context)), tampered: { refused: 'internal_error' } }),
      }),
    )
    expect(report.assertions.filter((item) => item.status === 'failed').map((item) => item.id)).toEqual([
      `agh.blob/${BLOB_PROVIDER.id}/recover`,
      `agh.blob/${BLOB_PROVIDER.id}/authority-transfer/deny`,
    ])
    expect(report.status).toBe('failed')
  })

  it('fails deny when a selection asking a feature the binding does not declare is accepted', async () => {
    const report = await runContract((port) => ({
      ...port,
      deny: async (context) => {
        const seen = await port.deny(context)
        return { ...seen, selection: seen.selection.map((code, index) => (index === 1 ? 'selected' : code)) }
      },
    }))
    expect(report.assertions.filter((item) => item.status === 'failed').map((item) => item.scenario)).toEqual(
      ['deny'],
    )
    expect(report.status).toBe('failed')
  })
})
