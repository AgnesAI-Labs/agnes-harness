import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ArtifactAccessPort,
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
  createTestServiceContainer,
  SCENARIOS,
  type TestServiceBinding,
} from '@agnes/extension-api/testkit'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  type JsonValue,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import type { TransferMaintenance } from '../../src/runtime/authority-transfer.js'
import { inlineData } from '../../src/runtime/maintenance/authority-publication.js'
import {
  type ArtifactsService,
  artifactsFeatures,
  artifactsProviderDescriptor,
  BLOB_REQUIREMENT,
  type BlobTransfer,
  createArtifactsService,
  type OwnerAction,
  type SelectedBlobActions,
} from '../../src/runtime/providers/artifacts.js'
import { BLOB_FEATURES, type BlobService, createBlobService } from '../../src/runtime/providers/blob.js'
import { artifactTicketKeys } from './artifact-ticket-key-fixture.js'

const BLOB_BINDING = {
  bindingId: 'blob-1',
  contract: 'agh.blob',
  logicalName: 'default',
  providerId: 'agh.blob.default',
}
const DESCRIPTOR = RuntimeSchemaRefs.ArtifactContentDescriptor
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
    bindingId: 'artifacts-1',
    invocationId: 'invocation-1',
    deadline: '2026-10-02T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'auth-ok',
    signal: new AbortController().signal,
    ...over,
  }
}

function owner(actionId = 'action-1', sessionId = 'session-1'): OwnerAction {
  return {
    run: {
      runId: 'run-1',
      session: { sessionId, authority: { authorityId: 'state-1', tenantId: 'tenant-1', authorityEpoch: 1 } },
    },
    actionId,
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
const closers: (() => unknown)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** The ticket key option over a real default broker in its own directory, closed after the test. */
async function ticketKeys(now?: () => number) {
  const dir = await mkdtemp(join(tmpdir(), 'agh-ticket-keys-'))
  dirs.push(dir)
  const tickets = artifactTicketKeys(join(dir, 'secrets'), now)
  closers.push(() => tickets.broker.close())
  return tickets.keys
}

type World = { dataDir: string; blob: BlobService; artifacts: ArtifactsService; reads: { count: number } }
/**
 * Both services take part in transfers: each gets its maintenance assembly, and the artifacts service
 * holds its export through the blob service's transfer entry.
 */
type Transfer = { maintenance(authorityId: string): TransferMaintenance; target?: boolean }

/**
 * The default artifacts service over the default blob service, each in its own database,
 * assembled through the test container.
 */
async function world(
  dataDir?: string,
  adjust: (blob: BlobService) => Partial<SelectedBlobActions> = () => ({}),
  transfer?: Transfer,
): Promise<World> {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), 'agh-artifacts-')))
  if (!dataDir) dirs.push(dir)
  const target = transfer?.target === true
  const blob = createBlobService({
    dataDir: dir,
    authorityId: 'blob-authority',
    binding: BLOB_BINDING,
    authorizeRead: (context) => context.authorizationRef === 'auth-ok',
    ...(transfer ? { maintenance: transfer.maintenance('blob-authority'), transferTarget: target } : {}),
  })
  closers.push(() => blob.close())
  const reads = { count: 0 }
  const blobRead: BlobReadPort = {
    readRange: (request, context) => {
      reads.count += 1
      return blob.blobRead.readRange(request, context)
    },
    openRead: (request, context) => {
      reads.count += 1
      return blob.blobRead.openRead(request, context)
    },
  }
  const container = createTestServiceContainer()
  container.register({ requirement: BLOB_REQUIREMENT, binding: BLOB_BINDING, blobRead })
  const artifacts = ok(
    createArtifactsService({
      dataDir: dir,
      authorityId: 'artifacts-authority',
      dependencies: container.dependencies,
      blobActions: { ...blob, ...adjust(blob) },
      authorize: (context) => context.authorizationRef === 'auth-ok',
      ...(transfer
        ? {
            maintenance: transfer.maintenance('artifacts-authority'),
            blobTransfer: blob,
            transferTarget: target,
          }
        : {}),
    }),
  )
  closers.push(() => artifacts.close())
  return { dataDir: dir, blob, artifacts, reads }
}

/** Reads the persisted artifacts store, as a restarted process would find it. */
function stored(dataDir: string, statement: string): Record<string, unknown>[] {
  const db = new DatabaseSync(join(dataDir, 'artifacts', 'artifacts-service.db'), { readOnly: true })
  try {
    return db.prepare(statement).all()
  } finally {
    db.close()
  }
}

function reserveRequest(publicationId: string, over: Record<string, unknown> = {}) {
  return {
    publicationId,
    artifactId: null,
    expectedLatestVersion: null,
    kind: DESCRIPTOR.typeId,
    schema: DESCRIPTOR,
    title: null,
    mediaType: null,
    ownerActionRef: { existingActionId: 'action-1' },
    ...over,
  }
}

async function sealedUpload(
  blob: BlobService,
  uploadId: string,
  bytes: Uint8Array,
  mediaType = 'text/plain',
) {
  ok(await blob.stage({ uploadId, size: bytes.byteLength, mediaType, expectedDigest: null }, ctx()))
  const writer = ok(blob.openWriter(uploadId, ctx()))
  ok(writer.write(0, bytes))
  const result = ok(await writer.seal())
  writer.close()
  return result.upload
}

const publishRequest = (
  publicationId: string,
  upload: Wire.UploadRef,
  over: Record<string, unknown> = {},
) => ({
  publicationId,
  source: { kind: 'upload', upload },
  expectedRevision: 1,
  title: 'Report',
  mediaType: 'text/plain',
  ...over,
})

async function readGrant(
  artifacts: ArtifactsService,
  artifactRef: Wire.ArtifactRef,
  requestId = 'grant-1',
  granteePrincipalRef = 'user-1',
  actor = owner(),
) {
  return ok(
    await artifacts.grant(
      {
        request: {
          requestId,
          artifactRef,
          granteePrincipalRef,
          scope: scope(),
          permissions: ['read', 'download'],
          expiresAt: null,
        },
        owner: actor,
        sourceAuthorizationRef: 'policy-1',
      },
      ctx(),
    ),
  )
}

