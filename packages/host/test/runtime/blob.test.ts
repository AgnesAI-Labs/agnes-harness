import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AuthorityTransferControl,
  BlobReadPort,
  CallContext,
  Outcome,
  ScopeRef,
} from '@agnes/extension-api/runtime'
import {
  type BuildIdentity,
  type ConformanceHarness,
  createConformanceHarness,
  SCENARIOS,
} from '@agnes/extension-api/testkit'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  type JsonValue,
  RuntimeArtifactPolicy,
  RuntimeClientTransportPolicy,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import type { TransferMaintenance } from '../../src/runtime/authority-transfer.js'
import { inlineData } from '../../src/runtime/maintenance/authority-publication.js'
import { indexDigest } from '../../src/runtime/migration/export-index.js'
import {
  BLOB_FEATURES,
  type BlobService,
  type BlobServiceOptions,
  blobProviderDescriptor,
  createBlobService,
  runtimeServiceDataDir,
} from '../../src/runtime/providers/blob.js'

const START = Date.parse('2026-10-01T00:00:00.000Z')
const MIB = RuntimeClientTransportPolicy.maxRangeBytes
const BINDING = {
  bindingId: 'blob-1',
  contract: 'agh.blob',
  logicalName: 'default',
  providerId: 'agh.blob.default',
}
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const text = (value: string) => new TextEncoder().encode(value)

function scope(sessionId = 'session-1'): ScopeRef {
  return {
    kind: 'session',
    installationId: 'install-1',
    runtimeId: 'runtime-1',
    workspaceId: 'workspace-1',
    sessionId,
  }
}

function ctx(
  over: Partial<Pick<CallContext, 'principalRef' | 'scope' | 'authorizationRef'>> = {},
): CallContext {
  return {
    principalRef: 'user-1',
    scope: scope(),
    bindingId: 'binding-1',
    invocationId: 'invocation-1',
    deadline: '2026-10-02T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'auth-ok',
    signal: new AbortController().signal,
    ...over,
  }
}

function ok<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`${outcome.error.detailCode}: ${outcome.error.message}`)
  return outcome.value
}

function refused(outcome: Outcome<unknown>): string {
  if (outcome.ok) throw new Error('expected a refusal')
  return outcome.error.detailCode
}

const dirs: string[] = []
const services: BlobService[] = []
let clock = START

afterEach(async () => {
  for (const service of services.splice(0)) service.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  clock = START
})

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agh-blob-'))
  dirs.push(dir)
  return dir
}

function open(
  dataDir: string,
  authorizeRead?: (context: CallContext) => boolean,
  maintenance?: TransferMaintenance,
  transferTarget = false,
): BlobService {
  const options: BlobServiceOptions = {
    dataDir,
    authorityId: 'blob-authority',
    binding: BINDING,
    now: () => clock,
    ...(authorizeRead ? { authorizeRead } : {}),
    ...(maintenance ? { maintenance } : {}),
    ...(transferTarget ? { transferTarget } : {}),
  }
  const service = createBlobService(options)
  services.push(service)
  return service
}

function reopen(blob: BlobService, dataDir: string, maintenance?: TransferMaintenance): BlobService {
  blob.close()
  services.splice(services.indexOf(blob), 1)
  return open(dataDir, trusted, maintenance)
}

/** Runs one statement against the persisted store, as a restarted process would find it. */
function sql(dataDir: string, statement: string): Record<string, unknown>[] {
  const db = new DatabaseSync(join(dataDir, 'artifacts', 'blob-service.db'))
  try {
    return db.prepare(statement).all()
  } finally {
    db.close()
  }
}

const contentFile = (dataDir: string, digest: string) =>
  join(dataDir, 'artifacts', 'sha256', digest.slice(0, 2), digest)

const deletionLog = (dataDir: string) =>
  sql(dataDir, 'SELECT kind, ref, digest FROM deletions ORDER BY seq').map(({ kind, ref, digest }) => [
    kind,
    ref,
    digest,
  ])

const trusted = (context: CallContext) => context.authorizationRef === 'auth-ok'

async function sealed(blob: BlobService, uploadId: string, bytes: Uint8Array, context = ctx()) {
  ok(
    await blob.stage(
      { uploadId, size: bytes.byteLength, mediaType: 'text/plain', expectedDigest: null },
      context,
    ),
  )
  const writer = ok(blob.openWriter(uploadId, context))
  for (let at = 0; at < bytes.byteLength; at += MIB) ok(writer.write(at, bytes.subarray(at, at + MIB)))
  const result = ok(await writer.seal())
  writer.close()
  return result
}

async function pinned(blob: BlobService, bytes: Uint8Array, uploadId = 'upload-p') {
  const { upload } = await sealed(blob, uploadId, bytes)
  const staged = ok(await blob.promote({ upload, expectedDigest: upload.digest }, ctx()))
  const owner: Wire.PublicRef = { kind: 'artifact', value: { artifactId: 'artifact-1', version: 1 } }
  return ok(await blob.pin({ stagedBlob: staged, ownerRef: owner, retentionUntil: null }, ctx()))
}

async function drain(stream: { chunks: AsyncIterable<Uint8Array> }): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream.chunks) chunks.push(chunk)
  return chunks
}

const inspectUpload = (blob: BlobService, value: Wire.UploadSession) =>
  blob.inspect({ ref: { kind: 'upload', value } }, ctx())

describe('default blob service uploads', () => {
  it('stage returns the same session for the same upload, owner, size and digest', async () => {
    const blob = open(await fresh())
    const request = { uploadId: 'upload-1', size: 3, mediaType: 'text/plain', expectedDigest: sha('abc') }
    const first = ok(await blob.stage(request, ctx()))
    expect(first).toMatchObject({ status: 'uploading', receivedBytes: 0, expectedBytes: 3 })
    expect(ok(await blob.stage(request, ctx()))).toEqual(first)
    expect(refused(await blob.stage({ ...request, size: 4 }, ctx()))).toBe('idempotency_conflict')
    expect(refused(await blob.stage({ ...request, expectedDigest: null }, ctx()))).toBe(
      'idempotency_conflict',
    )
    expect(refused(await blob.stage(request, ctx({ principalRef: 'user-2' })))).toBe('idempotency_conflict')
    const tooLarge = {
      ...request,
      uploadId: 'upload-2',
      size: RuntimeClientTransportPolicy.maxArtifactBytes + 1,
    }
    expect(refused(await blob.stage(tooLarge, ctx()))).toBe('artifact_bytes')
  })

  it('advances received bytes only for stored chunks and never overwrites the acknowledged prefix', async () => {
    const dataDir = await fresh()
    let blob = open(dataDir)
    const session = ok(
      await blob.stage(
        { uploadId: 'upload-1', size: 6, mediaType: 'text/plain', expectedDigest: null },
        ctx(),
      ),
    )
    const writer = ok(blob.openWriter('upload-1', ctx()))
    expect(ok(writer.write(0, text('abc')))).toMatchObject({ receivedBytes: 3, revision: 2 })
    expect(ok(writer.write(0, text('abc')))).toMatchObject({ receivedBytes: 3, revision: 2 })
    expect(refused(writer.write(1, text('bX')))).toBe('idempotency_conflict')
    expect(refused(writer.write(4, text('ef')))).toBe('invalid_request')
    expect(refused(writer.write(3, text('defg')))).toBe('invalid_request')
    expect(refused(blob.openWriter('upload-1', ctx()))).toBe('revision_conflict')
    blob.close()
    services.splice(services.indexOf(blob), 1)

    blob = open(dataDir)
    expect(ok(await inspectUpload(blob, session))).toEqual({
      status: 'uploading',
      bytes: 3,
      digest: null,
      ownerRefs: [],
    })
    expect(refused(blob.openWriter('upload-1', ctx({ principalRef: 'user-2' })))).toBe('permission_denied')
    const resumed = ok(blob.openWriter('upload-1', ctx()))
    expect(refused(resumed.write(0, text('abd')))).toBe('idempotency_conflict')
    ok(resumed.write(3, text('def')))
    const result = ok(await resumed.seal())
    expect(result.upload).toMatchObject({ status: 'sealed', bytes: 6, digest: sha('abcdef') })
    expect(result.retention).toMatchObject({ kind: 'domain-record', resourceId: 'upload-1' })
    expect(ok(await inspectUpload(blob, session))).toMatchObject({ status: 'sealed', digest: sha('abcdef') })
  })

  it('seal checks the total size and the full digest, and repeats its first result', async () => {
    const blob = open(await fresh())
    const session = ok(
      await blob.stage(
        { uploadId: 'upload-1', size: 3, mediaType: 'text/plain', expectedDigest: sha('abc') },
        ctx(),
      ),
    )
    const writer = ok(blob.openWriter('upload-1', ctx()))
    ok(writer.write(0, text('ab')))
    expect(refused(await writer.seal())).toBe('invalid_request')
    ok(writer.write(2, text('x')))
    expect(refused(await writer.seal())).toBe('integrity')
    expect(ok(await inspectUpload(blob, session))).toMatchObject({ status: 'uploading', digest: null })

    ok(
      await blob.stage(
        { uploadId: 'upload-2', size: 3, mediaType: 'text/plain', expectedDigest: null },
        ctx(),
      ),
    )
    const second = ok(blob.openWriter('upload-2', ctx()))
    ok(second.write(0, text('abc')))
    const first = ok(await second.seal())
    expect(first.upload.digest).toBe(sha('abc'))
    expect(ok(await second.seal())).toEqual(first)
    expect(refused(second.write(0, text('abc')))).toBe('revision_conflict')
    expect(refused(blob.openWriter('upload-2', ctx()))).toBe('revision_conflict')
  })
})

