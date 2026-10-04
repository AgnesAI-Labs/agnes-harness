import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ArtifactAccessPort, CallContext, Outcome, ScopeRef } from '@agnes/extension-api/runtime'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import type * as Wire from '@agnes/protocol/runtime'
import {
  RuntimeArtifactPolicy,
  RuntimeClientTransportPolicy,
  RuntimeSchemaRefs,
} from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ArtifactAccessOptions,
  type ArtifactsService,
  BLOB_REQUIREMENT,
  createArtifactsService,
  type OwnerAction,
} from '../../src/runtime/providers/artifacts.js'
import { type BlobService, createBlobService } from '../../src/runtime/providers/blob.js'
import { artifactTicketKeys } from './artifact-ticket-key-fixture.js'

const START = Date.parse('2026-10-01T00:00:00.000Z')
const MIB = RuntimeClientTransportPolicy.maxRangeBytes
const BLOB_BINDING = {
  bindingId: 'blob-1',
  contract: 'agh.blob',
  logicalName: 'default',
  providerId: 'agh.blob.default',
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const CONTENT = new Uint8Array(MIB + MIB / 2).map((_, index) => (index * 7) % 256)

function scope(): ScopeRef {
  return {
    kind: 'session',
    installationId: 'install-1',
    runtimeId: 'runtime-1',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
  }
}

function ctx(over: Partial<Pick<CallContext, 'principalRef' | 'authorizationRef'>> = {}): CallContext {
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

const OWNER: OwnerAction = {
  run: {
    runId: 'run-1',
    session: {
      sessionId: 'session-1',
      authority: { authorityId: 'state-1', tenantId: 'tenant-1', authorityEpoch: 1 },
    },
  },
  actionId: 'action-1',
}

function ok<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`${outcome.error.detailCode}: ${outcome.error.message}`)
  return outcome.value
}

function refused(outcome: Outcome<unknown>): string {
  if (outcome.ok) throw new Error('expected a refusal')
  return outcome.error.detailCode
}

let clock = START
const dirs: string[] = []
const closers: (() => unknown)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  clock = START
})

type Published = {
  dataDir: string
  blob: BlobService
  artifacts: ArtifactsService
  access: ArtifactAccessPort
  ref: Wire.ArtifactRef
  grant: Wire.ArtifactAccessGrantValue
  /** A real ticket key broker, offered to the first service only when asked. */
  tickets: ReturnType<typeof artifactTicketKeys>
  /** Another service over the same stores with exactly these access options. */
  reopen(options: ArtifactAccessOptions): ArtifactAccessPort
}

/** One ready artifact of 1.5 MiB with a read and download grant for user-1. */
async function published(offerTickets = true): Promise<Published> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agh-artifact-range-'))
  dirs.push(dataDir)
  const tickets = artifactTicketKeys(join(dataDir, 'secrets'), () => clock)
  closers.push(() => tickets.broker.close())
  const blob = createBlobService({
    dataDir,
    authorityId: 'blob-authority',
    binding: BLOB_BINDING,
    now: () => clock,
    authorizeRead: (context) => context.authorizationRef === 'auth-ok',
  })
  closers.push(() => blob.close())
  const container = createTestServiceContainer()
  container.register({ requirement: BLOB_REQUIREMENT, binding: BLOB_BINDING, blobRead: blob.blobRead })
  const reopen = (extra: ArtifactAccessOptions) => {
    const service = ok(
      createArtifactsService({
        dataDir,
        authorityId: 'artifacts-authority',
        dependencies: container.dependencies,
        blobActions: blob,
        now: () => clock,
        ...extra,
      }),
    )
    closers.push(() => service.close())
    return service
  }
  const artifacts = reopen({
    authorize: (context) => context.authorizationRef === 'auth-ok',
    ...(offerTickets ? { ticketKeys: tickets.keys } : {}),
  })
  const descriptor = RuntimeSchemaRefs.ArtifactContentDescriptor
  const reserved = ok(
    await artifacts.reserve(
      {
        request: {
          publicationId: 'pub-1',
          artifactId: null,
          expectedLatestVersion: null,
          kind: descriptor.typeId,
          schema: descriptor,
          title: 'Deck',
          mediaType: 'application/octet-stream',
          ownerActionRef: { existingActionId: 'action-1' },
        },
        owner: OWNER,
      },
      ctx(),
    ),
  )
  ok(
    await blob.stage(
      {
        uploadId: 'upload-1',
        size: CONTENT.byteLength,
        mediaType: 'application/octet-stream',
        expectedDigest: sha(CONTENT),
      },
      ctx(),
    ),
  )
  const writer = ok(blob.openWriter('upload-1', ctx()))
  ok(writer.write(0, CONTENT))
  const { upload } = ok(await writer.seal())
  writer.close()
  ok(
    await artifacts.publish(
      {
        request: {
          publicationId: 'pub-1',
          source: { kind: 'upload', upload },
          expectedRevision: 1,
          title: 'Deck',
          mediaType: 'application/octet-stream',
        },
        owner: OWNER,
      },
      ctx(),
    ),
  )
  const ref = { artifactId: reserved.artifactId, version: 1 }
  const grant = ok(
    await artifacts.grant(
      {
        request: {
          requestId: 'grant-1',
          artifactRef: ref,
          granteePrincipalRef: 'user-1',
          scope: scope(),
          permissions: ['read', 'download'],
          expiresAt: null,
        },
        owner: OWNER,
        sourceAuthorizationRef: 'policy-1',
      },
      ctx(),
    ),
  )
  return {
    dataDir,
    blob,
    artifacts,
    access: artifacts.artifactAccess,
    ref,
    grant,
    tickets,
    reopen: (extra) => reopen(extra).artifactAccess,
  }
}

