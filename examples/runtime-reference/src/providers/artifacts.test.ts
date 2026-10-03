import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { createConformanceHarness, createTestServiceContainer, SCENARIOS } from '@agnes/extension-api/testkit'
import { RuntimeArtifactPolicy } from '@agnes/protocol/runtime'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ArtifactsContractPort } from '../../../../packages/extension-api/testkit/runtime/contracts/artifacts.js'
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
let clock: number
let reads: number

type Overrides = { [K in keyof ArtifactsStoreOptions]?: ArtifactsStoreOptions[K] | undefined }

function open(extra: Overrides = {}): ArtifactsStore {
  const container = createTestServiceContainer()
  container.register({
    requirement: BLOB_DEPENDENCY,
    binding: BLOB_BINDING,
    blobRead: {
      readRange: (request, context) => {
        reads += 1
        return blob.blobRead.readRange(request, context)
      },
      openRead: (request, context) => {
        reads += 1
        return blob.blobRead.openRead(request, context)
      },
    },
  })
  const options = {
    dependencies: container.dependencies,
    authorize: trusted,
    ticketKey: new Uint8Array(32).fill(3),
    now: () => clock,
    ...extra,
  }
  return openArtifactsStore(join(directory, 'artifacts.sqlite'), options as ArtifactsStoreOptions)
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

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'reference-artifacts-'))
  clock = START
  reads = 0
  blob = openBlobStore(join(directory, 'blob.sqlite'), { authorizeRead: trusted })
  artifacts = open()
})

afterEach(() => {
  artifacts.close()
  blob.close()
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

  it('blocks access without a Host check and tickets without a key, and never redeems', async () => {
    const { ref } = publish('content')
    artifacts.close()
    artifacts = open({ authorize: undefined, ticketKey: undefined })
    expect(refused(await artifacts.artifactAccess.describe(ref, ctx()))).toBe('blocked')
    artifacts.close()
    artifacts = open({ ticketKey: undefined })
    const request = { requestId: 'download-1', input: { ...ref, disposition: 'inline' as const } }
    expect(refused(await artifacts.artifactAccess.openDownload(request, ctx()))).toBe('blocked')
    const redeem = { ticketId: 'ticket-1', nonce: 'A'.repeat(43), offset: 0 }
    expect(refused(await artifacts.artifactAccess.redeemDownload(redeem, ctx()))).toBe(
      'operation_not_supported',
    )
  })

  it('caps a ticket at the contract lifetime and keeps only what rebuilds it', async () => {
    const { ref } = publish('content')
    artifacts.close()
    artifacts = open({ ticketTtlMs: RuntimeArtifactPolicy.downloadTicketTtlMs * 2 })
    const request = { requestId: 'download-1', input: { ...ref, disposition: 'attachment' as const } }
    const ticket = must(await artifacts.artifactAccess.openDownload(request, ctx()))
    expect(Date.parse(ticket.expiresAt) - START).toBe(RuntimeArtifactPolicy.downloadTicketTtlMs)
    expect(ticket.url).toMatch(/^\/api\/runtime\/artifact\/download\/[^?]+\?nonce=[A-Za-z0-9_-]{43}$/)
    artifacts.close()
    artifacts = open()
    expect(must(await artifacts.artifactAccess.openDownload(request, ctx()))).toEqual(ticket)
    expect(
      refused(await artifacts.artifactAccess.openDownload(request, ctx({ principalRef: 'user-2' }))),
    ).toBe('permission_denied')
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

describe('reference artifacts: conformance', () => {
  it('fills the artifacts slot of the reference registry', () => {
    const slot = createReferenceRegistry([ARTIFACTS_PROVIDER, BLOB_PROVIDER]).find(
      (item) => item.contract === 'agh.artifacts',
    )
    expect(slot?.provider).toEqual(ARTIFACTS_PROVIDER)
    expect(slot?.providerFile).toBe('examples/runtime-reference/src/providers/artifacts.ts')
  })

  async function runContract(change: (port: ArtifactsContractPort) => ArtifactsContractPort) {
    const harness = createConformanceHarness()
    const bound = bindArtifactsContract(harness, 'reference-artifacts-conformance', { change })
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

  it('passes select, normal, deny, cancel, recover and dispose', async () => {
    const report = await runContract((port) => port)
    expect(report.assertions.map((item) => [item.scenario, item.status])).toEqual(
      SCENARIOS.map((scenario) => [scenario, 'passed']),
    )
    expect(report.status).toBe('passed')
    expect(report.failures).toEqual([])
  })

  it('fails a scenario whose observations break the contract', async () => {
    const report = await runContract((port) => ({
      ...port,
      normal: async (context) => ({ ...(await port.normal(context)), blobReads: 0 }),
    }))
    expect(report.assertions.filter((item) => item.status === 'failed').map((item) => item.scenario)).toEqual(
      ['normal'],
    )
    expect(report.status).toBe('failed')
  })
})