describe('default artifacts publication', () => {
  it('starts a new artifact at version 1 and allocates later versions only by compare and swap', async () => {
    const { artifacts } = await world()
    const first = ok(await artifacts.reserve({ request: reserveRequest('pub-1'), owner: owner() }, ctx()))
    expect(first).toMatchObject({ version: 1, revision: 1, state: 'reserved', blob: null, pinId: null })
    const existing = (publicationId: string, expectedLatestVersion: number, actionId = 'action-1') => ({
      request: reserveRequest(publicationId, { artifactId: first.artifactId, expectedLatestVersion }),
      owner: owner(actionId),
    })
    expect(ok(await artifacts.reserve(existing('pub-2', 1), ctx()))).toMatchObject({ version: 2 })
    expect(refused(await artifacts.reserve(existing('pub-3', 1), ctx()))).toBe('revision_conflict')
    const raced = await Promise.all([
      artifacts.reserve(existing('pub-4', 2), ctx()),
      artifacts.reserve(existing('pub-5', 2), ctx()),
    ])
    expect(raced.filter((item) => item.ok).map((item) => ok(item).version)).toEqual([3])
    expect(raced.filter((item) => !item.ok).map(refused)).toEqual(['revision_conflict'])
    const elsewhere = { ...existing('pub-6', 3), owner: owner('action-1', 'session-2') }
    expect(refused(await artifacts.reserve(elsewhere, ctx()))).toBe('permission_denied')
    expect(
      refused(
        await artifacts.reserve(
          {
            request: reserveRequest('pub-7', { artifactId: 'missing', expectedLatestVersion: 1 }),
            owner: owner(),
          },
          ctx(),
        ),
      ),
    ).toBe('not_found')
    expect(
      refused(await artifacts.reserve({ request: reserveRequest('pub-8'), owner: owner('action-2') }, ctx())),
    ).toBe('permission_denied')
  })

  it('returns the original reservation for the same publication input and never reuses a failed version', async () => {
    const { artifacts, blob } = await world()
    const reserved = ok(await artifacts.reserve({ request: reserveRequest('pub-1'), owner: owner() }, ctx()))
    const upload = await sealedUpload(blob, 'upload-1', text('report'))
    ok(await artifacts.publish({ request: publishRequest('pub-1', upload), owner: owner() }, ctx()))
    const again = ok(await artifacts.reserve({ request: reserveRequest('pub-1'), owner: owner() }, ctx()))
    expect(again).toMatchObject({
      publicationId: 'pub-1',
      artifactId: reserved.artifactId,
      version: 1,
      state: 'ready',
    })
    expect(
      refused(
        await artifacts.reserve(
          { request: reserveRequest('pub-1', { title: 'Other' }), owner: owner() },
          ctx(),
        ),
      ),
    ).toBe('idempotency_conflict')

    const second = ok(
      await artifacts.reserve(
        {
          request: reserveRequest('pub-2', { artifactId: reserved.artifactId, expectedLatestVersion: 1 }),
          owner: owner(),
        },
        ctx(),
      ),
    )
    const failureRef = { authorityId: 'state-1', receiptId: 'receipt-1', digest: 'a'.repeat(64) }
    ok(
      await artifacts.fail(
        {
          request: { publicationId: 'pub-2', expectedRevision: 1, failureRef },
          owner: owner(),
          receipt: { actionId: 'action-1', receiptId: 'receipt-1', outcome: 'failed' },
        },
        ctx(),
      ),
    )
    const third = ok(
      await artifacts.reserve(
        {
          request: reserveRequest('pub-3', { artifactId: reserved.artifactId, expectedLatestVersion: 2 }),
          owner: owner(),
        },
        ctx(),
      ),
    )
    expect([second.version, third.version]).toEqual([2, 3])
  })

  it('holds publish to the reserved title and media type, the sealed upload and the owner', async () => {
    const { artifacts, blob } = await world()
    ok(
      await artifacts.reserve(
        { request: reserveRequest('pub-1', { title: 'Report', mediaType: 'text/plain' }), owner: owner() },
        ctx(),
      ),
    )
    const upload = await sealedUpload(blob, 'upload-1', text('report'))
    const html = await sealedUpload(blob, 'upload-2', text('<p>report</p>'), 'text/html')
    const attempt = (request: unknown, actor = owner()) => artifacts.publish({ request, owner: actor }, ctx())
    expect(refused(await attempt(publishRequest('pub-1', upload, { title: 'Other' })))).toBe(
      'invalid_request',
    )
    expect(refused(await attempt(publishRequest('pub-1', html, { mediaType: 'text/html' })))).toBe(
      'invalid_request',
    )
    expect(refused(await attempt(publishRequest('pub-1', html)))).toBe('invalid_request')
    expect(refused(await attempt(publishRequest('pub-1', upload), owner('action-2')))).toBe(
      'permission_denied',
    )
    expect(refused(await attempt(publishRequest('pub-1', upload, { expectedRevision: 2 })))).toBe(
      'revision_conflict',
    )
    expect(refused(await attempt(publishRequest('pub-9', upload)))).toBe('not_found')
    // A stage response is an open session, never a sealed upload, and a sealed reference built from it
    // before the seal commits neither promotes nor publishes.
    const session = ok(
      await blob.stage(
        { uploadId: 'upload-3', size: 6, mediaType: 'text/plain', expectedDigest: upload.digest },
        ctx(),
      ),
    )
    expect(session.status).toBe('uploading')
    expect(validateRuntime('UploadRef', session).ok).toBe(false)
    const early: Wire.UploadRef = {
      authorityId: session.authorityId,
      uploadId: session.uploadId,
      reservationId: session.reservationId,
      digest: upload.digest,
      bytes: 6,
      mediaType: 'text/plain',
      status: 'sealed',
    }
    expect(refused(await blob.promote({ upload: early, expectedDigest: early.digest }, ctx()))).toBe(
      'not_found',
    )
    ok(await artifacts.reserve({ request: reserveRequest('pub-2'), owner: owner() }, ctx()))
    expect(refused(await attempt(publishRequest('pub-2', early)))).toBe('not_found')
    const ready = ok(await attempt(publishRequest('pub-1', upload)))
    expect(ready).toMatchObject({ state: 'ready', revision: 3, title: 'Report', mediaType: 'text/plain' })
    expect(ready.pinId).toBe(ready.blob?.pinId)
    expect(refused(await attempt(publishRequest('pub-1', html, { mediaType: 'text/html' })))).toBe(
      'idempotency_conflict',
    )
    expect(artifacts.pendingEvents().map((event) => event.eventKey)).toEqual(['pub-1:ready'])
  })

  it('reaches ready only after the pin is confirmed and converges on one pin and one event', async () => {
    let failInspect = true
    const first = await world(undefined, (blob) => ({
      inspect: async (request, context) =>
        failInspect
          ? {
              ok: false,
              error: {
                code: 'retryable',
                detailCode: 'backend_unavailable',
                message: 'injected',
                retryAdvice: { kind: 'retry_read' },
                diagnosticId: 'test',
              },
            }
          : blob.inspect(request, context),
    }))
    const reserved = ok(
      await first.artifacts.reserve({ request: reserveRequest('pub-1'), owner: owner() }, ctx()),
    )
    const artifactRef = { artifactId: reserved.artifactId, version: 1 }
    await readGrant(first.artifacts, artifactRef)
    const upload = await sealedUpload(first.blob, 'upload-1', text('report'))
    const publish = () =>
      first.artifacts.publish({ request: publishRequest('pub-1', upload), owner: owner() }, ctx())

    expect(refused(await publish())).toBe('backend_unavailable')
    expect(ok(await first.artifacts.query({ artifactRef }, ctx())).status).toBe('pending-publish')
    expect(first.artifacts.pendingEvents()).toEqual([])
    failInspect = false
    const ready = ok(await publish())
    expect(ready.state).toBe('ready')
    expect(ok(await publish())).toEqual(ready)
    expect(first.artifacts.pendingEvents()).toEqual([
      { eventKey: 'pub-1:ready', kind: 'ready', reservation: ready },
    ])
    first.artifacts.close()
    first.blob.close()
    closers.splice(0)

    const restarted = await world(first.dataDir)
    expect(
      ok(
        await restarted.artifacts.publish(
          { request: publishRequest('pub-1', upload), owner: owner() },
          ctx(),
        ),
      ),
    ).toEqual(ready)
    expect(restarted.artifacts.pendingEvents()).toHaveLength(1)
    const staged = ok(await restarted.blob.promote({ upload, expectedDigest: upload.digest }, ctx()))
    expect(
      ok(await restarted.blob.inspect({ ref: { kind: 'staged-blob', value: staged } }, ctx())),
    ).toMatchObject({
      status: 'pinned',
      ownerRefs: [{ kind: 'artifact', value: artifactRef }],
    })
    expect(ok(await restarted.artifacts.artifactAccess.describe(artifactRef, ctx()))).toEqual({
      ...artifactRef,
      title: 'Report',
      mime: 'text/plain',
      size: 6,
      status: 'ready',
    })
  })

  it('keeps each artifact version on a pin of its own, never a pinned blob or a pin lent from another owner', async () => {
    // A selected blob service that hands back a pin another owner took instead of pinning for this one.
    let lent: Wire.BlobRef | undefined
    const { artifacts, blob } = await world(undefined, (service) => ({
      pin: async (request, context) => (lent ? { ok: true, value: lent } : service.pin(request, context)),
    }))
    const other = owner('action-1', 'session-2')
    const upload = await sealedUpload(blob, 'upload-1', text('report'))
    ok(await artifacts.reserve({ request: reserveRequest('pub-a'), owner: owner() }, ctx()))
    const first = ok(
      await artifacts.publish({ request: publishRequest('pub-a', upload), owner: owner() }, ctx()),
    )
    const taken = first.blob as Wire.BlobRef
    const second = ok(await artifacts.reserve({ request: reserveRequest('pub-b'), owner: other }, ctx()))
    const publish = (source: unknown) =>
      artifacts.publish({ request: publishRequest('pub-b', upload, { source }), owner: other }, ctx())
    expect(refused(await publish({ kind: 'blob', blob: taken }))).toBe('operation_not_supported')
    lent = taken
    expect(refused(await publish({ kind: 'upload', upload }))).toBe('integrity')
    lent = undefined
    const ready = ok(await publish({ kind: 'upload', upload }))
    expect(ready).toMatchObject({ state: 'ready', revision: 3 })
    expect(ready.pinId).not.toBe(taken.pinId)
    expect(artifacts.pendingEvents().map((event) => event.eventKey)).toEqual(['pub-a:ready', 'pub-b:ready'])

    // Releasing the first owner's pin ends its reads; the other version reads through its own pin.
    const refA = { artifactId: first.artifactId, version: 1 }
    const refB = { artifactId: second.artifactId, version: 1 }
    await readGrant(artifacts, refA)
    await readGrant(artifacts, refB, 'grant-b', 'user-1', other)
    ok(await blob.unpin({ pinId: taken.pinId, expectedRevision: 1 }, ctx()))
    const read = (ref: Wire.ArtifactRef) =>
      artifacts.artifactAccess.readRange({ ...ref, offset: 0, length: 6 }, ctx())
    expect(refused(await read(refA))).toBe('revoked')
    expect(ok(await read(refB)).bytes).toEqual(text('report'))
  })

  it('fails only from a committed failed or cancelled receipt of the owner action and never reverts', async () => {
    const { artifacts, blob } = await world()
    ok(await artifacts.reserve({ request: reserveRequest('pub-1'), owner: owner() }, ctx()))
    const failureRef = { authorityId: 'state-1', receiptId: 'receipt-1', digest: 'a'.repeat(64) }
    const failWith = (receipt: Wire.ReceiptRef, publicationId = 'pub-1', ref = failureRef) =>
      artifacts.fail(
        { request: { publicationId, expectedRevision: 1, failureRef: ref }, owner: owner(), receipt },
        ctx(),
      )
    const receipt = (
      outcome: Wire.ReceiptRef['outcome'],
      actionId = 'action-1',
      receiptId = 'receipt-1',
    ) => ({
      actionId,
      receiptId,
      outcome,
    })
    expect(refused(await failWith(receipt('succeeded')))).toBe('invalid_request')
    expect(refused(await failWith(receipt('unknown_effect')))).toBe('invalid_request')
    expect(refused(await failWith(receipt('failed', 'action-2')))).toBe('permission_denied')
    expect(refused(await failWith(receipt('failed', 'action-1', 'receipt-2')))).toBe('permission_denied')
    const failed = ok(await failWith(receipt('cancelled')))
    expect(failed).toMatchObject({ state: 'failed', revision: 2, failureRef })
    expect(ok(await failWith(receipt('cancelled')))).toEqual(failed)
    expect(
      refused(
        await failWith(receipt('failed', 'action-1', 'receipt-3'), 'pub-1', {
          ...failureRef,
          receiptId: 'receipt-3',
        }),
      ),
    ).toBe('idempotency_conflict')

    ok(await artifacts.reserve({ request: reserveRequest('pub-2'), owner: owner() }, ctx()))
    const upload = await sealedUpload(blob, 'upload-1', text('report'))
    ok(await artifacts.publish({ request: publishRequest('pub-2', upload), owner: owner() }, ctx()))
    expect(refused(await failWith(receipt('failed'), 'pub-2'))).toBe('revision_conflict')
  })

  it('keeps grants idempotent per request id and revokes one exact version', async () => {
    const { artifacts, blob, dataDir } = await world()
    const v1 = ok(await artifacts.reserve({ request: reserveRequest('pub-1'), owner: owner() }, ctx()))
    ok(
      await artifacts.publish(
        { request: publishRequest('pub-1', await sealedUpload(blob, 'u1', text('one'))), owner: owner() },
        ctx(),
      ),
    )
    ok(
      await artifacts.reserve(
        {
          request: reserveRequest('pub-2', { artifactId: v1.artifactId, expectedLatestVersion: 1 }),
          owner: owner(),
        },
        ctx(),
      ),
    )
    ok(
      await artifacts.publish(
        { request: publishRequest('pub-2', await sealedUpload(blob, 'u2', text('two'))), owner: owner() },
        ctx(),
      ),
    )
    const ref1 = { artifactId: v1.artifactId, version: 1 }
    const ref2 = { artifactId: v1.artifactId, version: 2 }
    const grant1 = await readGrant(artifacts, ref1)
    expect(grant1).toMatchObject({ revision: 1, status: 'active', sourceAuthorizationRef: 'policy-1' })
    expect(await readGrant(artifacts, ref1)).toEqual(grant1)
    expect(
      refused(
        await artifacts.grant(
          {
            request: {
              requestId: 'grant-1',
              artifactRef: ref2,
              granteePrincipalRef: 'user-1',
              scope: scope(),
              permissions: ['read'],
              expiresAt: null,
            },
            owner: owner(),
            sourceAuthorizationRef: 'policy-1',
          },
          ctx(),
        ),
      ),
    ).toBe('idempotency_conflict')
    const wide = { kind: 'runtime' as const, installationId: 'install-1', runtimeId: 'runtime-1' }
    const grantInput = (requestId: string, over: Record<string, unknown> = {}, actor = owner()) => ({
      request: {
        requestId,
        artifactRef: ref2,
        granteePrincipalRef: 'user-1',
        scope: scope(),
        permissions: ['read'],
        expiresAt: null,
        ...over,
      },
      owner: actor,
      sourceAuthorizationRef: 'policy-1',
    })
    expect(refused(await artifacts.grant(grantInput('grant-2', { scope: wide }), ctx()))).toBe(
      'permission_denied',
    )
    expect(
      refused(await artifacts.grant(grantInput('grant-3', {}, owner('action-1', 'session-2')), ctx())),
    ).toBe('permission_denied')
    await readGrant(artifacts, ref2, 'grant-4')

    const revokeGrant = (requestId: string, expectedRevision: number) =>
      artifacts.revokeGrant(
        { request: { requestId, grantId: grant1.grantId, expectedRevision, reason: 'done' }, owner: owner() },
        ctx(),
      )
    const revokedGrant = ok(await revokeGrant('revoke-1', 1))
    expect(revokedGrant).toMatchObject({ status: 'revoked', revision: 2 })
    expect(ok(await revokeGrant('revoke-1', 1))).toEqual(revokedGrant)
    expect(refused(await revokeGrant('revoke-2', 1))).toBe('revision_conflict')
    expect(refused(await artifacts.artifactAccess.describe(ref1, ctx()))).toBe('permission_denied')

    const revoked = ok(await artifacts.revoke({ artifactRef: ref2, reason: 'withdrawn' }, ctx()))
    expect(revoked).toMatchObject({ state: 'revoked', version: 2 })
    expect(ok(await artifacts.revoke({ artifactRef: ref2, reason: 'withdrawn' }, ctx()))).toEqual(revoked)
    expect(artifacts.pendingEvents().map((event) => event.eventKey)).toEqual([
      'pub-1:ready',
      'pub-2:ready',
      'pub-2:revoked',
    ])
    expect(ok(await artifacts.artifactAccess.describe(ref2, ctx())).status).toBe('revoked')
    const read2 = { ...ref2, offset: 0, length: 3 }
    expect(refused(await artifacts.artifactAccess.readRange(read2, ctx()))).toBe('revoked')
    await readGrant(artifacts, ref1, 'grant-5')
    expect(
      ok(await artifacts.artifactAccess.readRange({ ...ref1, offset: 0, length: 3 }, ctx())).bytes,
    ).toEqual(text('one'))
    // Each revocation is logged once in its own transaction, and outbox events take increasing seqs.
    expect(stored(dataDir, 'SELECT kind, ref, request_id FROM revocations ORDER BY seq')).toEqual([
      { kind: 'revokeGrant', ref: grant1.grantId, request_id: 'revoke-1' },
      { kind: 'revoke', ref: JSON.stringify(ref2), request_id: null },
    ])
    expect(stored(dataDir, 'SELECT seq, event_key FROM outbox ORDER BY seq')).toEqual([
      { seq: 1, event_key: 'pub-1:ready' },
      { seq: 2, event_key: 'pub-2:ready' },
      { seq: 3, event_key: 'pub-2:revoked' },
    ])
  })

  it('fences publication writes and reports the outbox head and revocation watermark with the fence', async () => {
    const maintenance: TransferMaintenance = {
      authorize: (context) => context.authorizationRef === 'maintenance',
      tenantId: 'tenant-1',
      locationRef: 'location-1',
      readRoute: async () => ({
        ok: false,
        error: {
          code: 'invalid_input',
          detailCode: 'not_found',
          message: 'no published route',
          retryAdvice: { kind: 'never' },
          diagnosticId: 'test',
        },
      }),
      sourceBlobs: { openRead: () => Promise.reject(new Error('this store never imports')) },
      planFingerprint: () => Promise.reject(new Error('this store never verifies')),
    }
    const { artifacts, blob, dataDir } = await world(undefined, undefined, { maintenance: () => maintenance })
    const reserved = ok(await artifacts.reserve({ request: reserveRequest('pub-1'), owner: owner() }, ctx()))
    const upload = await sealedUpload(blob, 'u1', text('one'))
    ok(await artifacts.publish({ request: publishRequest('pub-1', upload), owner: owner() }, ctx()))
    const ref = { artifactId: reserved.artifactId, version: 1 }
    await readGrant(artifacts, ref)
    const other = await readGrant(artifacts, ref, 'grant-2')
    const revokeGrant = (requestId: string) =>
      artifacts.revokeGrant(
        {
          request: { requestId, grantId: other.grantId, expectedRevision: 1, reason: 'done' },
          owner: owner(),
        },
        ctx(),
      )
    ok(await revokeGrant('revoke-1'))
    const maintainer = ctx({ authorizationRef: 'maintenance' })
    const expected = { authorityId: 'artifacts-authority', tenantId: 'tenant-1', authorityEpoch: 1 }
    const fence = ok(
      await artifacts.transfer.fence(
        { upgradeId: 'upgrade-1', expected, cohortDigest: 'c'.repeat(64) },
        maintainer,
      ),
    )
    expect(fence).toMatchObject({
      source: expected,
      fenceEpoch: 1,
      writerCredentialsRevoked: true,
      checkpoint: { bridgeWatermarks: [{ bridgeId: 'outbox', producedThrough: 1, acceptedThrough: 0 }] },
    })
    expect(stored(dataDir, 'SELECT watermark FROM maintenance_transfers')).toEqual([{ watermark: 1 }])

    expect(
      refused(await artifacts.reserve({ request: reserveRequest('pub-2'), owner: owner() }, ctx())),
    ).toBe('blocked')
    expect(refused(await artifacts.revoke({ artifactRef: ref, reason: 'withdrawn' }, ctx()))).toBe('blocked')
    expect(refused(await revokeGrant('revoke-2'))).toBe('blocked')
    expect(ok(await artifacts.artifactAccess.describe(ref, ctx())).status).toBe('ready')
    expect(
      ok(await artifacts.artifactAccess.readRange({ ...ref, offset: 0, length: 3 }, ctx())).bytes,
    ).toEqual(text('one'))
    expect(ok(await artifacts.transfer.probe({ upgradeId: 'upgrade-1' }, maintainer))).toEqual({
      state: 'fenced',
      fence,
    })
  })
})

