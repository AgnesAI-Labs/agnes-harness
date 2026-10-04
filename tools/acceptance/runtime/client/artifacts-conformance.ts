import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindArtifactsContract } from '../../../../examples/runtime-reference/src/providers/artifacts-contract.js'
import { bindBlobContract } from '../../../../examples/runtime-reference/src/providers/blob-contract.js'
import type {
  BlobReadPort,
  CallContext,
  Outcome,
} from '../../../../packages/extension-api/src/runtime/index.js'
import {
  ARTIFACT_READER,
  artifactsContractPort,
  registerArtifactsContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/artifacts.js'
import {
  blobContractPort,
  createBlobReadGate,
  MIB,
  registerBlobContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/blob.js'
import {
  type ConformanceHarness,
  createTestServiceContainer,
} from '../../../../packages/extension-api/testkit/runtime/harness.js'
import {
  BLOB_REQUIREMENT,
  createArtifactsService,
} from '../../../../packages/host/src/runtime/providers/artifacts.js'
import {
  BLOB_FEATURES,
  type BlobService,
  createBlobService,
} from '../../../../packages/host/src/runtime/providers/blob.js'
import { artifactTicketKeys } from '../../../../packages/host/test/runtime/artifact-ticket-key-fixture.js'
import type * as Wire from '../../../../packages/protocol/src/runtime/index.js'
import { canonicalJsonDigest, RuntimeSchemaRefs } from '../../../../packages/protocol/src/runtime/index.js'
import {
  getConformanceBuildIdentity,
  withConformanceBuild,
  withDeploymentStandIns,
} from '../build-identity.js'

const CONTRACTS = ['agh.blob', 'agh.artifacts'] as const
type Contract = (typeof CONTRACTS)[number]
const PROVIDERS = ['default', 'reference'] as const
const BLOB_RECIPE = 'packages/host/src/runtime/providers/blob.ts'
const ARTIFACTS_RECIPE = 'packages/host/src/runtime/providers/artifacts.ts'
const RELEASE_SET = 'packages/host/package.json'
const BLOB_STAND_INS =
  'reads pass the suite gate in place of Host authorization; not evidence for production authorization'
const ARTIFACTS_STAND_INS =
  'over the default blob service; reads pass the suite reader in place of Host authorization and ticket keys come from a default secrets broker over synthetic key material; not evidence for production authorization or ticket keys'
const BLOB_BINDING = {
  bindingId: 'blob-1',
  contract: 'agh.blob',
  logicalName: 'default',
  providerId: 'agh.blob.default',
}
const MEDIA_TYPE = 'application/octet-stream'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const sha256 = (path: string) =>
  createHash('sha256')
    .update(readFileSync(join(root, path)))
    .digest('hex')
const temporary = (name: string) => mkdtempSync(join(tmpdir(), `default-${name}-contract-`))

// The writer, owner action and requests the Host tests drive both services with.
const sessionScope: CallContext['scope'] = {
  kind: 'session',
  installationId: 'install-1',
  runtimeId: 'runtime-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
}
function writer(scope: CallContext['scope'] = sessionScope): CallContext {
  return {
    principalRef: 'user-1',
    scope,
    bindingId: 'binding-1',
    invocationId: 'invocation-1',
    deadline: '2026-10-02T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'auth-ok',
    signal: new AbortController().signal,
  }
}
const owner = {
  run: {
    runId: 'run-1',
    session: {
      sessionId: 'session-1',
      authority: { authorityId: 'state-1', tenantId: 'tenant-1', authorityEpoch: 1 },
    },
  },
  actionId: 'action-1',
}
const DESCRIPTOR = RuntimeSchemaRefs.ArtifactContentDescriptor

function ok<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`${outcome.error.detailCode}: ${outcome.error.message}`)
  return outcome.value
}