async function collect(stream: { chunks: AsyncIterable<Uint8Array> }): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const chunk of stream.chunks) parts.push(chunk)
  return new Uint8Array(Buffer.concat(parts))
}

const revokeGrant = (world: Published, requestId = 'revoke-1') =>
  world.artifacts.revokeGrant(
    {
      request: {
        requestId,
        grantId: world.grant.grantId,
        expectedRevision: world.grant.revision,
        reason: 'stop',
      },
      owner: OWNER,
    },
    ctx(),
  )

function ticketParts(ticket: Wire.ArtifactDownloadTicket) {
  const url = new URL(ticket.url, 'http://127.0.0.1')
  return {
    ticketId: decodeURIComponent(url.pathname.split('/').pop() ?? ''),
    nonce: url.searchParams.get('nonce') ?? '',
  }
}

/** The stored tickets' request ids and key versions, as a restarted process would find them. */
function storedTickets(world: Published) {
  const db = new DatabaseSync(join(world.dataDir, 'artifacts', 'artifacts-service.db'), { readOnly: true })
  try {
    return db.prepare('SELECT request_id, key_version FROM tickets ORDER BY request_id').all()
  } finally {
    db.close()
  }
}

describe('artifact ranges', () => {
  it('reads 1 byte to 1 MiB, refuses a start at or past the end and clamps a range crossing it', async () => {
    const world = await published()
    const read = (offset: number, length: number, context = ctx()) =>
      world.access.readRange({ ...world.ref, offset, length }, context)
    expect(sha(ok(await read(0, MIB)).bytes)).toBe(sha(CONTENT.subarray(0, MIB)))
    expect(refused(await read(0, MIB + 1))).toBe('range_bytes')
    expect(refused(await read(0, 0))).toBe('invalid_request')
    expect(refused(await read(Number.MAX_SAFE_INTEGER, 2))).toBe('invalid_request')
    expect(refused(await read(-0, 1))).toBe('invalid_request')
    expect(refused(await read(CONTENT.byteLength, 1))).toBe('range_not_satisfiable')
    const tail = ok(await read(CONTENT.byteLength - 10, 100))
    expect(tail).toEqual({
      bytes: CONTENT.subarray(CONTENT.byteLength - 10),
      offset: CONTENT.byteLength - 10,
      totalBytes: CONTENT.byteLength,
      digest: sha(CONTENT.subarray(CONTENT.byteLength - 10)),
    })
    expect(refused(await read(0, 1, ctx({ principalRef: 'user-2' })))).toBe('permission_denied')
    expect(refused(await read(0, 1, ctx({ authorizationRef: 'auth-other' })))).toBe('permission_denied')
    const unauthorized = world.reopen({ ticketKeys: world.tickets.keys })
    expect(refused(await unauthorized.readRange({ ...world.ref, offset: 0, length: 1 }, ctx()))).toBe(
      'blocked',
    )
  })

  it('ends a stream empty at the end, refuses one past it and stops at the next chunk after revocation', async () => {
    const world = await published()
    const empty = ok(await world.access.openStream({ ...world.ref, offset: CONTENT.byteLength }, ctx()))
    expect((await collect(empty)).byteLength).toBe(0)
    expect(await empty.ended).toEqual({ ok: true, value: { bytes: 0, digest: sha(new Uint8Array()) } })
    expect(
      refused(await world.access.openStream({ ...world.ref, offset: CONTENT.byteLength + 1 }, ctx())),
    ).toBe('range_not_satisfiable')

    const full = ok(await world.access.openStream(world.ref, ctx()))
    expect(sha(await collect(full))).toBe(sha(CONTENT))
    expect(await full.ended).toEqual({ ok: true, value: { bytes: CONTENT.byteLength, digest: sha(CONTENT) } })

    const live = ok(await world.access.openStream(world.ref, ctx()))
    const iterator = live.chunks[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.byteLength).toBe(MIB)
    ok(await revokeGrant(world))
    expect((await iterator.next()).done).toBe(true)
    expect(refused(await live.ended)).toBe('permission_denied')
  })
})