const ARTIFACTS_BINDING = {
  bindingId: 'artifacts-1',
  contract: 'agh.artifacts',
  logicalName: 'default',
  providerId: 'agh.artifacts.default',
}
const MAINTAINER = ctx({ authorizationRef: 'maintenance' })
const UPGRADE = 'upgrade-1'
const COHORT = 'c'.repeat(64)
type Routes = Map<string, { route: Wire.AuthorityRoute; targetActivated: boolean }>
type Lender = Pick<BlobReadPort, 'openRead'>

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

/** One location's view of the maintenance directory, reading the source's bytes through `sourceBlobs`. */
function transferFixture(
  routes: Routes,
  locationRef: string,
  sourceBlobs: Lender,
  maintainer = 'maintenance',
): TransferMaintenance {
  return {
    authorize: (context) => context.authorizationRef === maintainer,
    tenantId: 'tenant-1',
    locationRef,
    readRoute: async ({ logicalAuthorityId }) => {
      const held = routes.get(logicalAuthorityId)
      return held ? { ok: true, value: held } : unavailable('not_found', 'no published route')
    },
    sourceBlobs,
    planFingerprint: async () => ({ ok: true, value: 'f'.repeat(64) }),
  }
}

async function fenceAndExport(transfer: AuthorityTransferControl, authorityId: string, context = MAINTAINER) {
  const expected = { authorityId, tenantId: 'tenant-1', authorityEpoch: 1 }
  const fence = ok(await transfer.fence({ upgradeId: UPGRADE, expected, cohortDigest: COHORT }, context))
  return {
    fence,
    exported: ok(await transfer.export({ upgradeId: UPGRADE, fenceId: fence.fenceId }, context)),
  }
}