async function sealed(blob: BlobService, uploadId: string, bytes: Uint8Array, mediaType: string) {
  ok(await blob.stage({ uploadId, size: bytes.byteLength, mediaType, expectedDigest: null }, writer()))
  const upload = ok(blob.openWriter(uploadId, writer()))
  for (let at = 0; at < bytes.byteLength; at += MIB) ok(upload.write(at, bytes.subarray(at, at + MIB)))
  const result = ok(await upload.seal())
  upload.close()
  return result.upload
}

/** Registers the six blob cases for the Host default blob service in a fresh directory. */
function bindDefaultBlob(harness: ConformanceHarness, command: string): void {
  const dataDir = temporary('blob')
  const gate = createBlobReadGate()
  const start = () =>
    createBlobService({
      dataDir,
      authorityId: 'blob-authority',
      binding: BLOB_BINDING,
      authorizeRead: gate.allows,
    })
  let current = start()
  let live = true
  let seeds = 0
  const shut = () => {
    if (live) current.close()
    live = false
  }
  const port = blobContractPort({
    binding: {
      requirement: {
        contract: 'agh.blob',
        major: 1,
        logicalName: 'conformance',
        features: [...BLOB_FEATURES],
        scope: 'runtime',
        optional: false,
      },
      binding: { ...BLOB_BINDING, logicalName: 'conformance', providerId: 'default' },
      blobRead: current.blobRead,
    },
    gate,
    read: () => current.blobRead,
    async seed(bytes) {
      const upload = await sealed(current, `conformance-${++seeds}`, bytes, 'text/plain')
      const stagedBlob = ok(await current.promote({ upload, expectedDigest: upload.digest }, writer()))
      const ownerRef: Wire.PublicRef = { kind: 'artifact', value: { artifactId: 'artifact-1', version: 1 } }
      return ok(await current.pin({ stagedBlob, ownerRef, retentionUntil: null }, writer()))
    },
    corrupt: async (ref, bytes) =>
      writeFileSync(join(dataDir, 'artifacts', 'sha256', ref.digest.slice(0, 2), ref.digest), bytes),
    async reopen() {
      shut()
      current = start()
      live = true
    },
    close: async () => shut(),
    remains: () => existsSync(join(dataDir, 'artifacts', 'blob-service.db')),
  })
  registerBlobContract(withDeploymentStandIns(harness, BLOB_STAND_INS), {
    providerId: 'default',
    recipe: BLOB_RECIPE,
    command,
    build: getConformanceBuildIdentity(),
    providerDigest: sha256(BLOB_RECIPE),
    configDigest: canonicalJsonDigest({ authorityId: 'blob-authority' }),
    releaseSetDigest: sha256(RELEASE_SET),
    port,
  })
}

/**
 * Registers the six artifacts cases for the Host default artifacts service, assembled through a test
 * service container over the default blob service, in a fresh directory.
 */
