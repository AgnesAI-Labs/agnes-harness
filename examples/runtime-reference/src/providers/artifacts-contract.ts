import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BlobReadPort, CallContext } from '@agnes/extension-api/runtime'
import {
  type ConformanceHarness,
  createTestServiceContainer,
  providerFileForContract,
} from '@agnes/extension-api/testkit'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import {
  ARTIFACT_READER,
  type ArtifactsContractPort,
  artifactsContractPort,
  registerArtifactsContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/artifacts.js'
import { ARTIFACTS_PROVIDER, BLOB_DEPENDENCY, openArtifactsStore } from './artifacts.js'
import { BLOB_PROVIDER, openBlobStore } from './blob.js'
import { build, releaseSetDigest } from './blob-contract.js'

/** A profile lifetime narrower than the contract's, so the suite sees the provider take the smaller one. */
export const PROFILE_TICKET_TTL_MS = 120_000
const TICKET_KEY = new Uint8Array(32).fill(9)
const MEDIA_TYPE = 'application/octet-stream'

const sha256 = (url: URL) => createHash('sha256').update(readFileSync(url)).digest('hex')
const readable = (context: CallContext) => context.authorizationRef === ARTIFACT_READER.authorizationRef

/**
 * Drives the reference artifacts store, reading through the reference blob store selected in a test
 * service container, through the six scenarios; the contract module judges what it reports.
 */
export function referenceArtifactsPort(
  directory: string,
  providerId: string = ARTIFACTS_PROVIDER.id,
): { port: ArtifactsContractPort; close(): void } {
  const blobPath = join(directory, 'blob.sqlite')
  const artifactsPath = join(directory, 'artifacts.sqlite')
  let clock = Date.parse('2026-10-01T00:00:00.000Z')
  let reads = 0
  const openBlob = () => openBlobStore(blobPath, { authorizeRead: readable })
  let blob = openBlob()
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
  container.register({
    requirement: BLOB_DEPENDENCY,
    binding: {
      bindingId: 'reference-blob',
      contract: 'agh.blob',
      logicalName: BLOB_DEPENDENCY.logicalName,
      providerId: BLOB_PROVIDER.id,
    },
    blobRead: counted,
  })
  const openArtifacts = () =>
    openArtifactsStore(artifactsPath, {
      dependencies: container.dependencies,
      authorize: readable,
      ticketKey: TICKET_KEY,
      ticketTtlMs: PROFILE_TICKET_TTL_MS,
      now: () => clock,
    })
  let artifacts = openArtifacts()
  const grants = new Map<string, Wire.Id>()
  const key = (ref: Wire.ArtifactRef) => `${ref.artifactId}@${ref.version}`
  const close = () => {
    artifacts.close()
    blob.close()
  }
  const port = artifactsContractPort({
    binding: {
      requirement: {
        contract: 'agh.artifacts',
        major: 1,
        logicalName: `artifacts-${providerId}`,
        features: ['artifact-access.v1'],
        scope: 'runtime',
        optional: false,
      },
      binding: {
        bindingId: `reference-artifacts-${providerId}`,
        contract: 'agh.artifacts',
        logicalName: `artifacts-${providerId}`,
        providerId,
      },
      artifactAccess: artifacts.artifactAccess,
    },
    access: () => artifacts.artifactAccess,
    async publish(bytes, artifactId) {
      const ref = artifacts.publishPinned({
        artifactId: artifactId ?? null,
        blob: blob.seed(bytes, MEDIA_TYPE),
        title: 'Conformance',
        mediaType: MEDIA_TYPE,
      })
      const grant = artifacts.grant({
        artifact: ref,
        granteePrincipalRef: ARTIFACT_READER.principalRef,
        scope: ARTIFACT_READER.scope,
        permissions: ['read', 'download'],
        sourceAuthorizationRef: 'conformance-policy',
      })
      grants.set(key(ref), grant.grantId)
      return ref
    },
    revoke: async (ref) => artifacts.revoke(ref),
    async revokeGrant(ref) {
      artifacts.revokeGrant(grants.get(key(ref)) ?? 'missing')
    },
    now: () => clock,
    advance(ms) {
      clock += ms
    },
    blobReads: () => reads,
    async reopen() {
      close()
      blob = openBlob()
      artifacts = openArtifacts()
    },
    close: async () => close(),
    remains: () => existsSync(blobPath) && existsSync(artifactsPath),
    locations: [directory, realpathSync(directory)],
    ticketTtlMs: PROFILE_TICKET_TTL_MS,
  })
  return { port, close }
}

/**
 * Registers the six artifacts cases for the reference provider on fresh databases, reported under
 * `providerId`. `change` lets a test break one scenario to prove the contract notices. Call `close`
 * after the harness has run.
 */
export function bindArtifactsContract(
  harness: ConformanceHarness,
  command: string,
  options: Readonly<{
    providerId?: string
    change?: (port: ArtifactsContractPort) => ArtifactsContractPort
  }> = {},
): { close(): void } {
  const providerId = options.providerId ?? ARTIFACTS_PROVIDER.id
  const directory = mkdtempSync(join(tmpdir(), 'reference-artifacts-contract-'))
  const reference = referenceArtifactsPort(directory, providerId)
  registerArtifactsContract(harness, {
    providerId,
    recipe: providerFileForContract('agh.artifacts'),
    command,
    build,
    providerDigest: sha256(new URL('./artifacts.ts', import.meta.url)),
    configDigest: canonicalJsonDigest({ ticketTtlMs: PROFILE_TICKET_TTL_MS }),
    releaseSetDigest: releaseSetDigest(),
    port: options.change ? options.change(reference.port) : reference.port,
  })
  return {
    close() {
      reference.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