describe('artifact download tickets', () => {
  it('blocks both download methods without a ticket key broker and stores no ticket the broker refuses', async () => {
    const world = await published(false)
    const request = { requestId: 'download-1', input: { ...world.ref, disposition: 'attachment' as const } }
    expect(refused(await world.access.openDownload(request, ctx()))).toBe('blocked')
    const nonce = randomBytes(32).toString('base64url')
    expect(
      refused(await world.access.redeemDownload({ ticketId: 'ticket-1', nonce, offset: 0 }, ctx())),
    ).toBe('blocked')
    const brokered = world.reopen({
      authorize: (context) => context.authorizationRef === 'auth-ok',
      ticketKeys: world.tickets.keys,
    })
    world.tickets.auth.withdraw()
    expect(refused(await brokered.openDownload(request, ctx()))).toBe('ticket_delegation')
    expect(storedTickets(world)).toEqual([])
  })

  it('returns the original ticket for a repeated request id and keeps only a nonce digest', async () => {
    const world = await published()
    const request = { requestId: 'download-1', input: { ...world.ref, disposition: 'attachment' as const } }
    const ticket = ok(await world.access.openDownload(request, ctx()))
    expect(ticket).toMatchObject({
      ...world.ref,
      grantRevision: 1,
      expiresAt: new Date(START + RuntimeArtifactPolicy.downloadTicketTtlMs).toISOString(),
    })
    expect(ticket.url.startsWith('/api/runtime/artifact/download/')).toBe(true)
    clock += 1000
    expect(ok(await world.access.openDownload(request, ctx()))).toEqual(ticket)
    const racing = { ...request, requestId: 'download-2' }
    const [one, two] = await Promise.all([
      world.access.openDownload(racing, ctx()),
      world.access.openDownload(racing, ctx()),
    ])
    expect(ok(two)).toEqual(ok(one))
    const inline = { ...request, input: { ...request.input, disposition: 'inline' as const } }
    expect(refused(await world.access.openDownload(inline, ctx()))).toBe('idempotency_conflict')
    const { nonce } = ticketParts(ticket)
    for (const file of ['artifacts-service.db', 'artifacts-service.db-wal']) {
      const path = join(world.dataDir, 'artifacts', file)
      if (!existsSync(path)) continue
      for (const form of [Buffer.from(nonce), Buffer.from(nonce, 'base64url')])
        expect(readFileSync(path).includes(form)).toBe(false)
    }
    clock = START + RuntimeArtifactPolicy.downloadTicketTtlMs
    expect(refused(await world.access.openDownload(request, ctx()))).toBe('ticket_expired')
  })

  it('redeems only with the right nonce, actor, grant, version and pin, from any offset up to the end', async () => {
    const world = await published()
    const request = { requestId: 'download-1', input: { ...world.ref, disposition: 'inline' as const } }
    const ticket = ok(await world.access.openDownload(request, ctx()))
    const { ticketId, nonce } = ticketParts(ticket)
    const redeem = (
      offset: number,
      over: Partial<Wire.ArtifactRedeemDownloadRequest> = {},
      context = ctx(),
    ) => world.access.redeemDownload({ ticketId, nonce, offset, ...over }, context)

    expect(refused(await redeem(0, { nonce: randomBytes(32).toString('base64url') }))).toBe(
      'permission_denied',
    )
    expect(refused(await redeem(0, { ticketId: 'forged' }))).toBe('permission_denied')
    expect(refused(await redeem(0, {}, ctx({ principalRef: 'user-2' })))).toBe('permission_denied')
    expect(refused(await redeem(CONTENT.byteLength + 1))).toBe('range_not_satisfiable')

    const whole = ok(await redeem(0))
    expect(whole.metadata).toEqual({
      artifact: {
        ...world.ref,
        title: 'Deck',
        mime: 'application/octet-stream',
        size: CONTENT.byteLength,
        status: 'ready',
      },
      disposition: 'inline',
      expiresAt: ticket.expiresAt,
      grantRevision: 1,
    })
    expect(sha(await collect(whole.stream))).toBe(sha(CONTENT))
    const resumed = ok(await redeem(MIB))
    expect(sha(await collect(resumed.stream))).toBe(sha(CONTENT.subarray(MIB)))
    expect(await resumed.stream.ended).toEqual({
      ok: true,
      value: { bytes: MIB / 2, digest: sha(CONTENT.subarray(MIB)) },
    })
    const atEnd = ok(await redeem(CONTENT.byteLength))
    expect((await collect(atEnd.stream)).byteLength).toBe(0)
    expect((await atEnd.stream.ended).ok).toBe(true)

    clock = START + RuntimeArtifactPolicy.downloadTicketTtlMs
    expect(refused(await redeem(0))).toBe('ticket_expired')
    clock = START
    ok(await revokeGrant(world))
    expect(refused(await redeem(0))).toBe('revoked')
  })

  it('keeps a ticket sealed under a rotated key until it expires and refuses every ticket of a revoked key at once', async () => {
    const world = await published()
    const { broker, auth } = world.tickets
    const request = (requestId: string) => ({
      requestId,
      input: { ...world.ref, disposition: 'inline' as const },
    })
    const old = ok(await world.access.openDownload(request('download-1'), ctx()))
    ok(
      await broker.rotate(
        { secretId: 'ticket-key', newVersionRef: 'secret://fixture/ticket-v2' },
        auth.call({}, true),
      ),
    )
    expect(ok(await world.access.openDownload(request('download-1'), ctx()))).toEqual(old)
    const whole = ok(await world.access.redeemDownload({ ...ticketParts(old), offset: 0 }, ctx()))
    expect(sha(await collect(whole.stream))).toBe(sha(CONTENT))
    const fresh = ok(await world.access.openDownload(request('download-2'), ctx()))
    expect(storedTickets(world)).toEqual([
      { request_id: 'download-1', key_version: 'v1' },
      { request_id: 'download-2', key_version: 'v2' },
    ])

    ok(await broker.revoke({ secretId: 'ticket-key', reason: 'emergency' }, auth.call({}, true)))
    for (const [requestId, ticket] of [
      ['download-1', old],
      ['download-2', fresh],
    ] as const) {
      expect(refused(await world.access.openDownload(request(requestId), ctx()))).toBe('ticket_revoked')
      expect(refused(await world.access.redeemDownload({ ...ticketParts(ticket), offset: 0 }, ctx()))).toBe(
        'ticket_revoked',
      )
    }
    expect(refused(await world.access.openDownload(request('download-3'), ctx()))).toBe('ticket_revoked')
  })

  it('stops redeeming once the artifact version is revoked', async () => {
    const world = await published()
    const ticket = ok(
      await world.access.openDownload(
        { requestId: 'download-1', input: { ...world.ref, disposition: 'inline' } },
        ctx(),
      ),
    )
    const { ticketId, nonce } = ticketParts(ticket)
    const live = ok(await world.access.redeemDownload({ ticketId, nonce, offset: 0 }, ctx()))
    const iterator = live.stream.chunks[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    ok(await world.artifacts.revoke({ artifactRef: world.ref, reason: 'withdrawn' }, ctx()))
    expect((await iterator.next()).done).toBe(true)
    expect(refused(await live.stream.ended)).toBe('revoked')
    expect(refused(await world.access.redeemDownload({ ticketId, nonce, offset: 0 }, ctx()))).toBe('revoked')
  })
})