/**
 * A ready artifact user-1 reads while user-2's grant to it was revoked, and a revoked version user-1
 * holds a grant to; the two ready events and the revoked event stay pending in the outbox.
 */
async function seedTransfer({ artifacts, blob }: World) {
  const publishOne = async (id: string, bytes: Uint8Array) => {
    const reserved = ok(await artifacts.reserve({ request: reserveRequest(id), owner: owner() }, ctx()))
    const upload = await sealedUpload(blob, `upload-${id}`, bytes)
    ok(await artifacts.publish({ request: publishRequest(id, upload), owner: owner() }, ctx()))
    return { artifactId: reserved.artifactId, version: reserved.version }
  }
  const live = await publishOne('pub-live', text('live artifact'))
  await readGrant(artifacts, live, 'grant-live')
  const withdrawn = await readGrant(artifacts, live, 'grant-withdrawn', 'user-2')
  const request = { requestId: 'revoke-1', grantId: withdrawn.grantId, expectedRevision: 1, reason: 'done' }
  const revocation = { request, grant: ok(await artifacts.revokeGrant({ request, owner: owner() }, ctx())) }
  const revoked = await publishOne('pub-revoked', text('revoked artifact'))
  await readGrant(artifacts, revoked, 'grant-revoked')
  ok(await artifacts.revoke({ artifactRef: revoked, reason: 'withdrawn' }, ctx()))
  return { live, revoked, revocation }
}