describe('default blob service retention', () => {
  it('pins per owner, keeps content pinned while any pin lives and returns it to staged at the last unpin', async () => {
    const blob = open(await fresh(), trusted)
    const { upload } = await sealed(blob, 'upload-1', text('hello'))
    expect(refused(await blob.promote({ upload, expectedDigest: sha('other') }, ctx()))).toBe('integrity')
    const staged = ok(await blob.promote({ upload, expectedDigest: upload.digest }, ctx()))
    expect(ok(await blob.promote({ upload, expectedDigest: upload.digest }, ctx()))).toEqual(staged)
    const stagedRef = { ref: { kind: 'staged-blob' as const, value: staged } }
    expect(ok(await blob.inspect(stagedRef, ctx())).status).toBe('staged')

    const ownerA: Wire.PublicRef = { kind: 'artifact', value: { artifactId: 'artifact-a', version: 1 } }
    const ownerB: Wire.PublicRef = { kind: 'artifact', value: { artifactId: 'artifact-b', version: 1 } }
    const pinA = ok(await blob.pin({ stagedBlob: staged, ownerRef: ownerA, retentionUntil: null }, ctx()))
    expect(ok(await blob.pin({ stagedBlob: staged, ownerRef: ownerA, retentionUntil: null }, ctx()))).toEqual(
      pinA,
    )
    const pinB = ok(await blob.pin({ stagedBlob: staged, ownerRef: ownerB, retentionUntil: null }, ctx()))
    expect(pinB.pinId).not.toBe(pinA.pinId)
    expect(ok(await blob.inspect(stagedRef, ctx()))).toMatchObject({ status: 'pinned', digest: sha('hello') })
    expect(ok(await blob.inspect(stagedRef, ctx())).ownerRefs).toHaveLength(2)

    expect(refused(await blob.unpin({ pinId: pinA.pinId, expectedRevision: 2 }, ctx()))).toBe(
      'revision_conflict',
    )
    expect(ok(await blob.unpin({ pinId: pinA.pinId, expectedRevision: 1 }, ctx()))).toEqual({
      released: true,
    })
    expect(ok(await blob.unpin({ pinId: pinA.pinId, expectedRevision: 1 }, ctx()))).toEqual({
      released: false,
    })
    expect(ok(await blob.inspect({ ref: { kind: 'blob', value: pinA } }, ctx())).status).toBe('staged')
    expect(refused(await blob.blobRead.readRange({ ref: pinA, offset: 0, length: 5 }, ctx()))).toBe('revoked')
    expect(ok(await blob.blobRead.readRange({ ref: pinB, offset: 0, length: 5 }, ctx())).bytes).toEqual(
      text('hello'),
    )
    expect(ok(await blob.inspect(stagedRef, ctx())).status).toBe('pinned')

    ok(await blob.unpin({ pinId: pinB.pinId, expectedRevision: 1 }, ctx()))
    expect(ok(await blob.inspect(stagedRef, ctx()))).toMatchObject({ status: 'staged', ownerRefs: [] })
  })

  it('keeps its content under the runtime service directory, apart from the legacy artifact store', async () => {
    const root = await fresh()
    const blob = open(runtimeServiceDataDir(root, 'blob'))
    const { upload } = await sealed(blob, 'upload-1', text('hello'))
    ok(await blob.promote({ upload, expectedDigest: upload.digest }, ctx()))
    expect(existsSync(join(root, 'artifacts'))).toBe(false)
    const content = join(root, 'runtime-services', 'blob', 'artifacts', 'sha256', upload.digest.slice(0, 2))
    expect(existsSync(join(content, upload.digest))).toBe(true)
  })

  it('aborts an expired upload only after its writer stopped, inside the requested scope, then deletes it', async () => {
    const dataDir = await fresh()
    const blob = open(dataDir)
    const session = ok(
      await blob.stage(
        { uploadId: 'upload-1', size: 4, mediaType: 'text/plain', expectedDigest: null },
        ctx(),
      ),
    )
    const writer = ok(blob.openWriter('upload-1', ctx()))
    ok(writer.write(0, text('a')))
    const gc = (over: Partial<Wire.BlobGcRequest> = {}, context = ctx()) =>
      blob.gc({ scopeRef: scope(), dryRun: false, cursor: null, limit: 100, ...over }, context)

    expect(ok(await gc()).eligibleRefs).toEqual([])
    clock = START + RuntimeArtifactPolicy.uploadReservationTtlMs
    expect(ok(await gc({ dryRun: true })).eligibleRefs).toEqual([])
    writer.close()
    const dry = ok(await gc({ dryRun: true }))
    expect(dry.eligibleRefs).toHaveLength(1)
    expect(dry.deletedRefs).toEqual([])
    expect(ok(await inspectUpload(blob, session)).status).toBe('uploading')
    expect(
      ok(await gc({ scopeRef: scope('session-2') }, ctx({ scope: scope('session-2') }))).eligibleRefs,
    ).toEqual([])
    const runtimeScope: ScopeRef = { kind: 'runtime', installationId: 'install-1', runtimeId: 'runtime-1' }
    expect(refused(await gc({ scopeRef: runtimeScope }))).toBe('permission_denied')

    const aborted = ok(await gc())
    expect(aborted.eligibleRefs).toMatchObject([
      { kind: 'upload', value: { status: 'aborted', receivedBytes: 1 } },
    ])
    expect(aborted.deletedRefs).toEqual([])
    expect(ok(await inspectUpload(blob, session))).toEqual({
      status: 'aborted',
      bytes: 1,
      digest: null,
      ownerRefs: [],
    })
    expect(refused(blob.openWriter('upload-1', ctx()))).toBe('revision_conflict')

    const deleted = ok(await gc())
    expect(deleted.deletedRefs).toMatchObject([{ kind: 'upload', value: { uploadId: 'upload-1' } }])
    expect(ok(await inspectUpload(blob, session)).status).toBe('deleted')
    expect(deletionLog(dataDir)).toEqual([
      ['upload-aborted', 'upload-1', null],
      ['upload-deleted', 'upload-1', null],
    ])
  })

  it('pages gc results by cursor and limit', async () => {
    const blob = open(await fresh())
    for (const id of ['upload-a', 'upload-b', 'upload-c'])
      ok(await blob.stage({ uploadId: id, size: 1, mediaType: 'text/plain', expectedDigest: null }, ctx()))
    clock = START + RuntimeArtifactPolicy.uploadReservationTtlMs
    const page = (cursor: string | null) =>
      blob.gc({ scopeRef: scope(), dryRun: true, cursor, limit: 2 }, ctx())
    const first = ok(await page(null))
    expect(first.eligibleRefs).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = ok(await page(first.nextCursor))
    expect(second.eligibleRefs).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    const ids = [...first.eligibleRefs, ...second.eligibleRefs].map((ref) =>
      ref.kind === 'upload' ? ref.value.uploadId : '',
    )
    expect(ids).toEqual(['upload-a', 'upload-b', 'upload-c'])
    expect(refused(await blob.gc({ scopeRef: scope(), dryRun: true, cursor: null, limit: 0 }, ctx()))).toBe(
      'invalid_request',
    )
  })

  it('keeps a staged blob while a pin or its sealed-upload root holds it', async () => {
    const blob = open(await fresh())
    const kept = await sealed(blob, 'upload-1', text('kept'))
    const staged = ok(await blob.promote({ upload: kept.upload, expectedDigest: kept.upload.digest }, ctx()))
    const other = await sealed(blob, 'upload-2', text('other'))
    const otherStaged = ok(
      await blob.promote({ upload: other.upload, expectedDigest: other.upload.digest }, ctx()),
    )
    const owner: Wire.PublicRef = { kind: 'artifact', value: { artifactId: 'artifact-2', version: 1 } }
    ok(await blob.pin({ stagedBlob: otherStaged, ownerRef: owner, retentionUntil: null }, ctx()))
    ok(await blob.unpin({ pinId: other.retention.pinId, expectedRevision: 1 }, ctx()))
    clock = START + RuntimeArtifactPolicy.uploadReservationTtlMs
    const gc = () => blob.gc({ scopeRef: scope(), dryRun: false, cursor: null, limit: 100 }, ctx())

    expect(ok(await gc()).eligibleRefs).toEqual([])
    ok(await blob.unpin({ pinId: kept.retention.pinId, expectedRevision: 1 }, ctx()))
    expect(ok(await gc()).deletedRefs).toEqual([{ kind: 'staged-blob', value: staged }])
    expect(ok(await blob.inspect({ ref: { kind: 'staged-blob', value: staged } }, ctx()))).toMatchObject({
      status: 'deleted',
      digest: sha('kept'),
    })
    expect(
      refused(await blob.pin({ stagedBlob: staged, ownerRef: owner, retentionUntil: null }, ctx())),
    ).toBe('artifact_deleted')
    expect(ok(await blob.inspect({ ref: { kind: 'staged-blob', value: otherStaged } }, ctx())).status).toBe(
      'pinned',
    )
  })

  it('logs each collect and released pin, and unlinks content after the commit once nothing can use it', async () => {
    const dataDir = await fresh()
    let blob = open(dataDir)
    const first = await sealed(blob, 'upload-1', text('same'))
    const digest = first.upload.digest
    const file = contentFile(dataDir, digest)
    const staged = ok(await blob.promote({ upload: first.upload, expectedDigest: digest }, ctx()))
    const twin = await sealed(blob, 'upload-2', text('same'))
    const gc = () => blob.gc({ scopeRef: scope(), dryRun: false, cursor: null, limit: 100 }, ctx())

    ok(await blob.unpin({ pinId: first.retention.pinId, expectedRevision: 1 }, ctx()))
    expect(ok(await gc()).deletedRefs).toEqual([{ kind: 'staged-blob', value: staged }])
    // The twin upload can still be promoted, so the shared content stays.
    expect(existsSync(file)).toBe(true)
    const second = ok(await blob.promote({ upload: twin.upload, expectedDigest: digest }, ctx()))
    ok(await blob.unpin({ pinId: twin.retention.pinId, expectedRevision: 1 }, ctx()))
    ok(await gc())
    expect(existsSync(file)).toBe(false)
    const collected = [
      ['pin-released', first.retention.pinId, null],
      ['blob-deleted', staged.blobId, digest],
      ['pin-released', twin.retention.pinId, null],
      ['blob-deleted', second.blobId, digest],
      ['content-unlink-pending', digest, digest],
    ]
    expect(deletionLog(dataDir)).toEqual([...collected, ['content-unlinked', digest, digest]])

    // A crash after the collect committed and before the unlink: the next gc unlinks the file.
    blob.close()
    sql(dataDir, "DELETE FROM deletions WHERE kind = 'content-unlinked'")
    writeFileSync(file, text('same'))
    blob = reopen(blob, dataDir)
    ok(await gc())
    expect(existsSync(file)).toBe(false)
    expect(deletionLog(dataDir)).toEqual([...collected, ['content-unlinked', digest, digest]])
    // A crash after the unlink and before its record: the missing file counts as unlinked.
    sql(dataDir, "DELETE FROM deletions WHERE kind = 'content-unlinked'")
    ok(await gc())
    expect(deletionLog(dataDir)).toEqual([...collected, ['content-unlinked', digest, digest]])
    // Content sealed again before the interrupted unlink completes is retained.
    sql(dataDir, "DELETE FROM deletions WHERE kind = 'content-unlinked'")
    await sealed(blob, 'upload-3', text('same'))
    ok(await gc())
    expect(existsSync(file)).toBe(true)
    expect(deletionLog(dataDir)).toEqual([...collected, ['content-retained', digest, digest]])
  })

  it('keeps marked content when the collect that marked it rolls back', async () => {
    const dataDir = await fresh()
    const blob = open(dataDir)
    const staged: Wire.StagedBlobRef[] = []
    for (const [uploadId, bytes] of [
      ['upload-1', 'one'],
      ['upload-2', 'two'],
    ] as const) {
      const { upload, retention } = await sealed(blob, uploadId, text(bytes))
      staged.push(ok(await blob.promote({ upload, expectedDigest: upload.digest }, ctx())))
      ok(await blob.unpin({ pinId: retention.pinId, expectedRevision: 1 }, ctx()))
    }
    const [first, last] = staged.sort((a, b) => (a.blobId < b.blobId ? -1 : 1))
    if (!first || !last) throw new Error('expected two staged blobs')
    // gc collects in blob id order, so the later collect fails after the earlier content was marked.
    sql(
      dataDir,
      `CREATE TRIGGER fail_collect AFTER INSERT ON deletions WHEN NEW.ref = '${last.blobId}'
       BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    )
    expect(
      refused(await blob.gc({ scopeRef: scope(), dryRun: false, cursor: null, limit: 100 }, ctx())),
    ).toBe('internal_error')
    expect(existsSync(contentFile(dataDir, first.digest))).toBe(true)
    expect(ok(await blob.inspect({ ref: { kind: 'staged-blob', value: first } }, ctx())).status).toBe(
      'staged',
    )
    expect(deletionLog(dataDir).map(([kind]) => kind)).toEqual(['pin-released', 'pin-released'])
  })
})

describe('default blob service reads', () => {
  it('reads a range of 1 to 1 MiB, refuses a start at or past the end and clamps one crossing it', async () => {
    const dataDir = await fresh()
    const blob = open(dataDir, trusted)
    const ref = await pinned(blob, text('0123456789'))
    const read = (offset: number, length: number, context = ctx()) =>
      blob.blobRead.readRange({ ref, offset, length }, context)
    expect(refused(await read(0, 0))).toBe('invalid_request')
    expect(refused(await read(0, MIB + 1))).toBe('invalid_request')
    expect(refused(await read(10, 1))).toBe('range_not_satisfiable')
    expect(ok(await read(8, 5))).toEqual({ bytes: text('89'), offset: 8, totalBytes: 10, digest: sha('89') })
    expect(refused(await read(0, 1, ctx({ authorizationRef: 'auth-other' })))).toBe('permission_denied')
    expect(
      refused(await blob.blobRead.readRange({ ref: { ...ref, bytes: 11 }, offset: 0, length: 1 }, ctx())),
    ).toBe('not_found')
    expect(refused(await open(dataDir).blobRead.readRange({ ref, offset: 0, length: 1 }, ctx()))).toBe(
      'blocked',
    )
  })

  it('streams to the end, ends empty at the end, refuses past it, cancels idempotently and stops at close', async () => {
    const blob = open(await fresh(), trusted)
    const bytes = new Uint8Array(MIB + MIB / 2).map((_, index) => index % 251)
    const ref = await pinned(blob, bytes)
    const full = ok(await blob.blobRead.openRead({ ref, offset: 0 }, ctx()))
    const chunks = await drain(full)
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([MIB, MIB / 2])
    expect(await full.ended).toEqual({ ok: true, value: { bytes: bytes.byteLength, digest: ref.digest } })

    const empty = ok(await blob.blobRead.openRead({ ref, offset: bytes.byteLength }, ctx()))
    expect(await drain(empty)).toEqual([])
    expect(await empty.ended).toEqual({ ok: true, value: { bytes: 0, digest: sha('') } })
    expect(refused(await blob.blobRead.openRead({ ref, offset: bytes.byteLength + 1 }, ctx()))).toBe(
      'range_not_satisfiable',
    )

    const partial = ok(await blob.blobRead.openRead({ ref, offset: 0 }, ctx()))
    const iterator = partial.chunks[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.byteLength).toBe(MIB)
    await partial.cancel('stop')
    await partial.cancel('stop')
    await partial.close()
    expect((await iterator.next()).done).toBe(true)
    expect(refused(await partial.ended)).toBe('cancelled')

    // Close is idempotent; afterwards an open stream and every call are refused with one stable code.
    const reading = ok(await blob.blobRead.openRead({ ref, offset: 0 }, ctx()))
    const pending = reading.chunks[Symbol.asyncIterator]()
    expect((await pending.next()).value?.byteLength).toBe(MIB)
    blob.close()
    blob.close()
    expect((await pending.next()).done).toBe(true)
    expect(refused(await reading.ended)).toBe('blocked')
    expect(refused(await blob.blobRead.readRange({ ref, offset: 0, length: 1 }, ctx()))).toBe('blocked')
    expect(refused(await blob.blobRead.openRead({ ref, offset: 0 }, ctx()))).toBe('blocked')
    expect(refused(await blob.inspect({ ref: { kind: 'blob', value: ref } }, ctx()))).toBe('blocked')
    expect(refused(blob.openWriter('upload-p', ctx()))).toBe('blocked')
  })

  it('reports changed content bytes as an integrity failure', async () => {
    const dataDir = await fresh()
    const blob = open(dataDir, trusted)
    const ref = await pinned(blob, text('abcdef'))
    writeFileSync(join(dataDir, 'artifacts', 'sha256', ref.digest.slice(0, 2), ref.digest), text('abcdeX'))
    expect(refused(await blob.blobRead.readRange({ ref, offset: 0, length: 2 }, ctx()))).toBe('integrity')
    expect(refused(await blob.blobRead.openRead({ ref, offset: 0 }, ctx()))).toBe('integrity')
  })
})

const MAINTAINER = ctx({ authorizationRef: 'maintenance' })
const EXPECTED = { authorityId: 'blob-authority', tenantId: 'tenant-1', authorityEpoch: 1 }
const FENCE = { upgradeId: 'upgrade-1', expected: EXPECTED, cohortDigest: 'c'.repeat(64) }

const PLAN = 'f'.repeat(64)

const unavailable = (detailCode: string, message: string) => ({
  ok: false as const,
  error: {
    code: 'invalid_input' as const,
    detailCode,
    message,
    retryAdvice: { kind: 'never' as const },
    diagnosticId: 'test',
  },
})

/**
 * The maintenance directory as the store sees it: one published route and an activation flag. A
 * store at another location overrides its location and the source it imports from.
 */
function maintenance(
  directory: { route?: Wire.AuthorityRoute; targetActivated?: boolean },
  over: Partial<TransferMaintenance> = {},
): TransferMaintenance {
  return {
    authorize: (context) => context.authorizationRef === 'maintenance',
    tenantId: 'tenant-1',
    locationRef: 'location-1',
    readRoute: async ({ logicalAuthorityId }) =>
      directory.route?.logicalAuthorityId === logicalAuthorityId
        ? { ok: true, value: { route: directory.route, targetActivated: directory.targetActivated ?? false } }
        : unavailable('not_found', 'no published route'),
    sourceBlobs: { openRead: async () => unavailable('not_found', 'no source lends its bytes') },
    planFingerprint: async () => ({ ok: true, value: PLAN }),
    ...over,
  }
}

function recoveryRoute(authorityEpoch: number, over: Partial<Wire.AuthorityRoute> = {}): Wire.AuthorityRoute {
  return {
    logicalAuthorityId: 'blob-authority',
    tenantId: 'tenant-1',
    authorityEpoch,
    providerBinding: BINDING,
    locationRef: 'location-1',
    cohortDigest: 'c'.repeat(64),
    cutoverId: 'recovery-1',
    checkpoint: {
      authorityId: 'blob-authority',
      authorityEpoch,
      checkpointId: 'checkpoint-1',
      snapshotDigest: 'd'.repeat(64),
      recordCount: 0,
      bridgeWatermarks: [],
    },
    previous: { authorityEpoch: 1, locationRef: 'location-1', cutoverId: 'cutover-0' },
    ...over,
  }
}

describe('default blob service authority transfer', () => {
  it('fences once per upgrade: business writes and an open upload stop as blocked while reads go on', async () => {
    const dataDir = await fresh()
    const blob = open(dataDir, trusted, maintenance({}))
    const { upload } = await sealed(blob, 'upload-1', text('kept'))
    const stagedBlob = ok(await blob.promote({ upload, expectedDigest: upload.digest }, ctx()))
    const owner = (artifactId: string): Wire.PublicRef => ({
      kind: 'artifact',
      value: { artifactId, version: 1 },
    })
    const ref = ok(await blob.pin({ stagedBlob, ownerRef: owner('artifact-1'), retentionUntil: null }, ctx()))
    ok(
      await blob.stage(
        { uploadId: 'upload-2', size: 6, mediaType: 'text/plain', expectedDigest: null },
        ctx(),
      ),
    )
    const writer = ok(blob.openWriter('upload-2', ctx()))
    ok(writer.write(0, text('abc')))

    expect(refused(await open(dataDir).transfer.fence(FENCE, MAINTAINER))).toBe('operation_not_supported')
    expect(() => createBlobService({ dataDir, authorityId: 'other-authority', binding: BINDING })).toThrow()
    expect(refused(await blob.transfer.fence(FENCE, ctx()))).toBe('permission_denied')
    for (const expected of [
      { ...EXPECTED, authorityEpoch: 2 },
      { ...EXPECTED, tenantId: 'tenant-2' },
      { ...EXPECTED, authorityId: 'other-authority' },
    ])
      expect(refused(await blob.transfer.fence({ ...FENCE, expected }, MAINTAINER))).toBe('revision_conflict')
    const fence = ok(await blob.transfer.fence(FENCE, MAINTAINER))
    expect(fence).toMatchObject({
      upgradeId: 'upgrade-1',
      source: EXPECTED,
      fenceEpoch: 1,
      writerCredentialsRevoked: true,
      checkpoint: { authorityId: 'blob-authority', authorityEpoch: 1, bridgeWatermarks: [] },
    })
    expect(ok(await blob.transfer.fence(FENCE, MAINTAINER))).toEqual(fence)
    expect(refused(await blob.transfer.fence({ ...FENCE, cohortDigest: 'e'.repeat(64) }, MAINTAINER))).toBe(
      'idempotency_conflict',
    )
    expect(refused(await blob.transfer.fence({ ...FENCE, upgradeId: 'upgrade-2' }, MAINTAINER))).toBe(
      'revision_conflict',
    )

    expect(refused(writer.write(3, text('def')))).toBe('blocked')
    expect(
      refused(
        await blob.stage(
          { uploadId: 'upload-3', size: 1, mediaType: 'text/plain', expectedDigest: null },
          ctx(),
        ),
      ),
    ).toBe('blocked')
    expect(
      refused(await blob.pin({ stagedBlob, ownerRef: owner('artifact-2'), retentionUntil: null }, ctx())),
    ).toBe('blocked')
    expect(refused(await blob.promote({ upload, expectedDigest: upload.digest }, ctx()))).toBe('blocked')
    expect(refused(await blob.unpin({ pinId: ref.pinId, expectedRevision: 1 }, ctx()))).toBe('blocked')
    expect(
      refused(await blob.gc({ scopeRef: scope(), dryRun: false, cursor: null, limit: 100 }, ctx())),
    ).toBe('blocked')
    expect(ok(await blob.blobRead.readRange({ ref, offset: 0, length: 4 }, ctx())).bytes).toEqual(
      text('kept'),
    )
    expect(ok(await blob.inspect({ ref: { kind: 'blob', value: ref } }, ctx())).status).toBe('pinned')
  })

  it('records the deletion watermark with the fence, keeps both across reopen and aborts only onto the published recovery route', async () => {
    const dataDir = await fresh()
    const directory: { route?: Wire.AuthorityRoute; targetActivated?: boolean } = {}
    let blob = open(dataDir, trusted, maintenance(directory))
    const { upload, retention } = await sealed(blob, 'upload-1', text('kept'))
    const stagedBlob = ok(await blob.promote({ upload, expectedDigest: upload.digest }, ctx()))
    const ownerRef: Wire.PublicRef = { kind: 'artifact', value: { artifactId: 'artifact-1', version: 1 } }
    const ref = ok(await blob.pin({ stagedBlob, ownerRef, retentionUntil: null }, ctx()))
    ok(await blob.unpin({ pinId: retention.pinId, expectedRevision: 1 }, ctx()))
    const probe = () => blob.transfer.probe({ upgradeId: 'upgrade-1' }, MAINTAINER)
    expect(ok(await probe())).toEqual({ state: 'absent' })
    const fence = ok(await blob.transfer.fence(FENCE, MAINTAINER))
    expect(
      sql(dataDir, 'SELECT watermark, (SELECT MAX(seq) FROM deletions) AS head FROM maintenance_transfers'),
    ).toEqual([{ watermark: 1, head: 1 }])

    blob = reopen(blob, dataDir, maintenance(directory))
    expect(ok(await probe())).toEqual({ state: 'fenced', fence })
    expect(refused(await blob.unpin({ pinId: ref.pinId, expectedRevision: 1 }, ctx()))).toBe('blocked')

    const abort = (route: Wire.AuthorityRoute, expectedFenceId = fence.fenceId, context = MAINTAINER) =>
      blob.transfer.abort(
        {
          upgradeId: 'upgrade-1',
          expectedFenceId,
          recoveryRoute: inlineData(route as unknown as JsonValue, 'agh.test/authority-route@1'),
        },
        context,
      )
    const recovery = recoveryRoute(2)
    expect(refused(await abort(recovery, fence.fenceId, ctx()))).toBe('permission_denied')
    expect(refused(await abort(recovery))).toBe('not_found')
    directory.route = recoveryRoute(2, { cutoverId: 'recovery-2' })
    expect(refused(await abort(recovery))).toBe('revision_conflict')
    directory.route = recovery
    expect(refused(await abort(recovery, 'another-fence'))).toBe('revision_conflict')
    expect(refused(await abort(recoveryRoute(1)))).toBe('revision_conflict')
    expect(refused(await abort(recoveryRoute(3)))).toBe('revision_conflict')
    expect(refused(await abort(recoveryRoute(2, { locationRef: 'location-2' })))).toBe('revision_conflict')
    directory.targetActivated = true
    expect(refused(await abort(recovery))).toBe('revision_conflict')
    expect(refused(await blob.unpin({ pinId: ref.pinId, expectedRevision: 1 }, ctx()))).toBe('blocked')

    directory.targetActivated = false
    const aborted = ok(await abort(recovery))
    expect(aborted).toEqual({ state: 'aborted', source: EXPECTED, restoredEpoch: 2 })
    expect(ok(await abort(recovery))).toEqual(aborted)
    expect(refused(await abort(recoveryRoute(2, { cutoverId: 'recovery-2' })))).toBe('idempotency_conflict')
    blob = reopen(blob, dataDir, maintenance(directory))
    expect(ok(await probe())).toEqual(aborted)
    expect(ok(await blob.unpin({ pinId: ref.pinId, expectedRevision: 1 }, ctx()))).toEqual({ released: true })
    // The fenced epoch never serves again; a later fence names the restored one.
    expect(refused(await blob.transfer.fence({ ...FENCE, upgradeId: 'upgrade-2' }, MAINTAINER))).toBe(
      'revision_conflict',
    )
    const next = ok(
      await blob.transfer.fence(
        { ...FENCE, upgradeId: 'upgrade-2', expected: { ...EXPECTED, authorityEpoch: 2 } },
        MAINTAINER,
      ),
    )
    expect(next).toMatchObject({ fenceEpoch: 2, checkpoint: { authorityEpoch: 2 } })
  })
})

const UPGRADE = 'upgrade-1'

/** A source fenced and exported while it holds every kind of row and content its store keeps. */
async function exportedSource() {
  const sourceDir = await fresh()
  const directory: { route?: Wire.AuthorityRoute } = {}
  const source = open(sourceDir, trusted, maintenance(directory))
  const kept = await pinned(source, text('kept bytes'), 'upload-kept')
  const loose = await sealed(source, 'upload-loose', text('staged, never pinned'))
  ok(await source.promote({ upload: loose.upload, expectedDigest: loose.upload.digest }, ctx()))
  await sealed(source, 'upload-sealed', text('sealed, never promoted'))
  const gone = await sealed(source, 'upload-gone', text('collected'))
  ok(await source.promote({ upload: gone.upload, expectedDigest: gone.upload.digest }, ctx()))
  ok(await source.unpin({ pinId: gone.retention.pinId, expectedRevision: 1 }, ctx()))
  ok(await source.gc({ scopeRef: scope(), dryRun: false, cursor: null, limit: 100 }, ctx()))
  expect(existsSync(contentFile(sourceDir, gone.upload.digest))).toBe(false)
  // An upload still receiving bytes: five of its six chunks are stored rows.
  const partial = Uint8Array.from({ length: 6 * MIB }, (_, at) => at % 251)
  ok(
    await source.stage(
      { uploadId: 'upload-open', size: partial.byteLength, mediaType: 'text/plain', expectedDigest: null },
      ctx(),
    ),
  )
  const writer = ok(source.openWriter('upload-open', ctx()))
  for (let at = 0; at < 5 * MIB; at += MIB) ok(writer.write(at, partial.subarray(at, at + MIB)))
  writer.close()
  const fence = ok(await source.transfer.fence(FENCE, MAINTAINER))
  const exported = ok(
    await source.transfer.export({ upgradeId: UPGRADE, fenceId: fence.fenceId }, MAINTAINER),
  )
  return { source, sourceDir, directory, kept, partial, collected: gone.upload.digest, fence, exported }
}

type ExportedSource = Awaited<ReturnType<typeof exportedSource>>

/** Every manifest part, read page by page. */
async function manifestParts({ source, fence, exported }: ExportedSource, limit = 2) {
  const parts: Wire.AuthorityExportPart[] = []
  let cursor: string | null = null
  for (;;) {
    const page: Wire.AuthorityTransferControlExportPageResult = ok(
      await source.transfer.exportPage(
        {
          upgradeId: UPGRADE,
          fenceId: fence.fenceId,
          manifestDigest: indexDigest(exported.manifestRoot),
          cursor,
          limit,
        },
        MAINTAINER,
      ),
    )
    expect(page.snapshot).toBe(fence.checkpoint.checkpointId)
    expect(page.items.length).toBeLessThanOrEqual(limit)
    parts.push(...page.items)
    if (page.complete) return parts
    cursor = page.nextCursor
  }
}

/** A new store at another location, reading the source's bytes through the given lender. */
async function candidate(
  world: ExportedSource,
  lender: Pick<BlobReadPort, 'openRead'> = world.source.transferRead,
) {
  const targetDir = await fresh()
  const target = open(
    targetDir,
    trusted,
    maintenance(world.directory, { locationRef: 'location-2', sourceBlobs: lender }),
    true,
  )
  return { target, targetDir }
}

const importRequest = (exported: Wire.AuthorityExport) => ({
  upgradeId: UPGRADE,
  source: exported,
  targetLocationRef: 'location-2',
})

/** The route serving a candidate: its checkpoint is the import's, at the route's epoch. */
const targetRoute = (
  imported: Wire.AuthorityTransferControlImportResult,
  over: Partial<Wire.AuthorityRoute> = {},
) => {
  const authorityEpoch = over.authorityEpoch ?? 2
  return recoveryRoute(authorityEpoch, {
    locationRef: 'location-2',
    cutoverId: 'cutover-1',
    checkpoint: { ...imported.targetCheckpoint, authorityEpoch },
    ...over,
  })
}

const activation = (route: Wire.AuthorityRoute, cutoverId = route.cutoverId) => ({
  upgradeId: UPGRADE,
  cutoverId,
  publishedRoute: inlineData(route as unknown as JsonValue, 'agh.test/authority-route@1'),
})

const probe = (blob: BlobService) => blob.transfer.probe({ upgradeId: UPGRADE }, MAINTAINER)

const BUSINESS_TABLES = ['uploads', 'upload_chunks', 'blobs', 'roots', 'deletions']
const businessRows = (dataDir: string) =>
  BUSINESS_TABLES.reduce(
    (total, table) => total + Number(sql(dataDir, `SELECT COUNT(*) AS n FROM ${table}`)[0]?.n),
    0,
  )

const newUpload = { uploadId: 'upload-new', size: 1, mediaType: 'text/plain', expectedDigest: null }

const flipped = (bytes: Uint8Array) => {
  const out = Buffer.from(bytes)
  out.writeUInt8(out.readUInt8(0) ^ 1, 0)
  return out
}

describe('default blob service authority copy', () => {
  it('moves fenced rows and live content to a candidate that serves only once activated', async () => {
    const world = await exportedSource()
    const { source, fence, exported } = world
    expect(exported).toMatchObject({
      upgradeId: UPGRADE,
      fenceId: fence.fenceId,
      checkpoint: fence.checkpoint,
      collectionCount: 5,
      deletionWatermark: 4,
    })
    const exportAgain = () =>
      source.transfer.export({ upgradeId: UPGRADE, fenceId: fence.fenceId }, MAINTAINER)
    expect(ok(await exportAgain())).toEqual(exported)
    // An export interrupted before it was recorded runs again to the same bytes.
    sql(world.sourceDir, 'DELETE FROM maintenance_exports')
    expect(ok(await exportAgain())).toEqual(exported)
    expect(
      refused(await source.transfer.export({ upgradeId: UPGRADE, fenceId: 'another-fence' }, MAINTAINER)),
    ).toBe('idempotency_conflict')

    // Pages chain by cursor over every part once, ordered by collection and part index.
    const parts = await manifestParts(world)
    expect(parts.length).toBe(exported.partCount)
    const order = parts.map(({ collectionId, partIndex }) => [collectionId, partIndex] as const)
    expect(order).toEqual(
      [...order].sort(([a, i], [b, j]) => Buffer.compare(Buffer.from(a), Buffer.from(b)) || i - j),
    )
    const collections = new Set(parts.map(({ collectionId }) => collectionId))
    expect(collections.size).toBe(5)
    for (const collectionId of collections) {
      const indexes = parts.filter((part) => part.collectionId === collectionId).map((part) => part.partIndex)
      expect(indexes).toEqual(indexes.map((_, at) => at))
    }
    expect(parts.filter(({ collectionId }) => collectionId === 'blob.upload_chunks').length).toBeGreaterThan(
      1,
    )
    expect(parts.reduce((total, { records }) => total + records, 0)).toBe(fence.checkpoint.recordCount)
    const pageRequest = {
      upgradeId: UPGRADE,
      fenceId: fence.fenceId,
      manifestDigest: indexDigest(exported.manifestRoot),
      cursor: null,
      limit: 2,
    }
    expect(refused(await source.transfer.exportPage({ ...pageRequest, cursor: 'bogus' }, MAINTAINER))).toBe(
      'invalid_request',
    )
    expect(refused(await source.transfer.exportPage({ ...pageRequest, limit: 0 }, MAINTAINER))).toBe(
      'invalid_request',
    )
    expect(
      refused(
        await source.transfer.exportPage({ ...pageRequest, manifestDigest: 'e'.repeat(64) }, MAINTAINER),
      ),
    ).toBe('revision_conflict')

    const { target, targetDir } = await candidate(world)
    expect(ok(await probe(target))).toEqual({ state: 'absent' })
    expect(refused(await target.stage(newUpload, ctx()))).toBe('blocked')
    const imported = ok(await target.transfer.import(importRequest(exported), MAINTAINER))
    expect(imported.targetCheckpoint).toMatchObject({
      authorityId: 'blob-authority',
      authorityEpoch: 1,
      snapshotDigest: fence.checkpoint.snapshotDigest,
      recordCount: fence.checkpoint.recordCount,
    })
    expect(ok(await target.transfer.import(importRequest(exported), MAINTAINER))).toEqual(imported)
    expect(
      refused(
        await target.transfer.import(
          { ...importRequest(exported), targetLocationRef: 'location-3' },
          MAINTAINER,
        ),
      ),
    ).toBe('idempotency_conflict')
    const importedProbe = {
      state: 'imported',
      fence,
      exportDigest: canonicalJsonDigest(exported as unknown as JsonValue),
      targetCheckpoint: imported.targetCheckpoint,
    }
    expect(ok(await probe(target))).toEqual(importedProbe)
    expect(ok(await probe(source))).toEqual({ state: 'fenced', fence })

    const validation = ok(
      await target.transfer.verify(
        { upgradeId: UPGRADE, source: exported, candidateRef: imported.candidateRef },
        MAINTAINER,
      ),
    )
    expect(validation).toMatchObject({
      upgradeId: UPGRADE,
      planFingerprint: PLAN,
      candidateDigest: indexDigest(imported.candidateRef),
      sourceSnapshotDigest: fence.checkpoint.snapshotDigest,
      validatorBindings: [],
      accepted: true,
    })
    expect(validation.checks.map(({ checkId, passed }) => [checkId, passed])).toEqual([
      ['snapshot-digest', true],
      ['record-count', true],
      ['required-assets', true],
      ['deletion-watermark', true],
    ])

    const route = targetRoute(imported)
    world.directory.route = route
    const activated = ok(await target.transfer.activate(activation(route), MAINTAINER))
    expect(activated).toEqual({
      state: 'activated',
      cutoverId: 'cutover-1',
      authority: { ...EXPECTED, authorityEpoch: 2 },
      checkpoint: { ...imported.targetCheckpoint, authorityEpoch: 2 },
    })
    expect(activated.state === 'activated' && activated.checkpoint.snapshotDigest).toBe(
      fence.checkpoint.snapshotDigest,
    )
    expect(ok(await target.transfer.activate(activation(route), MAINTAINER))).toEqual(activated)
    expect(ok(await probe(target))).toEqual(activated)
    expect(ok(await probe(source))).toEqual({ state: 'fenced', fence })

    // The target serves the source's pins and open uploads; collected content stays gone.
    expect(
      ok(await target.blobRead.readRange({ ref: world.kept, offset: 0, length: 64 }, ctx())).bytes,
    ).toEqual(text('kept bytes'))
    expect(existsSync(contentFile(targetDir, world.collected))).toBe(false)
    const writer = ok(target.openWriter('upload-open', ctx()))
    ok(writer.write(5 * MIB, world.partial.subarray(5 * MIB)))
    expect(ok(await writer.seal()).upload.digest).toBe(sha(world.partial))
    writer.close()
    ok(await target.stage(newUpload, ctx()))
    expect(refused(await source.stage(newUpload, ctx()))).toBe('blocked')
    expect(refused(await source.transfer.import(importRequest(exported), MAINTAINER))).toBe(
      'revision_conflict',
    )
    // Only a fenced store lends its bytes, and only to the maintenance controller.
    const lend = (blob: BlobService, context: CallContext) =>
      blob.transferRead.openRead({ ref: world.kept, offset: 0 }, context)
    expect(refused(await lend(target, MAINTAINER))).toBe('blocked')
    expect(refused(await lend(source, ctx()))).toBe('permission_denied')

    const reopened = reopen(target, targetDir, maintenance(world.directory, { locationRef: 'location-2' }))
    expect(ok(await probe(reopened))).toEqual(activated)
  })

  it('resumes an interrupted import from its last accepted step without repeating a row', async () => {
    const world = await exportedSource()
    let budget = Number.POSITIVE_INFINITY
    const lender: Pick<BlobReadPort, 'openRead'> = {
      openRead: async (request, context) => {
        if (budget <= 0) return unavailable('lender_unavailable', 'the source stopped lending')
        budget -= 1
        return world.source.transferRead.openRead(request, context)
      },
    }
    const { target, targetDir } = await candidate(world, lender)
    const request = importRequest(world.exported)
    for (const calls of [2, 6]) {
      budget = calls
      expect(refused(await target.transfer.import(request, MAINTAINER))).toBe('lender_unavailable')
      expect(ok(await probe(target))).toEqual({ state: 'absent' })
    }
    expect(businessRows(targetDir)).toBeGreaterThan(0)
    expect(businessRows(targetDir)).toBeLessThan(world.fence.checkpoint.recordCount)

    budget = Number.POSITIVE_INFINITY
    const imported = ok(await target.transfer.import(request, MAINTAINER))
    expect(imported.targetCheckpoint).toMatchObject({
      snapshotDigest: world.fence.checkpoint.snapshotDigest,
      recordCount: world.fence.checkpoint.recordCount,
    })
    expect(businessRows(targetDir)).toBe(world.fence.checkpoint.recordCount)
  })

  it('refuses export chunks and assets whose bytes do not match their digest, and parts that do not match their counts', async () => {
    const world = await exportedSource()
    const parts = await manifestParts(world)
    const chunks = new Set(parts.map(({ contentDigest }) => contentDigest))
    let lie = false
    const lender: Pick<BlobReadPort, 'openRead'> = {
      openRead: async (request, context) => {
        const opened = await world.source.transferRead.openRead(request, context)
        if (!lie || !opened.ok || !chunks.has(request.ref.digest)) return opened
        const original = opened.value.chunks
        // Rows stay well-formed: one hex letter of an id or digest changes.
        async function* changed() {
          for await (const chunk of original) {
            const out = Buffer.from(chunk)
            const at = out.indexOf('a')
            if (at >= 0) out.writeUInt8(0x62, at)
            yield out
          }
        }
        return { ok: true, value: { ...opened.value, chunks: changed() } }
      },
    }
    const { target } = await candidate(world, lender)
    const request = importRequest(world.exported)
    // Content changed behind the export, first of an asset and then of a part's chunk.
    for (const digest of [world.kept.digest, parts[0]?.contentDigest ?? '']) {
      const file = contentFile(world.sourceDir, digest)
      const original = readFileSync(file)
      writeFileSync(file, flipped(original))
      expect(refused(await target.transfer.import(request, MAINTAINER))).toBe('integrity')
      writeFileSync(file, original)
    }
    // A lender handing over other bytes than the part names.
    lie = true
    expect(refused(await target.transfer.import(request, MAINTAINER))).toBe('integrity')
    lie = false
    expect(ok(await target.transfer.import(request, MAINTAINER)).targetCheckpoint.snapshotDigest).toBe(
      world.fence.checkpoint.snapshotDigest,
    )
    // The manifest's parts name five collections, so an export declaring other counts is refused.
    for (const counts of [{ collectionCount: 4 }, { partCount: world.exported.partCount + 1 }]) {
      const { target: other } = await candidate(world)
      const forged = importRequest({ ...world.exported, ...counts })
      expect(refused(await other.transfer.import(forged, MAINTAINER))).toBe('integrity')
    }
  })

  it('fails verification for a row or content missing behind the import', async () => {
    const world = await exportedSource()
    const { target, targetDir } = await candidate(world)
    const imported = ok(await target.transfer.import(importRequest(world.exported), MAINTAINER))
    const verify = (candidateRef = imported.candidateRef) =>
      target.transfer.verify({ upgradeId: UPGRADE, source: world.exported, candidateRef }, MAINTAINER)
    sql(targetDir, `DELETE FROM roots WHERE pin_id = '${world.kept.pinId}'`)
    rmSync(contentFile(targetDir, world.kept.digest))
    const validation = ok(await verify())
    expect(validation.accepted).toBe(false)
    expect(validation.checks.filter(({ passed }) => !passed).map(({ checkId }) => checkId)).toEqual([
      'snapshot-digest',
      'record-count',
      'required-assets',
    ])
    expect(refused(await verify(inlineData({ other: true }, 'agh.test/candidate@1')))).toBe(
      'revision_conflict',
    )
  })

  it('activates a candidate only onto the route the directory durably holds', async () => {
    const world = await exportedSource()
    const { target } = await candidate(world)
    const early = recoveryRoute(2, { locationRef: 'location-2', cutoverId: 'cutover-1' })
    world.directory.route = early
    expect(refused(await target.transfer.activate(activation(early), MAINTAINER))).toBe('not_found')
    const imported = ok(await target.transfer.import(importRequest(world.exported), MAINTAINER))
    const route = targetRoute(imported)
    expect(refused(await target.stage(newUpload, ctx()))).toBe('blocked')

    world.directory.route = targetRoute(imported, { cohortDigest: 'e'.repeat(64) })
    expect(refused(await target.transfer.activate(activation(route), MAINTAINER))).toBe('revision_conflict')
    world.directory.route = route
    expect(refused(await target.transfer.activate(activation(route, 'cutover-2'), MAINTAINER))).toBe(
      'revision_conflict',
    )
    for (const other of [
      targetRoute(imported, { locationRef: 'location-1' }),
      targetRoute(imported, { authorityEpoch: 1 }),
      // A route published for another candidate.
      targetRoute(imported, { checkpoint: { ...route.checkpoint, checkpointId: 'other-candidate' } }),
    ]) {
      world.directory.route = other
      expect(refused(await target.transfer.activate(activation(other), MAINTAINER))).toBe('revision_conflict')
    }
    world.directory.route = route
    expect(refused(await target.transfer.activate(activation(route), ctx()))).toBe('permission_denied')
    expect(refused(await target.stage(newUpload, ctx()))).toBe('blocked')

    ok(await target.transfer.activate(activation(route), MAINTAINER))
    expect(
      refused(
        await target.transfer.activate(activation(targetRoute(imported, { authorityEpoch: 3 })), MAINTAINER),
      ),
    ).toBe('idempotency_conflict')
    ok(await target.stage(newUpload, ctx()))
  })
})

describe('default blob service descriptor', () => {
  it('offers each remote method of its declared features and refuses a binding of another contract', async () => {
    const configSchema = { typeId: 'agh.test/config@1', revision: 1, digest: 'c'.repeat(64) }
    const input = { binding: BINDING, packageVersion: '1.0.0', packageDigest: 'a'.repeat(64), configSchema }
    const descriptor = blobProviderDescriptor(input)
    const transfer = blobProviderDescriptor({ ...input, maintenance: maintenance({}) })
    const catalog: Record<string, { kind?: string }> = RuntimeServiceCatalog['agh.blob'].methods
    const refs: Record<string, unknown> = RuntimeMethodSchemaRefs['agh.blob']
    for (const offered of [descriptor, transfer]) {
      expect(validateRuntime('ProviderDescriptor', offered).ok).toBe(true)
      expect(offered).toMatchObject({
        providerId: BINDING.providerId,
        contract: 'agh.blob',
        major: 1,
        logicalName: 'default',
        requires: [],
      })
      for (const { method, kind, inputSchema, outputSchema } of offered.operations) {
        expect(kind).toBe(catalog[method]?.kind)
        expect({ input: inputSchema, output: outputSchema }).toEqual(refs[method])
      }
    }
    const blobOperations = [
      ['stage', 'idempotent'],
      ['promote', 'idempotent'],
      ['pin', 'idempotent'],
      ['unpin', 'never'],
      ['gc', 'never'],
      ['inspect', 'read-only'],
    ]
    expect(descriptor.features).toEqual([...BLOB_FEATURES])
    expect(descriptor.operations.map(({ method, retrySafety }) => [method, retrySafety])).toEqual(
      blobOperations,
    )
    expect(transfer.features).toEqual([...BLOB_FEATURES, 'authority-transfer.v1'])
    expect(transfer.operations.map(({ method, retrySafety }) => [method, retrySafety]).sort()).toEqual(
      [
        ...blobOperations,
        ['authorityFence', 'idempotent'],
        ['authorityExport', 'idempotent'],
        ['authorityExportPage', 'idempotent'],
        ['authorityImport', 'idempotent'],
        ['authorityVerify', 'idempotent'],
        ['authorityActivate', 'idempotent'],
        ['authorityAbort', 'idempotent'],
        ['authorityProbe', 'read-only'],
      ].sort(),
    )
    expect(() =>
      blobProviderDescriptor({ ...input, binding: { ...BINDING, contract: 'agh.files' } }),
    ).toThrow()

    // Without a maintenance assembly, a store takes no part in a transfer.
    const plain = open(await fresh())
    for (const method of Object.keys(plain.transfer) as (keyof AuthorityTransferControl)[])
      expect(refused(await plain.transfer[method]({} as never, MAINTAINER))).toBe('operation_not_supported')
  })
})

/**
 * The shared suite lives outside this package's build, so it is loaded by URL, as the conformance
 * runner loads binders. Only the parts used here are typed.
 */
type BlobSuite = {
  createBlobReadGate(): {
    allows(context: CallContext, ref: Wire.BlobRef): boolean
    revoke(ref: Wire.BlobRef): void
  }
  blobContractPort(subject: object): unknown
  registerBlobContract(harness: ConformanceHarness, binding: object): void
}
type TransferSuite = {
  TRANSFER_MAINTAINER: string
  transferContractPort(subject: object): unknown
  registerAuthorityTransferContract(harness: ConformanceHarness, contract: string, binding: object): void
}
type TransferStore = {
  control(): AuthorityTransferControl
  write(): Promise<string | null>
  serves(): Promise<boolean>
  reopen(): Promise<void>
  close(): Promise<void>
}

const BUILD: BuildIdentity = {
  codeSha: 'host-test',
  buildDigest: 'host-test-build',
  lockDigest: 'host-test-lock',
  specVersion: 'host-test-spec',
  sdkVersion: 'host-test-sdk',
  sdkDigest: 'host-test-sdk-digest',
  platform: 'host-test-platform',
}
const fileDigest = (path: string) => sha(readFileSync(new URL(path, import.meta.url)))
const CONFORMANCE_BINDING = { ...BINDING, logicalName: 'conformance', providerId: 'default' }

/**
 * Default blob worlds for the authority transfer suite: a source holding live, released and collected
 * content and no upload still receiving bytes, so one of its tables exports no part; candidate targets
 * in their own directories; and a directory holding the one published route of the blob authority.
 */
function blobTransferSubject(maintainer: string) {
  return {
    async open(maintained: boolean) {
      const root = await fresh()
      const directory: { route?: Wire.AuthorityRoute; targetActivated?: boolean } = {}
      let cut: number | null = null
      const lender: Pick<BlobReadPort, 'openRead'> = {
        openRead: async (request, context) => {
          if (cut === 0) return unavailable('lender_unavailable', 'the source stopped lending')
          if (cut !== null) cut -= 1
          return source.current().transferRead.openRead(request, context)
        },
      }
      const fixture = (locationRef: string) =>
        maintained
          ? maintenance(directory, {
              authorize: (context) => context.authorizationRef === maintainer,
              locationRef,
              sourceBlobs: lender,
            })
          : undefined
      const seeded = { live: [] as [Wire.BlobRef, Uint8Array][], deleted: [] as Wire.BlobRef[] }
      const store = (locationRef: string, target: boolean) => {
        const dataDir = join(root, locationRef)
        mkdirSync(dataDir, { recursive: true })
        const start = () => open(dataDir, trusted, fixture(locationRef), target)
        let current = start()
        let writes = 0
        return {
          dataDir,
          current: () => current,
          control: () => current.transfer,
          async write() {
            const outcome = await current.stage({ ...newUpload, uploadId: `upload-write-${++writes}` }, ctx())
            return outcome.ok ? null : outcome.error.detailCode
          },
          async serves() {
            for (const [ref, bytes] of seeded.live) {
              const read = await current.blobRead.readRange(
                { ref, offset: 0, length: bytes.byteLength },
                ctx(),
              )
              if (!read.ok || Buffer.compare(read.value.bytes, bytes) !== 0) return false
            }
            for (const ref of seeded.deleted) {
              const read = await current.blobRead.readRange({ ref, offset: 0, length: 1 }, ctx())
              if (read.ok || read.error.detailCode !== 'artifact_deleted') return false
            }
            return true
          },
          async reopen() {
            current.close()
            current = start()
          },
          close: async () => current.close(),
        } satisfies TransferStore & { dataDir: string; current(): BlobService }
      }
      const source = store('location-1', false)
      const stores = new Map([['location-1', source]])
      const blob = source.current()
      for (const [at, bytes] of [text('live bytes'), text('more live bytes')].entries())
        seeded.live.push([await pinned(blob, bytes, `upload-live-${at}`), bytes])
      const gone = await sealed(blob, 'upload-gone', text('collected bytes'))
      const stagedBlob = ok(
        await blob.promote({ upload: gone.upload, expectedDigest: gone.upload.digest }, ctx()),
      )
      const ownerRef: Wire.PublicRef = {
        kind: 'artifact',
        value: { artifactId: 'artifact-gone', version: 1 },
      }
      const collected = ok(await blob.pin({ stagedBlob, ownerRef, retentionUntil: null }, ctx()))
      for (const pinId of [collected.pinId, gone.retention.pinId])
        ok(await blob.unpin({ pinId, expectedRevision: 1 }, ctx()))
      ok(await blob.gc({ scopeRef: scope(), dryRun: false, cursor: null, limit: 100 }, ctx()))
      seeded.deleted.push(collected)
      const configSchema = { typeId: 'agh.test/config@1', revision: 1, digest: 'c'.repeat(64) }
      return {
        descriptor: blobProviderDescriptor({
          binding: CONFORMANCE_BINDING,
          packageVersion: '1.0.0',
          packageDigest: fileDigest('../../src/runtime/providers/blob.ts'),
          configSchema,
          ...(maintained ? { maintenance: maintenance(directory) } : {}),
        }),
        source,
        authority: EXPECTED,
        locationRef: 'location-1',
        providerBinding: CONFORMANCE_BINDING,
        async target(locationRef: string) {
          const found = stores.get(locationRef) ?? store(locationRef, true)
          stores.set(locationRef, found)
          return found
        },
        publish(route: Wire.AuthorityRoute, targetActivated: boolean) {
          directory.route = route
          directory.targetActivated = targetActivated
        },
        cut(after: number | null) {
          cut = after
        },
        // One hex letter changes, so the chunk still parses and only its digest tells.
        async tamper(chunk: Wire.BlobRef) {
          const file = contentFile(source.dataDir, chunk.digest)
          const bytes = readFileSync(file)
          const at = bytes.findIndex((byte) => byte >= 0x61 && byte <= 0x66)
          if (at < 0) throw new Error('the chunk has no hex letter to change')
          bytes[at] = bytes[at] === 0x61 ? 0x62 : 0x61
          writeFileSync(file, bytes)
        },
        async damage(locationRef: string) {
          sql(join(root, locationRef), 'UPDATE roots SET revision = revision + 1')
        },
        async dispose() {
          for (const each of stores.values()) await each.close()
          await rm(root, { recursive: true, force: true })
        },
      }
    },
  }
}

describe('default blob service: conformance', () => {
  it('passes the shared blob suite and the authority transfer suite in all six scenarios', async () => {
    const suite = (await import(
      new URL('../../../extension-api/testkit/runtime/contracts/blob.ts', import.meta.url).href
    )) as BlobSuite
    const transfer = (await import(
      new URL('../../../extension-api/testkit/runtime/contracts/authority-transfer.ts', import.meta.url).href
    )) as TransferSuite
    const dataDir = await fresh()
    const gate = suite.createBlobReadGate()
    const start = () =>
      createBlobService({
        dataDir,
        authorityId: 'blob-authority',
        binding: BINDING,
        authorizeRead: gate.allows,
      })
    let current = start()
    let live = true
    let seeds = 0
    const shut = () => {
      if (live) current.close()
      live = false
    }
    const port = suite.blobContractPort({
      binding: {
        requirement: {
          contract: 'agh.blob',
          major: 1,
          logicalName: 'conformance',
          features: [...BLOB_FEATURES],
          scope: 'runtime',
          optional: false,
        },
        binding: CONFORMANCE_BINDING,
        blobRead: current.blobRead,
      },
      gate,
      read: () => current.blobRead,
      seed: (bytes: Uint8Array) => pinned(current, bytes, `conformance-${++seeds}`),
      corrupt: async (ref: Wire.BlobRef, bytes: Uint8Array) =>
        writeFileSync(join(dataDir, 'artifacts', 'sha256', ref.digest.slice(0, 2), ref.digest), bytes),
      async reopen() {
        shut()
        current = start()
        live = true
      },
      close: async () => shut(),
      remains: () => existsSync(join(dataDir, 'artifacts', 'blob-service.db')),
    })
    const harness = createConformanceHarness()
    const binding = {
      providerId: 'default',
      recipe: 'packages/host/src/runtime/providers/blob.ts',
      command: 'host-blob-conformance',
      build: BUILD,
      providerDigest: fileDigest('../../src/runtime/providers/blob.ts'),
      configDigest: canonicalJsonDigest({ authorityId: 'blob-authority' }),
      releaseSetDigest: fileDigest('../../package.json'),
    }
    suite.registerBlobContract(harness, { ...binding, port })
    transfer.registerAuthorityTransferContract(harness, 'agh.blob', {
      ...binding,
      port: transfer.transferContractPort(blobTransferSubject(transfer.TRANSFER_MAINTAINER)),
    })
    try {
      const report = await harness.run({
        contracts: ['agh.blob'],
        providers: ['default'],
        command: 'host-blob-conformance',
        clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
      })
      expect(report.assertions.map((item) => [item.id, item.status])).toEqual(
        ['', '/authority-transfer'].flatMap((name) =>
          SCENARIOS.map((scenario) => [`agh.blob/default${name}/${scenario}`, 'passed']),
        ),
      )
    } finally {
      shut()
    }
  })
})
