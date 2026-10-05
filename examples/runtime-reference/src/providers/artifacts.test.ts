import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { createConformanceHarness, createTestServiceContainer, SCENARIOS } from '@agnes/extension-api/testkit'
import { RuntimeArtifactPolicy } from '@agnes/protocol/runtime'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ArtifactsContractPort } from '../../../../packages/extension-api/testkit/runtime/contracts/artifacts.js'
import {
  TRANSFER_MAINTAINER,
  type TransferContractPort,
} from '../../../../packages/extension-api/testkit/runtime/contracts/authority-transfer.js'
import { inline } from '../../../../packages/extension-api/testkit/runtime/contracts/projection.js'
import {
  ticketBinding,
  ticketBoundary,
  ticketBroker,
} from '../../../../packages/host/test/runtime/artifact-ticket-key-fixture.js'
import { createReferenceRegistry } from '../index.js'
import {
  ARTIFACTS_PROVIDER,
  type ArtifactsStore,
  type ArtifactsStoreOptions,
  BLOB_DEPENDENCY,
  openArtifactsStore,
} from './artifacts.js'
import { bindArtifactsContract } from './artifacts-contract.js'
import { BLOB_PROVIDER, type BlobStore, openBlobStore } from './blob.js'
import { directoryMaintenance, type Routes, TENANT } from './blob-contract.js'

const START = Date.parse('2026-10-01T00:00:00.000Z')
const SCOPE = {
  kind: 'session',
  installationId: 'install-1',
  runtimeId: 'runtime-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
} as const
const BLOB_BINDING = {
  bindingId: 'blob-1',
  contract: 'agh.blob',
  logicalName: 'content',
  providerId: BLOB_PROVIDER.id,
}

function ctx(over: Partial<Pick<CallContext, 'principalRef' | 'authorizationRef'>> = {}): CallContext {
  return {
    principalRef: 'user-1',
    scope: SCOPE,
    bindingId: 'artifacts-1',
    invocationId: 'invocation-1',
    deadline: '2026-10-02T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'auth-ok',
    signal: new AbortController().signal,
    ...over,
  }
}

const refused = (outcome: Outcome<unknown>) => (outcome.ok ? null : outcome.error.detailCode)

function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.value
}

const text = (value: string) => new TextEncoder().encode(value)
const trusted = (context: CallContext) => context.authorizationRef === 'auth-ok'

let directory: string
let blob: BlobStore
let artifacts: ArtifactsStore
let tickets: ReturnType<typeof referenceTickets>
let clock: number
let reads: number

type Overrides = { [K in keyof ArtifactsStoreOptions]?: ArtifactsStoreOptions[K] | undefined }

/**
 * A real reference ticket key broker behind the reference secrets service, and the option a trusted
 * assembly hands the store: the port and a delegation of each client call to the installed owner.
 */
function referenceTickets() {
  const auth = ticketBoundary()
  const { broker, port } = ticketBroker('reference', join(directory, 'secrets'), auth, {}, () => clock)
  const keys: NonNullable<ArtifactsStoreOptions['ticketKeys']> = {
    port,
    binding: ticketBinding,
    tenantId: 'tenant',
    authorityId: 'selected-blob',
    delegate: (call) => auth.delegate({ signal: call.signal }),
  }
  return { auth, broker, keys }
}

/** The stored tickets' request ids and key versions, as a reopened store would find them. */
function storedTickets(name = 'artifacts') {
  const db = new DatabaseSync(join(directory, `${name}.sqlite`), { readOnly: true })
  try {
    return db
      .prepare('SELECT request_id, key_version FROM sealed_tickets ORDER BY request_id')
      .all()
      .map((row) => [row.request_id, row.key_version])
  } finally {
    db.close()
  }
}

const download = (ref: { artifactId: string; version: number }, requestId: string) => ({
  requestId,
  input: { ...ref, disposition: 'inline' as const },
})

/** An artifacts store at `name` over the `selected` blob store. */
function open(extra: Overrides = {}, name = 'artifacts', selected = blob): ArtifactsStore {
  const container = createTestServiceContainer()
  container.register({
    requirement: BLOB_DEPENDENCY,
    binding: BLOB_BINDING,
    blobRead: {
      readRange: (request, context) => {
        reads += 1
        return selected.blobRead.readRange(request, context)
      },
      openRead: (request, context) => {
        reads += 1
        return selected.blobRead.openRead(request, context)
      },
    },
  })
  const options = {
    dependencies: container.dependencies,
    authorize: trusted,
    ticketKeys: tickets.keys,
    now: () => clock,
    ...extra,
  }
  return openArtifactsStore(join(directory, `${name}.sqlite`), options as ArtifactsStoreOptions)
}