/** Whether the service serves what `seedTransfer` left: the live bytes, but not the revoked grant or version. */
async function servesSeed(artifacts: ArtifactsService, seeded: Awaited<ReturnType<typeof seedTransfer>>) {
  const bytes = text('live artifact')
  const read = await artifacts.artifactAccess.readRange(
    { ...seeded.live, offset: 0, length: bytes.byteLength },
    ctx(),
  )
  const withdrawn = await artifacts.artifactAccess.describe(seeded.live, ctx({ principalRef: 'user-2' }))
  const revoked = await artifacts.artifactAccess.readRange({ ...seeded.revoked, offset: 0, length: 1 }, ctx())
  return (
    read.ok &&
    Buffer.from(read.value.bytes).equals(bytes) &&
    !withdrawn.ok &&
    withdrawn.error.detailCode === 'permission_denied' &&
    !revoked.ok &&
    revoked.error.detailCode === 'revoked'
  )
}

describe('default artifacts authority transfer', () => {
  it('moves with its blob service as a cohort, and the target serves the artifact through the target blob', async () => {
    const routes: Routes = new Map()
    const lender: Lender = {
      openRead: (request, context) => source.blob.transferRead.openRead(request, context),
    }
    const source = await world(undefined, undefined, {
      maintenance: () => transferFixture(routes, 'location-1', lender),
    })
    const seeded = await seedTransfer(source)
    const pending = source.artifacts.pendingEvents()
    expect(pending.map(({ eventKey, kind }) => [eventKey, kind])).toEqual([
      ['pub-live:ready', 'ready'],
      ['pub-revoked:ready', 'ready'],
      ['pub-revoked:revoked', 'revoked'],
    ])
    // Both stores of the cohort are fenced and exported; the artifacts export lives in the blob store.
    const blobSide = await fenceAndExport(source.blob.transfer, 'blob-authority')
    const artifactsSide = await fenceAndExport(source.artifacts.transfer, 'artifacts-authority')
    expect(
      refused(await source.artifacts.reserve({ request: reserveRequest('pub-next'), owner: owner() }, ctx())),
    ).toBe('blocked')

    const target = await world(undefined, undefined, {
      maintenance: () => transferFixture(routes, 'location-2', lender),
      target: true,
    })
    const steps = [
      { ...blobSide, binding: BLOB_BINDING, origin: source.blob, transfer: target.blob.transfer },
      {
        ...artifactsSide,
        binding: ARTIFACTS_BINDING,
        origin: source.artifacts,
        transfer: target.artifacts.transfer,
      },
    ]
    expect(
      refused(await target.artifacts.reserve({ request: reserveRequest('pub-next'), owner: owner() }, ctx())),
    ).toBe('blocked')
    // The blob service imports first, so the artifacts' content is there when their import is verified.
    const imported = []
    for (const step of steps) {
      const request = { upgradeId: UPGRADE, source: step.exported, targetLocationRef: 'location-2' }
      imported.push({ step, result: ok(await step.transfer.import(request, MAINTAINER)) })
    }
    for (const { step, result } of imported) {
      const request = { upgradeId: UPGRADE, source: step.exported, candidateRef: result.candidateRef }
      const validation = ok(await step.transfer.verify(request, MAINTAINER))
      expect(validation.checks.map(({ checkId, passed }) => [checkId, passed])).toEqual([
        ['snapshot-digest', true],
        ['record-count', true],
        ['required-assets', true],
        ['deletion-watermark', true],
      ])
      // Each store requires both artifacts' content: the artifacts store names it, the blob store holds it.
      const assets = validation.checks.find(({ checkId }) => checkId === 'required-assets')
      expect(assets?.evidence).toMatchObject({ value: { expected: 2, actual: 2 } })
    }
    for (const { step, result } of imported) {
      // The published route serves the candidate: its checkpoint is the import's, at the route's epoch.
      const route: Wire.AuthorityRoute = {
        logicalAuthorityId: step.fence.source.authorityId,
        tenantId: 'tenant-1',
        authorityEpoch: 2,
        providerBinding: step.binding,
        locationRef: 'location-2',
        cohortDigest: COHORT,
        cutoverId: 'cutover-1',
        checkpoint: { ...result.targetCheckpoint, authorityEpoch: 2 },
        previous: { authorityEpoch: 1, locationRef: 'location-1', cutoverId: 'cutover-0' },
      }
      routes.set(route.logicalAuthorityId, { route, targetActivated: false })
      const publishedRoute = inlineData(route as unknown as JsonValue, 'agh.test/authority-route@1')
      const activated = ok(
        await step.transfer.activate(
          { upgradeId: UPGRADE, cutoverId: 'cutover-1', publishedRoute },
          MAINTAINER,
        ),
      )
      expect(activated).toEqual({
        state: 'activated',
        cutoverId: 'cutover-1',
        authority: { ...step.fence.source, authorityEpoch: 2 },
        checkpoint: route.checkpoint,
      })
      expect(ok(await step.transfer.probe({ upgradeId: UPGRADE }, MAINTAINER))).toEqual(activated)
      expect(ok(await step.origin.transfer.probe({ upgradeId: UPGRADE }, MAINTAINER))).toEqual({
        state: 'fenced',
        fence: step.fence,
      })
    }

    // With the source closed, the target reads through its own blob service, keeps the revoked grant
    // and version, and still holds the pending events under their original keys.
    source.artifacts.close()
    source.blob.close()
    expect(ok(await target.artifacts.artifactAccess.describe(seeded.live, ctx())).status).toBe('ready')
    expect(await servesSeed(target.artifacts, seeded)).toBe(true)
    expect(target.reads.count).toBeGreaterThan(0)
    expect(target.artifacts.pendingEvents()).toEqual(pending)
    // Replaying the source's revocation by its request id returns the revoked grant instead of refusing.
    const { request, grant } = seeded.revocation
    expect(ok(await target.artifacts.revokeGrant({ request, owner: owner() }, ctx()))).toEqual(grant)
    ok(await target.artifacts.reserve({ request: reserveRequest('pub-next'), owner: owner() }, ctx()))
  })
})

describe('default artifacts authority transfer refusals', () => {
  it("keeps the blob service's own refusal when its transfer entry refuses the export", async () => {
    const source = await world(undefined, undefined, {
      maintenance: () =>
        transferFixture(new Map(), 'location-1', {
          openRead: async () => unavailable('not_found', 'no source lends its bytes'),
        }),
    })
    const expected = { authorityId: 'artifacts-authority', tenantId: 'tenant-1', authorityEpoch: 1 }
    const fence = ok(
      await source.artifacts.transfer.fence(
        { upgradeId: UPGRADE, expected, cohortDigest: COHORT },
        MAINTAINER,
      ),
    )
    source.blob.close()
    expect(
      refused(
        await source.artifacts.transfer.export({ upgradeId: UPGRADE, fenceId: fence.fenceId }, MAINTAINER),
      ),
    ).toBe('blocked')
  })
})

