import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ArtifactAccessPort,
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
import { canonicalJsonDigest, RuntimeSchemaRefs } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ARTIFACTS_FEATURES,
  type ArtifactsService,
  BLOB_REQUIREMENT,
  createArtifactsService,
  type OwnerAction,
  type SelectedBlobActions,
} from '../../src/runtime/providers/artifacts.js'
import { BLOB_FEATURES, type BlobService, createBlobService } from '../../src/runtime/providers/blob.js'

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
const closers: (() => void)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

type World = { dataDir: string; blob: BlobService; artifacts: ArtifactsService; reads: { count: number } }

/**
 * The default artifacts service over the default blob service, each in its own database,
 * assembled through the test container.
 */
async function world(
  dataDir?: string,
  adjust: (blob: BlobService) => Partial<SelectedBlobActions> = () => ({}),
): Promise<World> {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), 'agh-artifacts-')))
  if (!dataDir) dirs.push(dir)
  const blob = createBlobService({
    dataDir: dir,
    authorityId: 'blob-authority',
    binding: BLOB_BINDING,
    authorizeRead: (context) => context.authorizationRef === 'auth-ok',
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
    }),
  )
  closers.push(() => artifacts.close())
  return { dataDir: dir, blob, artifacts, reads }
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

async function readGrant(artifacts: ArtifactsService, artifactRef: Wire.ArtifactRef, requestId = 'grant-1') {
  return ok(
    await artifacts.grant(
      {
        request: {
          requestId,
          artifactRef,
          granteePrincipalRef: 'user-1',
          scope: scope(),
          permissions: ['read', 'download'],
          expiresAt: null,
        },
        owner: owner(),
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
    const ready = ok(await attempt(publishRequest('pub-1', upload)))
    expect(ready).toMatchObject({ state: 'ready', revision: 3, title: 'Report', mediaType: 'text/plain' })
    expect(ready.pinId).toBe(ready.blob?.pinId)
    expect(refused(await attempt(publishRequest('pub-1', html, { mediaType: 'text/html' })))).toBe(
      'idempotency_conflict',
    )
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
    const { artifacts, blob } = await world()
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

  it('refuses a selection without the read feature or port, or action methods from another binding', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agh-artifacts-'))
    dirs.push(dataDir)
    const blob = createBlobService({ dataDir, authorityId: 'blob-authority', binding: BLOB_BINDING })
    closers.push(() => blob.close())
    const assemble = (
      register: (container: ReturnType<typeof createTestServiceContainer>) => void,
      actions = blob,
    ) => {
      const container = createTestServiceContainer()
      register(container)
      return createArtifactsService({
        dataDir,
        authorityId: 'artifacts-authority',
        dependencies: container.dependencies,
        blobActions: actions,
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
    expect(
      refused(
        assemble(
          (container) =>
            container.register({
              requirement: BLOB_REQUIREMENT,
              binding: BLOB_BINDING,
              blobRead: blob.blobRead,
            }),
          other,
        ),
      ),
    ).toBe('blocked')
    expect([...BLOB_FEATURES]).toEqual(BLOB_REQUIREMENT.features)
    expect(ARTIFACTS_FEATURES).toEqual([
      'artifact-publication.v1',
      'artifact-access.v1',
      'artifact-ticket.v1',
    ])
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
type ReferenceBlob = {
  BLOB_PROVIDER: { id: string }
  openBlobStore(
    path: string,
    options: { authorizeRead(context: CallContext): boolean },
  ): Omit<SelectedBlobActions, 'binding'> & {
    blobRead: BlobReadPort
    upload(bytes: Uint8Array, mediaType: string): Wire.UploadRef
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
 * Runs the shared artifacts suite against the default artifacts service, assembled through a test
 * service container over the blob service `openBlob` opens, and returns each scenario's status.
 */
async function artifactsConformance(providerId: string, openBlob: OpenBlob) {
  const suite = (await import(
    new URL('../../../extension-api/testkit/runtime/contracts/artifacts.ts', import.meta.url).href
  )) as ArtifactsSuite
  const reader = suite.ARTIFACT_READER
  const dataDir = await mkdtemp(join(tmpdir(), 'agh-artifacts-'))
  dirs.push(dataDir)
  const readable = (context: CallContext) => context.authorizationRef === reader.authorizationRef
  let clock = Date.parse('2026-10-01T00:00:00.000Z')
  let reads = 0
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
        ticketKey: { version: 'key-1', key: new Uint8Array(32).fill(7) },
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
  suite.registerArtifactsContract(harness, {
    providerId,
    recipe: 'packages/host/src/runtime/providers/artifacts.ts',
    command: 'host-artifacts-conformance',
    build: BUILD,
    providerDigest: fileDigest('../../src/runtime/providers/artifacts.ts'),
    configDigest: canonicalJsonDigest({ authorityId: 'artifacts-authority' }),
    releaseSetDigest: fileDigest('../../package.json'),
    port,
  })
  try {
    const report = await harness.run({
      contracts: ['agh.artifacts'],
      providers: [providerId],
      command: 'host-artifacts-conformance',
      clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
    })
    return report.assertions.map((item) => [item.scenario, item.status])
  } finally {
    shut()
  }
}

describe('default artifacts service: conformance', () => {
  it('passes the shared artifacts suite in all six scenarios over the default blob service', async () => {
    const statuses = await artifactsConformance('default', (dataDir, readable) => {
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
    })
    expect(statuses).toEqual(SCENARIOS.map((scenario) => [scenario, 'passed']))
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
        upload: async (bytes) => blob.upload(bytes, MEDIA_TYPE),
        close: () => blob.close(),
      }
    })
    expect(statuses).toEqual(SCENARIOS.map((scenario) => [scenario, 'passed']))
  })
})