function publish(body: string, artifactId: string | null = null) {
  const ref = artifacts.publishPinned({
    artifactId,
    blob: blob.seed(text(body), 'text/plain'),
    title: 'Notes',
    mediaType: 'text/plain',
  })
  const grant = artifacts.grant({
    artifact: ref,
    granteePrincipalRef: 'user-1',
    scope: SCOPE,
    permissions: ['read', 'download'],
    sourceAuthorizationRef: 'policy-1',
  })
  return { ref, grant }
}

// Opens three durable stores that flush every commit; a stalled hosted Windows runner took about 15s here.
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'reference-artifacts-'))
  clock = START
  reads = 0
  blob = openBlobStore(join(directory, 'blob.sqlite'), { authorizeRead: trusted })
  tickets = referenceTickets()
  artifacts = open()
}, 30_000)

afterEach(async () => {
  artifacts.close()
  blob.close()
  await tickets.broker.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('reference artifacts store', () => {
  it('refuses to open over a selection without the blob read port', () => {
    const empty = createTestServiceContainer()
    const options = { dependencies: empty.dependencies }
    expect(() => openArtifactsStore(join(directory, 'other.sqlite'), options)).toThrow(
      'no blob service is selected',
    )
    const portless = createTestServiceContainer()
    portless.register({ requirement: BLOB_DEPENDENCY, binding: BLOB_BINDING })
    expect(() =>
      openArtifactsStore(join(directory, 'other.sqlite'), { dependencies: portless.dependencies }),
    ).toThrow('no read port')
  })

  it('numbers versions per artifact and reads every byte through the selected blob port', async () => {
    const first = publish('version one')
    const second = publish('version two', first.ref.artifactId)
    expect(second.ref).toEqual({ artifactId: first.ref.artifactId, version: 2 })
    expect(() => publish('orphan', 'missing')).toThrow('no such artifact')
    const range = must(
      await artifacts.artifactAccess.readRange({ ...first.ref, offset: 8, length: 3 }, ctx()),
    )
    expect(range.bytes).toEqual(text('one'))
    const stream = must(await artifacts.artifactAccess.openStream(second.ref, ctx()))
    for await (const _ of stream.chunks);
    expect((await stream.ended).ok).toBe(true)
    expect(reads).toBe(2)
    expect(must(await artifacts.artifactAccess.describe(second.ref, ctx()))).toEqual({
      ...second.ref,
      title: 'Notes',
      mime: 'text/plain',
      size: 11,
      status: 'ready',
    })
  })

  it('blocks access without a Host check and tickets without a ticket key broker, and never redeems', async () => {
    const { ref } = publish('content')
    artifacts.close()
    artifacts = open({ authorize: undefined, ticketKeys: undefined })
    expect(refused(await artifacts.artifactAccess.describe(ref, ctx()))).toBe('blocked')
    artifacts.close()
    artifacts = open({ ticketKeys: undefined })
    expect(refused(await artifacts.artifactAccess.openDownload(download(ref, 'download-1'), ctx()))).toBe(
      'blocked',
    )
    expect(artifacts.features).toEqual(['artifact-access.v1'])
    const redeem = { ticketId: 'ticket-1', nonce: 'A'.repeat(43), offset: 0 }
    artifacts.close()
    artifacts = open()
    // Redemption is not offered, so even with the broker artifact-ticket.v1 is not declared.
    expect(artifacts.features).toEqual(['artifact-access.v1'])
    expect(refused(await artifacts.artifactAccess.redeemDownload(redeem, ctx()))).toBe(
      'operation_not_supported',
    )
  })

  it('caps a ticket at the contract lifetime, rebuilds it for a repeat or a concurrent request and keeps no nonce', async () => {
    const { ref } = publish('content')
    artifacts.close()
    artifacts = open({ ticketTtlMs: RuntimeArtifactPolicy.downloadTicketTtlMs * 2 })
    const request = { requestId: 'download-1', input: { ...ref, disposition: 'attachment' as const } }
    const ticket = must(await artifacts.artifactAccess.openDownload(request, ctx()))
    expect(Date.parse(ticket.expiresAt) - START).toBe(RuntimeArtifactPolicy.downloadTicketTtlMs)
    expect(ticket.url).toMatch(/^\/api\/runtime\/artifact\/download\/[^?]+\?nonce=[A-Za-z0-9_-]{43}$/)
    artifacts.close()
    artifacts = open()
    clock += 1000
    expect(must(await artifacts.artifactAccess.openDownload(request, ctx()))).toEqual(ticket)
    const racing = download(ref, 'download-2')
    const [one, two] = await Promise.all([
      artifacts.artifactAccess.openDownload(racing, ctx()),
      artifacts.artifactAccess.openDownload(racing, ctx()),
    ])
    expect(must(two)).toEqual(must(one))
    expect(storedTickets()).toEqual([
      ['download-1', 'v1'],
      ['download-2', 'v1'],
    ])
    const nonce = ticket.url.split('?nonce=')[1] ?? ''
    for (const file of ['artifacts.sqlite', 'artifacts.sqlite-wal']) {
      const path = join(directory, file)
      if (!existsSync(path)) continue
      for (const form of [Buffer.from(nonce), Buffer.from(nonce, 'base64url')])
        expect(readFileSync(path).includes(form)).toBe(false)
    }
    expect(
      refused(await artifacts.artifactAccess.openDownload(request, ctx({ principalRef: 'user-2' }))),
    ).toBe('permission_denied')
  })

  it('keeps a ticket sealed under a rotated key until it expires and refuses every ticket of a revoked key at once', async () => {
    const { ref } = publish('content')
    const { broker, auth } = tickets
    const issue = (requestId: string) =>
      artifacts.artifactAccess.openDownload(download(ref, requestId), ctx())
    const old = must(await issue('download-1'))
    must(
      await broker.rotate(
        { secretId: 'ticket-key', newVersionRef: 'secret://fixture/ticket-v2' },
        auth.call({}, true),
      ),
    )
    expect(must(await issue('download-1'))).toEqual(old)
    clock += 1000
    const current = must(await issue('download-2'))
    expect(current.url).not.toBe(old.url)
    expect(storedTickets()).toEqual([
      ['download-1', 'v1'],
      ['download-2', 'v2'],
    ])
    clock = Date.parse(old.expiresAt)
    expect(refused(await issue('download-1'))).toBe('ticket_expired')
    expect(must(await issue('download-2'))).toEqual(current)
    must(await broker.revoke({ secretId: 'ticket-key', reason: 'emergency' }, auth.call({}, true)))
    expect([await issue('download-2'), await issue('download-3')].map(refused)).toEqual([
      'ticket_revoked',
      'ticket_revoked',
    ])
    expect(storedTickets()).toHaveLength(2)
  })

  it('stores no ticket the broker refuses or whose grant ends while it is sealed', async () => {
    const first = publish('content')
    const { keys, auth } = tickets
    artifacts.close()
    // The grant is revoked while the broker seals, so the check after the broker refuses the ticket.
    artifacts = open({
      ticketKeys: {
        ...keys,
        port: {
          openNonce: keys.port.openNonce,
          sealNonce: async (query, call) => {
            const sealed = await keys.port.sealNonce(query, call)
            artifacts.revokeGrant(first.grant.grantId)
            return sealed
          },
        },
      },
    })
    const ended = await artifacts.artifactAccess.openDownload(download(first.ref, 'download-1'), ctx())
    expect(refused(ended)).toBe('permission_denied')
    const second = publish('other')
    auth.withdraw()
    const withdrawn = await artifacts.artifactAccess.openDownload(download(second.ref, 'download-2'), ctx())
    // The broker's refusal passes through unchanged.
    expect(withdrawn.ok ? null : withdrawn.error).toMatchObject({
      detailCode: 'ticket_delegation',
      diagnosticId: 'reference-artifact-ticket-key',
    })
    expect(storedTickets()).toEqual([])
  })

  it('stops a grant and a version at the next check, leaving other versions readable', async () => {
    const first = publish('one')
    const second = publish('two', first.ref.artifactId)
    const revoked = artifacts.revokeGrant(first.grant.grantId, 'request-1')
    expect(revoked).toMatchObject({ status: 'revoked', revision: 2 })
    expect(artifacts.revokeGrant(first.grant.grantId, 'request-2')).toEqual(revoked)
    expect(refused(await artifacts.artifactAccess.describe(first.ref, ctx()))).toBe('permission_denied')
    clock += 1
    artifacts.revoke(second.ref)
    artifacts.revoke(second.ref)
    expect(artifacts.revocations()).toEqual([
      {
        seq: 1,
        kind: 'revokeGrant',
        ref: { grantId: first.grant.grantId },
        requestId: 'request-1',
        at: START,
      },
      { seq: 2, kind: 'revoke', ref: second.ref, requestId: null, at: START + 1 },
    ])
    expect(must(await artifacts.artifactAccess.describe(second.ref, ctx())).status).toBe('revoked')
    expect(
      refused(await artifacts.artifactAccess.readRange({ ...second.ref, offset: 0, length: 1 }, ctx())),
    ).toBe('revoked')
    expect(() => artifacts.grant({ ...first.grant, artifact: second.ref })).toThrow('missing or revoked')
    const third = publish('three', first.ref.artifactId)
    expect(
      must(await artifacts.artifactAccess.readRange({ ...third.ref, offset: 0, length: 5 }, ctx())).bytes,
    ).toEqual(text('three'))
  })

  it('refuses every call once closed', async () => {
    const { ref } = publish('content')
    artifacts.close()
    expect(refused(await artifacts.artifactAccess.describe(ref, ctx()))).toBe('blocked')
    expect(() => publish('more')).toThrow('artifacts store is closed')
  })
})

describe('reference artifacts authority transfer', () => {
  const MAINTAINER = ctx({ authorizationRef: TRANSFER_MAINTAINER })
  const UPGRADE = 'upgrade-1'
  const routes: Routes = new Map()
  const opened: { close(): void }[] = []
  afterEach(() => {
    for (const each of opened.splice(0)) each.close()
    routes.clear()
  })

  /** A store at `locationRef` with a maintenance assembly over `selected`; an import reads from `artifacts`. */
  function at(locationRef: string, selected: BlobStore, extra: Overrides = {}) {
    const store = open(
      {
        maintenance: directoryMaintenance(
          routes,
          locationRef,
          (ref, context) => artifacts.readExport(ref, context),
          'plan',
        ),
        blobTransfer: { binding: BLOB_BINDING, holds: (ref) => selected.holds(ref) },
        ...extra,
      },
      locationRef,
      selected,
    )
    opened.push(store)
    return store
  }

  it('declares and offers authority transfer only with maintenance and the selected blob service entry', async () => {
    const absent = { upgradeId: UPGRADE }
    const offered = async (extra: Overrides) => {
      const store = at('offered', blob, extra)
      const probe = await store.transfer.probe(absent, MAINTAINER)
      store.close()
      return [store.features, probe.ok ? probe.value : refused(probe)]
    }
    const unsupported = [['artifact-access.v1'], 'operation_not_supported']
    expect(await offered({ maintenance: undefined, blobTransfer: undefined })).toEqual(unsupported)
    expect(await offered({ blobTransfer: undefined })).toEqual(unsupported)
    expect(await offered({ maintenance: undefined })).toEqual(unsupported)
    expect(await offered({})).toEqual([['artifact-access.v1', 'authority-transfer.v1'], { state: 'absent' }])
    const elsewhere = { binding: { ...BLOB_BINDING, bindingId: 'blob-2' }, holds: () => true }
    expect(() => at('offered', blob, { blobTransfer: elsewhere })).toThrow('another blob service')
  })

  it('carries the revocation log, refuses miscounted exports and activates nothing while a blob is missing', async () => {
    artifacts.close()
    artifacts = at('source', blob)
    const one = publish('one')
    const two = publish('two')
    const three = publish('three')
    artifacts.revoke(one.ref)
    artifacts.revokeGrant(two.grant.grantId, 'request-1')
    const ticket = (store: ArtifactsStore, requestId: string) =>
      store.artifactAccess.openDownload(download(three.ref, requestId), ctx())
    must(await ticket(artifacts, 'download-1'))
    const expected = { authorityId: 'reference-artifacts', tenantId: TENANT, authorityEpoch: 1 }
    const fence = must(
      await artifacts.transfer.fence(
        { upgradeId: UPGRADE, expected, cohortDigest: 'c'.repeat(64) },
        MAINTAINER,
      ),
    )
    // A fenced store neither issues a ticket nor rebuilds one.
    expect(
      [await ticket(artifacts, 'download-1'), await ticket(artifacts, 'download-2')].map(refused),
    ).toEqual(['blocked', 'blocked'])
    const exported = must(
      await artifacts.transfer.export({ upgradeId: UPGRADE, fenceId: fence.fenceId }, MAINTAINER),
    )
    // The blob service was never moved: the target's blob store is empty.
    const empty = openBlobStore(join(directory, 'empty-blob.sqlite'), { authorizeRead: trusted })
    opened.push(empty)
    const imports = async (locationRef: string, source: typeof exported) =>
      at(locationRef, empty, { candidate: true }).transfer.import(
        { upgradeId: UPGRADE, source, targetLocationRef: locationRef },
        MAINTAINER,
      )
    expect([
      refused(await imports('collections', { ...exported, collectionCount: exported.collectionCount + 1 })),
      refused(await imports('parts', { ...exported, partCount: exported.partCount - 1 })),
    ]).toEqual(['integrity', 'integrity'])
    const target = at('target', empty, { candidate: true })
    const imported = must(
      await target.transfer.import(
        { upgradeId: UPGRADE, source: exported, targetLocationRef: 'target' },
        MAINTAINER,
      ),
    )
    const verified = must(
      await target.transfer.verify(
        { upgradeId: UPGRADE, source: exported, candidateRef: imported.candidateRef },
        MAINTAINER,
      ),
    )
    expect(exported.deletionWatermark).toBe(2)
    expect(target.revocations()).toEqual(artifacts.revocations())
    // Tickets stay out of the checkpoint, and a candidate issues none over the imported grant.
    expect(storedTickets('target')).toEqual([])
    expect(refused(await ticket(target, 'download-1'))).toBe('blocked')
    expect(verified.checks.filter((check) => !check.passed).map((check) => check.checkId)).toEqual([
      'required-assets',
    ])
    const route = {
      logicalAuthorityId: 'reference-artifacts',
      tenantId: TENANT,
      authorityEpoch: 2,
      providerBinding: { ...BLOB_BINDING, contract: 'agh.artifacts', bindingId: 'artifacts-1' },
      locationRef: 'target',
      cohortDigest: 'c'.repeat(64),
      cutoverId: 'cutover-1',
      checkpoint: { ...imported.targetCheckpoint, authorityEpoch: 2 },
      previous: { authorityEpoch: 1, locationRef: 'source', cutoverId: 'none' },
    }
    routes.set(route.logicalAuthorityId, { route, targetActivated: false })
    const schema = { typeId: 'test/route@1', revision: 1, digest: 'd'.repeat(64) }
    const activate = { upgradeId: UPGRADE, cutoverId: route.cutoverId, publishedRoute: inline(schema, route) }
    expect(refused(await target.transfer.activate(activate, MAINTAINER))).toBe('integrity')
    expect(must(await target.transfer.probe({ upgradeId: UPGRADE }, MAINTAINER)).state).toBe('imported')
  })
})

// One run opens about fifty durable stores that flush every commit; hosted Windows measured 4s to at
// least 22s, so the budget does not rest on the platform default.
describe('reference artifacts: conformance', { timeout: 60_000 }, () => {
  it('fills the artifacts slot of the reference registry', () => {
    const slot = createReferenceRegistry([ARTIFACTS_PROVIDER, BLOB_PROVIDER]).find(
      (item) => item.contract === 'agh.artifacts',
    )
    expect(slot?.provider).toEqual(ARTIFACTS_PROVIDER)
    expect(slot?.providerFile).toBe('examples/runtime-reference/src/providers/artifacts.ts')
  })

  async function runContract(
    change: (port: ArtifactsContractPort) => ArtifactsContractPort,
    changeTransfer: (port: TransferContractPort) => TransferContractPort = (port) => port,
  ) {
    const harness = createConformanceHarness()
    const bound = bindArtifactsContract(harness, 'reference-artifacts-conformance', {
      change,
      changeTransfer,
    })
    try {
      return await harness.run({
        contracts: ['agh.artifacts'],
        providers: [ARTIFACTS_PROVIDER.id],
        command: 'reference-artifacts-conformance',
        clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
      })
    } finally {
      bound.close()
    }
  }

  it('passes select, normal, deny, cancel, recover and dispose for access and for a cohort authority transfer', async () => {
    const report = await runContract((port) => port)
    expect(report.assertions.map((item) => [item.id, item.status])).toEqual(
      ['', '/authority-transfer'].flatMap((suite) =>
        SCENARIOS.map((scenario) => [`agh.artifacts/${ARTIFACTS_PROVIDER.id}${suite}/${scenario}`, 'passed']),
      ),
    )
    expect(report.status).toBe('passed')
    expect(report.failures).toEqual([])
  })

  it('fails a scenario whose observations break the contract', async () => {
    const report = await runContract(
      (port) => ({
        ...port,
        normal: async (context) => ({ ...(await port.normal(context)), blobReads: 0 }),
      }),
      (port) => ({
        ...port,
        recover: async (context) => ({ ...(await port.recover(context)), sourceServes: false }),
      }),
    )
    expect(report.assertions.filter((item) => item.status === 'failed').map((item) => item.id)).toEqual([
      `agh.artifacts/${ARTIFACTS_PROVIDER.id}/normal`,
      `agh.artifacts/${ARTIFACTS_PROVIDER.id}/authority-transfer/recover`,
    ])
    expect(report.status).toBe('failed')
  })
})