describe('default artifacts assembly', () => {
  it('reads bytes through the blob service the container selected, and nothing after close', async () => {
    const { artifacts, blob, reads } = await world()
    const reserved = ok(await artifacts.reserve({ request: reserveRequest('pub-1'), owner: owner() }, ctx()))
    ok(
      await artifacts.publish(
        { request: publishRequest('pub-1', await sealedUpload(blob, 'u1', text('bytes'))), owner: owner() },
        ctx(),
      ),
    )
    const ref = { artifactId: reserved.artifactId, version: 1 }
    await readGrant(artifacts, ref)
    expect(
      ok(await artifacts.artifactAccess.readRange({ ...ref, offset: 1, length: 3 }, ctx())).bytes,
    ).toEqual(text('yte'))
    const stream = ok(await artifacts.artifactAccess.openStream(ref, ctx()))
    for await (const _ of stream.chunks);
    expect((await stream.ended).ok).toBe(true)
    expect(reads.count).toBe(2)

    // Close is idempotent; afterwards every call is refused with one stable code and reads no bytes.
    artifacts.close()
    artifacts.close()
    expect(refused(await artifacts.artifactAccess.describe(ref, ctx()))).toBe('blocked')
    expect(refused(await artifacts.artifactAccess.readRange({ ...ref, offset: 0, length: 1 }, ctx()))).toBe(
      'blocked',
    )
    expect(refused(await artifacts.artifactAccess.openStream(ref, ctx()))).toBe('blocked')
    expect(
      refused(await artifacts.reserve({ request: reserveRequest('pub-2'), owner: owner() }, ctx())),
    ).toBe('blocked')
    expect(reads.count).toBe(2)
  })

  it('refuses a selection without the read feature or port, or action methods or a transfer entry from another binding', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agh-artifacts-'))
    dirs.push(dataDir)
    const blob = createBlobService({ dataDir, authorityId: 'blob-authority', binding: BLOB_BINDING })
    closers.push(() => blob.close())
    const assemble = (
      register: (container: ReturnType<typeof createTestServiceContainer>) => void,
      actions = blob,
      blobTransfer = blob,
    ) => {
      const container = createTestServiceContainer()
      register(container)
      return createArtifactsService({
        dataDir,
        authorityId: 'artifacts-authority',
        dependencies: container.dependencies,
        blobActions: actions,
        blobTransfer,
      })
    }
    expect(refused(assemble(() => undefined))).toBe('service_not_registered')
    expect(
      refused(
        assemble((container) =>
          container.register({
            requirement: { ...BLOB_REQUIREMENT, features: [] },
            binding: BLOB_BINDING,
            blobRead: blob.blobRead,
          }),
        ),
      ),
    ).toBe('feature_missing')
    expect(
      refused(
        assemble((container) => container.register({ requirement: BLOB_REQUIREMENT, binding: BLOB_BINDING })),
      ),
    ).toBe('operation_not_supported')
    const other = { ...blob, binding: { ...BLOB_BINDING, bindingId: 'blob-2' } }
    const selected = (container: ReturnType<typeof createTestServiceContainer>) =>
      container.register({ requirement: BLOB_REQUIREMENT, binding: BLOB_BINDING, blobRead: blob.blobRead })
    expect(refused(assemble(selected, other))).toBe('blocked')
    expect(refused(assemble(selected, blob, other))).toBe('blocked')
    expect([...BLOB_FEATURES]).toEqual(BLOB_REQUIREMENT.features)
    // A transfer needs both the maintenance assembly and the default blob service's transfer entry.
    const maintenance = transferFixture(new Map(), 'location-1', blob.transferRead)
    const base = ['artifact-publication.v1', 'artifact-access.v1']
    expect(artifactsFeatures({ ticketKeys: await ticketKeys() })).toEqual([...base, 'artifact-ticket.v1'])
    expect(artifactsFeatures({})).toEqual(base)
    expect(artifactsFeatures({ maintenance })).toEqual(base)
    expect(artifactsFeatures({ blobTransfer: blob })).toEqual(base)
    expect(artifactsFeatures({ maintenance, blobTransfer: blob })).toEqual([...base, 'authority-transfer.v1'])
  })

  it('describes the service with the ticket feature only with a ticket key broker, and transfers only with the blob transfer entry', async () => {
    const binding = ARTIFACTS_BINDING
    const configSchema = { typeId: 'agh.test/config@1', revision: 1, digest: 'c'.repeat(64) }
    const input = { binding, packageVersion: '1.0.0', packageDigest: 'a'.repeat(64), configSchema }
    const keyed = artifactsProviderDescriptor({ ...input, ticketKeys: await ticketKeys() })
    const plain = artifactsProviderDescriptor(input)
    const maintenance = transferFixture(new Map(), 'location-1', {
      openRead: async () => unavailable('not_found', 'no source lends its bytes'),
    })
    const blobTransfer: BlobTransfer = {
      binding: BLOB_BINDING,
      transferStorage: () => {
        throw new Error('a descriptor never writes')
      },
      holds: async () => false,
    }
    const unported = artifactsProviderDescriptor({ ...input, maintenance })
    const transfer = artifactsProviderDescriptor({ ...input, maintenance, blobTransfer })
    const catalog: Record<string, { kind?: string; local?: boolean }> =
      RuntimeServiceCatalog['agh.artifacts'].methods
    const refs: Record<string, unknown> = RuntimeMethodSchemaRefs['agh.artifacts']
    for (const descriptor of [keyed, plain, unported, transfer]) {
      expect(validateRuntime('ProviderDescriptor', descriptor).ok).toBe(true)
      expect(descriptor).toMatchObject({
        providerId: binding.providerId,
        contract: 'agh.artifacts',
        major: 1,
      })
      expect(descriptor.requires).toEqual([BLOB_REQUIREMENT])
      for (const { method, kind, inputSchema, outputSchema } of descriptor.operations) {
        expect(kind).toBe(catalog[method]?.kind)
        expect({ input: inputSchema, output: outputSchema }).toEqual(refs[method])
      }
    }
    expect(keyed.features).toEqual([...plain.features, 'artifact-ticket.v1'])
    // The only ticket method, redeemDownload, is a local port method and never a remote operation.
    expect(keyed.operations).toEqual(plain.operations)
    expect(plain.operations.map(({ method, retrySafety }) => [method, retrySafety])).toEqual([
      ['reserve', 'idempotent'],
      ['publish', 'idempotent'],
      ['revoke', 'idempotent'],
      ['query', 'read-only'],
      ['fail', 'idempotent'],
      ['grant', 'idempotent'],
      ['revokeGrant', 'idempotent'],
    ])
    expect(unported).toEqual(plain)
    expect(transfer.features).toEqual([...plain.features, 'authority-transfer.v1'])
    expect(transfer.operations.map(({ method, retrySafety }) => [method, retrySafety])).toEqual([
      ...plain.operations.map(({ method, retrySafety }) => [method, retrySafety]),
      ['authorityFence', 'idempotent'],
      ['authorityExport', 'idempotent'],
      ['authorityExportPage', 'idempotent'],
      ['authorityImport', 'idempotent'],
      ['authorityVerify', 'idempotent'],
      ['authorityActivate', 'idempotent'],
      ['authorityAbort', 'idempotent'],
      ['authorityProbe', 'read-only'],
    ])
    expect(() =>
      artifactsProviderDescriptor({ ...input, binding: { ...binding, contract: 'agh.blob' } }),
    ).toThrow()
  })
})