function bindDefaultArtifacts(harness: ConformanceHarness, command: string): void {
  const dataDir = temporary('artifacts')
  const readable = (context: CallContext) => context.authorizationRef === ARTIFACT_READER.authorizationRef
  let clock = Date.parse('2026-10-01T00:00:00.000Z')
  let reads = 0
  // The broker outlives a reopened service, as the secrets service that holds it would.
  const { keys } = artifactTicketKeys(join(temporary('ticket-keys'), 'secrets'), () => clock)
  const assemble = () => {
    const blob = createBlobService({
      dataDir,
      authorityId: 'blob-authority',
      binding: BLOB_BINDING,
      authorizeRead: readable,
    })
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
    container.register({ requirement: BLOB_REQUIREMENT, binding: BLOB_BINDING, blobRead: counted })
    const artifacts = ok(
      createArtifactsService({
        dataDir,
        authorityId: 'artifacts-authority',
        dependencies: container.dependencies,
        blobActions: blob,
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
  const author = writer(ARTIFACT_READER.scope)
  const latest = new Map<string, number>()
  const grants = new Map<string, Wire.ArtifactAccessGrantValue>()
  const key = (ref: Wire.ArtifactRef) => `${ref.artifactId}@${ref.version}`
  let published = 0
  const port = artifactsContractPort({
    binding: {
      requirement: {
        contract: 'agh.artifacts',
        major: 1,
        logicalName: 'conformance',
        features: ['artifact-access.v1'],
        scope: 'runtime',
        optional: false,
      },
      binding: {
        bindingId: 'artifacts-default',
        contract: 'agh.artifacts',
        logicalName: 'conformance',
        providerId: 'default',
      },
      artifactAccess: world.artifacts.artifactAccess,
    },
    access: () => world.artifacts.artifactAccess,
    async publish(bytes, artifactId) {
      const publicationId = `conformance-${++published}`
      const reserved = ok(
        await world.artifacts.reserve(
          {
            request: {
              publicationId,
              artifactId: artifactId ?? null,
              expectedLatestVersion: artifactId === undefined ? null : latest.get(artifactId),
              kind: DESCRIPTOR.typeId,
              schema: DESCRIPTOR,
              title: null,
              mediaType: null,
              ownerActionRef: { existingActionId: 'action-1' },
            },
            owner,
          },
          author,
        ),
      )
      const upload = await sealed(world.blob, `upload-${publicationId}`, bytes, MEDIA_TYPE)
      const request = {
        publicationId,
        source: { kind: 'upload', upload },
        expectedRevision: 1,
        title: 'Report',
        mediaType: MEDIA_TYPE,
      }
      ok(await world.artifacts.publish({ request, owner }, author))
      const ref = { artifactId: reserved.artifactId, version: reserved.version }
      latest.set(ref.artifactId, ref.version)
      const grant = ok(
        await world.artifacts.grant(
          {
            request: {
              requestId: `grant-${publicationId}`,
              artifactRef: ref,
              granteePrincipalRef: ARTIFACT_READER.principalRef,
              scope: ARTIFACT_READER.scope,
              permissions: ['read', 'download'],
              expiresAt: null,
            },
            owner,
            sourceAuthorizationRef: 'policy-1',
          },
          author,
        ),
      )
      grants.set(key(ref), grant)
      return ref
    },
    async revoke(ref) {
      ok(await world.artifacts.revoke({ artifactRef: ref, reason: 'conformance' }, author))
    },
    async revokeGrant(ref) {
      const grant = grants.get(key(ref))
      if (!grant) throw new Error('no grant was recorded for this version')
      const request = {
        requestId: `revoke-${grant.grantId}`,
        grantId: grant.grantId,
        expectedRevision: grant.revision,
        reason: 'conformance',
      }
      ok(await world.artifacts.revokeGrant({ request, owner }, author))
    },
    now: () => clock,
    advance(ms) {
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
  registerArtifactsContract(withDeploymentStandIns(harness, ARTIFACTS_STAND_INS), {
    providerId: 'default',
    recipe: ARTIFACTS_RECIPE,
    command,
    build: getConformanceBuildIdentity(),
    providerDigest: sha256(ARTIFACTS_RECIPE),
    configDigest: canonicalJsonDigest({ authorityId: 'artifacts-authority' }),
    releaseSetDigest: sha256(RELEASE_SET),
    port,
  })
}

const DEFAULT: Record<Contract, (harness: ConformanceHarness, command: string) => void> = {
  'agh.blob': bindDefaultBlob,
  'agh.artifacts': bindDefaultArtifacts,
}
const REFERENCE = { 'agh.blob': bindBlobContract, 'agh.artifacts': bindArtifactsContract } as const

// The Host default blob and artifacts services, on the test stand-ins above, and the reference stores
// bind here. The runner has no teardown, so the stores live until the process exits.
export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  const contracts = CONTRACTS.filter(
    (contract) => request.contracts === 'all' || request.contracts.includes(contract),
  )
  if (!contracts.length) return { contracts, providers: [] }
  const providers = PROVIDERS.filter((providerId) => request.providers.includes(providerId))
  for (const contract of contracts)
    for (const providerId of providers) {
      if (providerId === 'reference')
        REFERENCE[contract](withConformanceBuild(harness), request.command, { providerId })
      else DEFAULT[contract](harness, request.command)
    }
  return { contracts, providers }
}
