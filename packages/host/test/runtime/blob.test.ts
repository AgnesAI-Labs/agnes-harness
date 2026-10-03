import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, Outcome, ScopeRef } from '@agnes/extension-api/runtime'
import {
  type BuildIdentity,
  type ConformanceHarness,
  createConformanceHarness,
  SCENARIOS,
} from '@agnes/extension-api/testkit'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeArtifactPolicy,
  RuntimeClientTransportPolicy,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BLOB_FEATURES,
  type BlobService,
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

function open(dataDir: string, authorizeRead?: (context: CallContext) => boolean): BlobService {
  const service = createBlobService({
    dataDir,
    authorityId: 'blob-authority',
    binding: BINDING,
    now: () => clock,
    ...(authorizeRead ? { authorizeRead } : {}),
  })
  services.push(service)
  return service
}

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
    const blob = open(await fresh())
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

describe('default blob service descriptor', () => {
  it('offers each remote method of its declared features and refuses a binding of another contract', () => {
    const configSchema = { typeId: 'agh.test/config@1', revision: 1, digest: 'c'.repeat(64) }
    const input = { binding: BINDING, packageVersion: '1.0.0', packageDigest: 'a'.repeat(64), configSchema }
    const descriptor = blobProviderDescriptor(input)
    expect(validateRuntime('ProviderDescriptor', descriptor).ok).toBe(true)
    expect(descriptor).toMatchObject({
      providerId: BINDING.providerId,
      contract: 'agh.blob',
      major: 1,
      logicalName: 'default',
      features: [...BLOB_FEATURES],
      requires: [],
    })
    const catalog: Record<string, { kind?: string }> = RuntimeServiceCatalog['agh.blob'].methods
    const refs: Record<string, unknown> = RuntimeMethodSchemaRefs['agh.blob']
    for (const { method, kind, inputSchema, outputSchema } of descriptor.operations) {
      expect(kind).toBe(catalog[method]?.kind)
      expect({ input: inputSchema, output: outputSchema }).toEqual(refs[method])
    }
    expect(descriptor.operations.map(({ method, retrySafety }) => [method, retrySafety])).toEqual([
      ['stage', 'idempotent'],
      ['promote', 'idempotent'],
      ['pin', 'idempotent'],
      ['unpin', 'never'],
      ['gc', 'never'],
      ['inspect', 'read-only'],
    ])
    expect(() =>
      blobProviderDescriptor({ ...input, binding: { ...BINDING, contract: 'agh.files' } }),
    ).toThrow()
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

describe('default blob service: conformance', () => {
  it('passes the shared blob suite in all six scenarios', async () => {
    const suite = (await import(
      new URL('../../../extension-api/testkit/runtime/contracts/blob.ts', import.meta.url).href
    )) as BlobSuite
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
        binding: { ...BINDING, logicalName: 'conformance', providerId: 'default' },
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
    suite.registerBlobContract(harness, {
      providerId: 'default',
      recipe: 'packages/host/src/runtime/providers/blob.ts',
      command: 'host-blob-conformance',
      build: BUILD,
      providerDigest: fileDigest('../../src/runtime/providers/blob.ts'),
      configDigest: canonicalJsonDigest({ authorityId: 'blob-authority' }),
      releaseSetDigest: fileDigest('../../package.json'),
      port,
    })
    try {
      const report = await harness.run({
        contracts: ['agh.blob'],
        providers: ['default'],
        command: 'host-blob-conformance',
        clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
      })
      expect(report.assertions.map((item) => [item.scenario, item.status])).toEqual(
        SCENARIOS.map((scenario) => [scenario, 'passed']),
      )
    } finally {
      shut()
    }
  })
})