/**
 * The shared suite and the reference blob provider live outside this package's build, so they are
 * loaded by URL, as the conformance runner loads binders. Only the parts used here are typed.
 */
type ArtifactsSuite = {
  ARTIFACT_READER: { principalRef: string; authorizationRef: string; scope: ScopeRef }
  artifactsContractPort(subject: object): unknown
  registerArtifactsContract(harness: ConformanceHarness, binding: object): void
}
type TransferSuite = {
  TRANSFER_MAINTAINER: string
  transferContractPort(subject: object): unknown
  registerAuthorityTransferContract(harness: ConformanceHarness, contract: string, binding: object): void
}
type ReferenceBlob = {
  BLOB_PROVIDER: { id: string }
  openBlobStore(
    path: string,
    options: { authorizeRead(context: CallContext): boolean },
  ): Omit<SelectedBlobActions, 'binding'> & {
    blobRead: BlobReadPort
    upload(bytes: Uint8Array, mediaType: string, principal: string): Wire.UploadRef
    close(): void
  }
}

/** One blob service under the default artifacts service: its selected binding, ports and upload entry. */
type BlobSide = {
  binding: Wire.BindingRef
  blobRead: BlobReadPort
  actions: SelectedBlobActions
  upload(bytes: Uint8Array, id: string): Promise<Wire.UploadRef>
  close(): void
}
type OpenBlob = (dataDir: string, readable: (context: CallContext) => boolean) => BlobSide

const BUILD: BuildIdentity = {
  codeSha: 'host-test',
  buildDigest: 'host-test-build',
  lockDigest: 'host-test-lock',
  specVersion: 'host-test-spec',
  sdkVersion: 'host-test-sdk',
  sdkDigest: 'host-test-sdk-digest',
  platform: 'host-test-platform',
}
const MEDIA_TYPE = 'application/octet-stream'
const fileDigest = (path: string) =>
  createHash('sha256')
    .update(readFileSync(new URL(path, import.meta.url)))
    .digest('hex')

/**
 * Runs the shared artifacts suite, and the authority transfer suite when asked, against the default
 * artifacts service, assembled through a test service container over the blob service `openBlob` opens,
 * and returns each case's id and status.
 */
async function artifactsConformance(providerId: string, openBlob: OpenBlob, transfer = false) {
  const suite = (await import(
    new URL('../../../extension-api/testkit/runtime/contracts/artifacts.ts', import.meta.url).href
  )) as ArtifactsSuite
  const reader = suite.ARTIFACT_READER
  const dataDir = await mkdtemp(join(tmpdir(), 'agh-artifacts-'))
  dirs.push(dataDir)
  const readable = (context: CallContext) => context.authorizationRef === reader.authorizationRef
  let clock = Date.parse('2026-10-01T00:00:00.000Z')
  let reads = 0
  const keys = await ticketKeys(() => clock)
  const assemble = () => {
    const blob = openBlob(dataDir, readable)
    const counted: BlobReadPort = {
      readRange: (request, context) => {
        reads += 1
        return blob.blobRead.readRange(request, context)
      },
      openRead: (request, context) => {
        reads += 1
        return blob.blobRead.openRead(request, context)
      },
    }
    const container = createTestServiceContainer()
    container.register({ requirement: BLOB_REQUIREMENT, binding: blob.binding, blobRead: counted })
    const artifacts = ok(
      createArtifactsService({
        dataDir,
        authorityId: 'artifacts-authority',
        dependencies: container.dependencies,
        blobActions: blob.actions,
        authorize: readable,
        ticketKeys: keys,
        now: () => clock,
      }),
    )
    return { blob, artifacts, live: true }
  }
  let world = assemble()
  const shut = () => {
    if (!world.live) return
    world.artifacts.close()
    world.blob.close()
    world.live = false
  }
  const writer = ctx({ scope: reader.scope })
  const latest = new Map<string, number>()
  const grants = new Map<string, Wire.ArtifactAccessGrantValue>()
  const key = (ref: Wire.ArtifactRef) => `${ref.artifactId}@${ref.version}`
  let published = 0
  const binding: TestServiceBinding = {
    requirement: {
      contract: 'agh.artifacts',
      major: 1,
      logicalName: 'conformance',
      features: ['artifact-access.v1'],
      scope: 'runtime',
      optional: false,
    },
    binding: {
      bindingId: `artifacts-${providerId}`,
      contract: 'agh.artifacts',
      logicalName: 'conformance',
      providerId,
    },
    artifactAccess: world.artifacts.artifactAccess,
  }
  const port = suite.artifactsContractPort({
    binding,
    access: (): ArtifactAccessPort => world.artifacts.artifactAccess,
    async publish(bytes: Uint8Array, artifactId?: string): Promise<Wire.ArtifactRef> {
      published += 1
      const id = `conformance-${published}`
      const prior =
        artifactId === undefined ? {} : { artifactId, expectedLatestVersion: latest.get(artifactId) }
      const reserved = ok(
        await world.artifacts.reserve({ request: reserveRequest(id, prior), owner: owner() }, writer),
      )
      const upload = await world.blob.upload(bytes, id)
      const request = publishRequest(id, upload, { mediaType: MEDIA_TYPE })
      ok(await world.artifacts.publish({ request, owner: owner() }, writer))
      const ref = { artifactId: reserved.artifactId, version: reserved.version }
      latest.set(ref.artifactId, ref.version)
      const grant = ok(
        await world.artifacts.grant(
          {
            request: {
              requestId: `grant-${id}`,
              artifactRef: ref,
              granteePrincipalRef: reader.principalRef,
              scope: reader.scope,
              permissions: ['read', 'download'],
              expiresAt: null,
            },
            owner: owner(),
            sourceAuthorizationRef: 'policy-1',
          },
          writer,
        ),
      )
      grants.set(key(ref), grant)
      return ref
    },
    async revoke(ref: Wire.ArtifactRef) {
      ok(await world.artifacts.revoke({ artifactRef: ref, reason: 'conformance' }, writer))
    },
    async revokeGrant(ref: Wire.ArtifactRef) {
      const grant = grants.get(key(ref))
      if (!grant) throw new Error('no grant was recorded for this version')
      const request = {
        requestId: `revoke-${grant.grantId}`,
        grantId: grant.grantId,
        expectedRevision: grant.revision,
        reason: 'conformance',
      }
      ok(await world.artifacts.revokeGrant({ request, owner: owner() }, writer))
    },
    now: () => clock,
    advance(ms: number) {
      clock += ms
    },
    blobReads: () => reads,
    async reopen() {
      shut()
      world = assemble()
    },
    close: async () => shut(),
    remains: () => existsSync(join(dataDir, 'artifacts', 'artifacts-service.db')),
    locations: [dataDir, realpathSync(dataDir)],
    ticketTtlMs: null,
  })
  const harness = createConformanceHarness()
  const registered = {
    providerId,
    recipe: 'packages/host/src/runtime/providers/artifacts.ts',
    command: 'host-artifacts-conformance',
    build: BUILD,
    providerDigest: fileDigest('../../src/runtime/providers/artifacts.ts'),
    configDigest: canonicalJsonDigest({ authorityId: 'artifacts-authority' }),
    releaseSetDigest: fileDigest('../../package.json'),
  }
  suite.registerArtifactsContract(harness, { ...registered, port })
  if (transfer) {
    const transfers = (await import(
      new URL('../../../extension-api/testkit/runtime/contracts/authority-transfer.ts', import.meta.url).href
    )) as TransferSuite
    transfers.registerAuthorityTransferContract(harness, 'agh.artifacts', {
      ...registered,
      port: transfers.transferContractPort(artifactsTransferSubject(transfers.TRANSFER_MAINTAINER)),
    })
  }
  try {
    const report = await harness.run({
      contracts: ['agh.artifacts'],
      providers: [providerId],
      command: 'host-artifacts-conformance',
      clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
    })
    return report.assertions.map((item) => [item.id, item.status])
  } finally {
    shut()
  }
}

/** Every case of the named suites passed, in registration order. */
const allPassed = (providerId: string, suites: readonly string[]) =>
  suites.flatMap((name) =>
    SCENARIOS.map((scenario) => [`agh.artifacts/${providerId}${name}/${scenario}`, 'passed']),
  )

const CONFORMANCE_ARTIFACTS = { ...ARTIFACTS_BINDING, logicalName: 'conformance', providerId: 'default' }

/**
 * Default artifacts worlds for the authority transfer suite, over the default blob service. The source
 * holds the transfer seed; when maintained, its blob service is fenced and exported as the world opens,
 * as a cohort transfer fences it beside the artifacts service. Each target location's blob service
 * imports that export before the suite drives the artifacts service over it.
 */
function artifactsTransferSubject(maintainer: string) {
  const control = ctx({ authorizationRef: maintainer })
  return {
    async open(maintained: boolean) {
      const root = await mkdtemp(join(tmpdir(), 'agh-artifacts-transfer-'))
      dirs.push(root)
      const routes: Routes = new Map()
      let cut: number | null = null
      const lend: Lender['openRead'] = (request, context) =>
        source.current().blob.transferRead.openRead(request, context)
      // Only the artifacts import reads through the cut; a target's blob service imports apart from it.
      const interrupted: Lender = {
        openRead: async (request, context) => {
          if (cut === 0) return unavailable('lender_unavailable', 'the source stopped lending')
          if (cut !== null) cut -= 1
          return lend(request, context)
        },
      }
      const fixture = (locationRef: string, authorityId: string) =>
        transferFixture(
          routes,
          locationRef,
          authorityId === 'artifacts-authority' ? interrupted : { openRead: lend },
          maintainer,
        )
      const side = async (locationRef: string, target: boolean) => {
        const dataDir = join(root, locationRef)
        mkdirSync(dataDir)
        const transfer = { maintenance: (authorityId: string) => fixture(locationRef, authorityId), target }
        const start = () => world(dataDir, undefined, maintained ? transfer : undefined)
        let current = await start()
        let writes = 0
        const close = async () => {
          current.artifacts.close()
          current.blob.close()
        }
        return {
          dataDir,
          current: () => current,
          control: () => current.artifacts.transfer,
          async write() {
            const request = reserveRequest(`${locationRef}-write-${++writes}`)
            const outcome = await current.artifacts.reserve({ request, owner: owner() }, ctx())
            return outcome.ok ? null : outcome.error.detailCode
          },
          serves: () => servesSeed(current.artifacts, seeded),
          async reopen() {
            await close()
            current = await start()
          },
          close,
        }
      }
      const source = await side('location-1', false)
      const stores = new Map([['location-1', source]])
      const seeded = await seedTransfer(source.current())
      const cohort = maintained
        ? await fenceAndExport(source.current().blob.transfer, 'blob-authority', control)
        : undefined
      const configSchema = { typeId: 'agh.test/config@1', revision: 1, digest: 'c'.repeat(64) }
      return {
        descriptor: artifactsProviderDescriptor({
          binding: CONFORMANCE_ARTIFACTS,
          packageVersion: '1.0.0',
          packageDigest: fileDigest('../../src/runtime/providers/artifacts.ts'),
          configSchema,
          ...(maintained
            ? {
                maintenance: fixture('location-1', 'artifacts-authority'),
                blobTransfer: source.current().blob,
              }
            : {}),
        }),
        source,
        authority: { authorityId: 'artifacts-authority', tenantId: 'tenant-1', authorityEpoch: 1 },
        locationRef: 'location-1',
        providerBinding: CONFORMANCE_ARTIFACTS,
        async target(locationRef: string) {
          const known = stores.get(locationRef)
          if (known) return known
          const made = await side(locationRef, true)
          if (cohort) {
            const request = { upgradeId: UPGRADE, source: cohort.exported, targetLocationRef: locationRef }
            ok(await made.current().blob.transfer.import(request, control))
          }
          stores.set(locationRef, made)
          return made
        },
        publish(route: Wire.AuthorityRoute, targetActivated: boolean) {
          routes.set(route.logicalAuthorityId, { route, targetActivated })
        },
        cut(after: number | null) {
          cut = after
        },
        // The chunk lives in the source blob's content; one hex letter changes, so it still parses.
        async tamper(chunk: Wire.BlobRef) {
          const file = join(source.dataDir, 'artifacts', 'sha256', chunk.digest.slice(0, 2), chunk.digest)
          const bytes = readFileSync(file)
          const at = bytes.findIndex((byte) => byte >= 0x61 && byte <= 0x66)
          if (at < 0) throw new Error('the chunk has no hex letter to change')
          bytes[at] = bytes[at] === 0x61 ? 0x62 : 0x61
          writeFileSync(file, bytes)
        },
        async damage(locationRef: string) {
          const db = new DatabaseSync(join(root, locationRef, 'artifacts', 'artifacts-service.db'))
          try {
            db.exec('UPDATE artifacts SET latest_version = latest_version + 1')
          } finally {
            db.close()
          }
        },
        async dispose() {
          for (const each of stores.values()) await each.close()
          await rm(root, { recursive: true, force: true })
        },
      }
    },
  }
}

describe('default artifacts service: conformance', () => {
  it('passes the shared artifacts suite and the authority transfer suite in all six scenarios over the default blob service', async () => {
    const statuses = await artifactsConformance(
      'default',
      (dataDir, readable) => {
        const blob = createBlobService({
          dataDir,
          authorityId: 'blob-authority',
          binding: BLOB_BINDING,
          authorizeRead: readable,
        })
        return {
          binding: BLOB_BINDING,
          blobRead: blob.blobRead,
          actions: blob,
          upload: (bytes, id) => sealedUpload(blob, `upload-${id}`, bytes, MEDIA_TYPE),
          close: () => blob.close(),
        }
      },
      true,
    )
    expect(statuses).toEqual(allPassed('default', ['', '/authority-transfer']))
  })

  it('passes the shared artifacts suite in all six scenarios over the reference blob service', async () => {
    const reference = (await import(
      new URL('../../../../examples/runtime-reference/src/providers/blob.ts', import.meta.url).href
    )) as ReferenceBlob
    const binding = {
      bindingId: 'reference-blob',
      contract: 'agh.blob',
      logicalName: BLOB_REQUIREMENT.logicalName,
      providerId: reference.BLOB_PROVIDER.id,
    }
    const statuses = await artifactsConformance('default-over-reference-blob', (dataDir, readable) => {
      const blob = reference.openBlobStore(join(dataDir, 'reference-blob.sqlite'), {
        authorizeRead: readable,
      })
      const { promote, pin, inspect } = blob
      return {
        binding,
        blobRead: blob.blobRead,
        actions: { binding, promote, pin, inspect },
        // Staged by the principal that publishes it.
        upload: async (bytes) => blob.upload(bytes, MEDIA_TYPE, ctx().principalRef),
        close: () => blob.close(),
      }
    })
    expect(statuses).toEqual(allPassed('default-over-reference-blob', ['']))
  })
})
