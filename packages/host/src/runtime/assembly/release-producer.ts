import type { CallContext, MaintenanceStore, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type {
  BindingRef,
  DataRef,
  MaintenanceStoreCommitRequest,
  MaintenanceStoreCommitResult,
  ScopeRef,
  StateAuthorityRef,
} from '@agnes/protocol/runtime'
import { encodePublicationPayload, type PublicationContentBytes } from '../maintenance/publication-codecs.js'
import { MaintenanceFailure, maintenanceOutcome } from './maintenance-journal.js'
import { digest, equal, readWire, requireRelease } from './primitives.js'
import { captureReleaseProducerContents, readRetainedProducerFacts } from './release-producer-contents.js'
import type { InstalledReleaseProducer } from './release-producer-installation.js'
import { assertOriginalInstalledReleaseProducer } from './release-producer-installation.js'
import {
  encodeExternalPublicationReferences,
  externalPublicationRequiredDigests,
  readExternalPublicationManifest,
  readExternalPublicationReferences,
} from './release-producer-reference-codec.js'
import {
  type ReleaseProducerFacts,
  readProducerDeployment,
  releaseResolvedProducerSource,
  resolveProducerSource,
} from './release-producer-source.js'
import {
  type PublicationObjectStore,
  publicationBytesDigest,
  type RetainedPublicationObject,
} from './release-producer-storage.js'

/** Private original-reader seam. A native installer must authenticate it; ordinary JSON is insufficient. */
export interface ProducerPublication {
  request: MaintenanceStoreCommitRequest
  receipt: MaintenanceStoreCommitResult
  source: DataRef
}
export interface ReleaseProducerCommitPort {
  readonly objects: PublicationObjectStore
  readonly store: MaintenanceStore
  readonly authority: StateAuthorityRef
  readonly stateAuthority: StateAuthorityRef
  readonly writerEpoch: number
  readonly headRecordId: string
  readonly producer: BindingRef
  readonly scope: ScopeRef
  now(): string
  readPublication(transactionId: string, context: CallContext): Promise<ProducerPublication | null>
  acceptPublishedAdmissionRelease(receipt: MaintenanceStoreCommitResult, context: CallContext): Promise<void>
}

const originalRequests = new WeakMap<
  MaintenanceStoreCommitRequest,
  {
    context: CallContext
    source: DataRef
    qualifiedUntil: string
    preClock(): void
  }
>()

/** Captures original publication issuer facts before native time. This is not the installer's final SQL fence. */
export function captureReleaseProducerPublication(
  request: MaintenanceStoreCommitRequest,
  context: CallContext,
) {
  const original = originalRequests.get(request)
  requireRelease(
    original && original.context === context,
    'producer_original_source_missing',
    '/publication/source',
  )
  original.preClock()
  return {
    source: original.source,
    qualifiedUntil: original.qualifiedUntil,
  }
}

export function publicationRequest(
  facts: ReleaseProducerFacts,
  port: ReleaseProducerCommitPort,
  releaseReference: RetainedPublicationObject,
): MaintenanceStoreCommitRequest {
  const transactionId = `publish:${facts.release.releaseSetId}`,
    now = facts.observations.now
  const directory = {
    ...facts.observations.directory,
    routeRevision: 1,
    releaseSetId: facts.release.releaseSetId,
  }
  const head = {
    directoryJson: jcs(directory),
    jointDomainsJson: jcs(facts.observations.jointDomains),
    migrationsJson: '[]' as const,
    stateAuthorityRefJson: jcs(facts.binding.stateAuthorityAtCreation),
  }
  const route = {
    routeId: directory.routeId,
    activeReleaseSetId: facts.release.releaseSetId,
    authorityEpoch: facts.binding.stateAuthorityAtCreation.authorityEpoch,
    cutoverId: transactionId,
  }
  const encoded = [
    encodePublicationPayload('head', head),
    encodePublicationPayload('route', route),
    encodeExternalPublicationReferences({ release: releaseReference, source: null, members: [] }),
  ]
  const ids = [
    port.headRecordId,
    `release-route:${directory.routeId}`,
    `release:${facts.release.releaseSetId}`,
  ]
  return readWire('MaintenanceStoreCommitRequest', {
    transactionId,
    authority: port.authority,
    expectedWriterEpoch: port.writerEpoch,
    mutations: encoded.map((ref, index) => {
      requireRelease(ref.kind === 'inline' && ids[index], 'publication_inline_budget', '/publication')
      return {
        recordId: ids[index],
        expectedRevision: null,
        next: {
          recordId: ids[index],
          revision: 1,
          writerEpoch: port.writerEpoch,
          createdAt: now,
          updatedAt: now,
          schema: ref.schema,
          payload: ref.value,
          fingerprint: ref.digest,
        },
      }
    }),
    outbox: [],
  })
}
export async function prepareReleaseProducerPublication(
  facts: ReleaseProducerFacts,
  port: ReleaseProducerCommitPort,
  context: CallContext,
  identityExpiresAt = context.deadline,
) {
  const captured = captureReleaseProducerContents(facts, null, port, identityExpiresAt, context.deadline)
  const objects = []
  for (const row of captured.contents) {
    const reference = await port.objects.retain(row.body, context)
    requireRelease(
      reference.location.digest === row.digest && reference.location.bytes === row.body.length,
      'producer_object_mismatch',
      '/publication/storage',
    )
    objects.push({ kind: row.kind, reference })
  }
  const releaseRow = captured.payload.content.find((row) => row.role === 'release-set')
  const releaseReference = objects.find(
    (row) => row.kind === 'json' && row.reference.location.digest === releaseRow?.digest,
  )?.reference
  requireRelease(releaseReference, 'producer_original_bytes_missing', '/publication/release')
  const request = publicationRequest(facts, port, releaseReference)
  captured.payload.memberFingerprints = request.mutations.map(digest)
  captured.payload.requiredDigests = externalPublicationRequiredDigests(captured.payload, captured.contents)
  const source = await port.objects.retain(Buffer.from(jcs({ payload: captured.payload, objects })), context)
  const references = {
    release: releaseReference,
    source,
    members: request.mutations.map((row) => ({ recordId: row.recordId, fingerprint: digest(row) })),
  }
  const proof = encodeExternalPublicationReferences(references)
  return { request, captured, proof, references }
}
async function verifyPublication(
  original: ProducerPublication,
  port: ReleaseProducerCommitPort,
  context: CallContext,
): Promise<ReleaseProducerFacts> {
  const references = readExternalPublicationReferences(original.source)
  requireRelease(references.source, 'producer_original_bytes_missing', '/publication/source')
  const checkedRead = async (reference: RetainedPublicationObject) => {
    const body = await port.objects.read(reference, context)
    requireRelease(
      publicationBytesDigest(body) === reference.location.digest && body.length === reference.location.bytes,
      'producer_object_mismatch',
      '/publication/storage',
    )
    return body
  }
  const manifest = readExternalPublicationManifest(await checkedRead(references.source))
  const contents: PublicationContentBytes[] = []
  for (const row of manifest.objects) {
    const body = await checkedRead(row.reference)
    requireRelease(
      publicationBytesDigest(body) === row.reference.location.digest &&
        body.length === row.reference.location.bytes,
      'producer_object_mismatch',
      '/publication/storage',
    )
    contents.push({ kind: row.kind, digest: row.reference.location.digest, body })
  }
  const releaseRow = manifest.payload.content.find((row) => row.role === 'release-set')
  requireRelease(
    manifest.objects.some(
      (row) =>
        row.kind === 'json' &&
        row.reference.location.digest === releaseRow?.digest &&
        equal(row.reference, references.release),
    ),
    'producer_source_mismatch',
    '/publication/release',
  )
  const releaseBytes = await checkedRead(references.release)
  const facts = readRetainedProducerFacts(manifest.payload, contents)
  requireRelease(
    Buffer.from(releaseBytes).equals(Buffer.from(jcs(facts.release))),
    'producer_source_mismatch',
    '/publication/release',
  )
  const request = readWire('MaintenanceStoreCommitRequest', original.request)
  const receipt = readWire('MaintenanceStoreCommitResult', original.receipt)
  const expected = publicationRequest(facts, port, references.release)
  requireRelease(
    equal(request, expected) &&
      equal(
        references.members,
        request.mutations.map((row) => ({ recordId: row.recordId, fingerprint: digest(row) })),
      ) &&
      equal(manifest.payload.memberFingerprints, request.mutations.map(digest)) &&
      receipt.transactionId === request.transactionId &&
      receipt.revisions.length === request.mutations.length &&
      new Set(receipt.revisions.map((row) => row.recordId)).size === receipt.revisions.length &&
      receipt.revisions.every((row) =>
        request.mutations.some(
          (member) => member.recordId === row.recordId && member.next.revision === row.revision,
        ),
      ),
    'producer_commit_mismatch',
    '/publication/commit',
  )
  requireRelease(
    equal(facts.binding.stateAuthorityAtCreation, port.stateAuthority) &&
      equal(facts.producer, port.producer) &&
      equal(facts.scope, port.scope) &&
      equal(JSON.parse(manifest.payload.maintenanceAuthorityJson), port.authority) &&
      manifest.payload.transactionId === request.transactionId,
    'producer_source_mismatch',
    '/publication/source',
  )
  return facts
}

/** Detached producer. Original native issuance and startup registration require the installer. */
export function createReleaseProducer(
  deploymentDirectory: string,
  port?: ReleaseProducerCommitPort,
  installation?: InstalledReleaseProducer,
) {
  let disposed = false
  let writing: Promise<unknown> = Promise.resolve()
  const lifetime = new AbortController()
  const permitted = (context: CallContext): ReleaseProducerCommitPort => {
    requireRelease(!disposed && !context.signal.aborted, 'producer_cancelled', '/publication')
    requireRelease(port, 'producer_commit_port_missing', '/publication')
    requireRelease(
      port.writerEpoch > 0 &&
        Number.isSafeInteger(port.writerEpoch) &&
        port.authority.tenantId === port.stateAuthority.tenantId &&
        context.bindingId === port.producer.bindingId &&
        equal(context.scope, port.scope),
      'producer_context_mismatch',
      '/publication',
    )
    requireRelease(
      Date.parse(readWire('Timestamp', context.deadline)) > Date.parse(readWire('Timestamp', port.now())),
      'producer_qualification_expired',
      '/publication',
    )
    return port
  }
  const accept = async (
    original: ProducerPublication,
    context: CallContext,
    originalPort: ReleaseProducerCommitPort,
  ) => {
    const facts = await verifyPublication(original, originalPort, context)
    // Preserve the exact native result pointer. Never substitute the codec's detached receipt.
    if (installation) await installation.issuer.acceptOriginalReceipt(original.receipt, context)
    else await originalPort.acceptPublishedAdmissionRelease(original.receipt, context)
    return { receipt: original.receipt, source: original.source, facts }
  }
  return {
    async ready(): Promise<Outcome<never>> {
      return maintenanceOutcome(async () => {
        requireRelease(port, 'producer_commit_port_missing', '/publication')
        requireRelease(false, 'producer_native_issuer_missing', '/publication')
        throw new Error('unreachable')
      })
    },
    publish(context: CallContext) {
      const operation = writing.then(() =>
        maintenanceOutcome(async () => {
          if (installation) assertOriginalInstalledReleaseProducer(installation)
          const selected = permitted(context)
          requireRelease(
            !installation || context === installation.initialContext,
            'producer_context_mismatch',
            '/publication/context',
          )
          const source = readProducerDeployment(deploymentDirectory)
          const transactionId = `publish:${source.plan.targetReleaseSet.releaseSetId}`
          const prior = await selected.readPublication(transactionId, context)
          if (prior) {
            const fixed = await verifyPublication(prior, selected, context)
            requireRelease(
              fixed.sourceFingerprint === source.sourceFingerprint,
              'producer_fingerprint_conflict',
              '/publication/replay',
            )
            source.deployment.preClock()
            permitted(context)
            return accept(prior, context, selected)
          }
          const facts =
            installation?.initialFacts ??
            (await resolveProducerSource(
              source,
              selected.stateAuthority,
              selected.now(),
              context.deadline,
              selected.producer,
              selected.scope,
            ))
          permitted(context)
          requireRelease(!lifetime.signal.aborted, 'producer_cancelled', '/publication')
          let request: MaintenanceStoreCommitRequest
          let captured: ReturnType<typeof captureReleaseProducerContents>
          let proof: DataRef
          try {
            const prepared = installation
              ? await installation.prepareOriginal()
              : await prepareReleaseProducerPublication(facts, selected, context)
            request = prepared.request
            captured = prepared.captured
            proof = prepared.proof
          } catch (error) {
            releaseResolvedProducerSource(facts)
            throw error
          }
          originalRequests.set(request, {
            context,
            source: proof,
            qualifiedUntil: captured.payload.qualifiedUntil,
            preClock: () => {
              if (installation) assertOriginalInstalledReleaseProducer(installation)
              source.deployment.preClock()
              requireRelease(
                Date.parse(selected.now()) < Date.parse(captured.payload.qualifiedUntil),
                'producer_qualification_expired',
                '/publication',
              )
              requireRelease(
                !disposed && !context.signal.aborted && !lifetime.signal.aborted,
                'producer_cancelled',
                '/publication',
              )
            },
          })
          try {
            const outcome = await selected.store.commit(request, context)
            if (!outcome.ok) throw new MaintenanceFailure(outcome.error)
            permitted(context)
            return accept({ request, receipt: outcome.value, source: proof }, context, selected)
          } catch (error) {
            // An unknown native result only probes its original commit; it never resubmits mutations.
            const committed = await selected.readPublication(transactionId, context)
            if (!committed) throw error
            requireRelease(
              equal(committed.source, proof),
              'producer_fingerprint_conflict',
              '/publication/replay',
            )
            permitted(context)
            return accept(committed, context, selected)
          } finally {
            originalRequests.delete(request)
            releaseResolvedProducerSource(facts)
          }
        }),
      )
      writing = operation.then(() => undefined)
      return operation
    },
    async recover(transactionId: string, context: CallContext) {
      return maintenanceOutcome(async () => {
        const selected = permitted(context)
        const original = await selected.readPublication(readWire('Id', transactionId), context)
        requireRelease(original, 'producer_publication_missing', '/publication/recovery')
        return accept(original, context, selected)
      })
    },
    async dispose() {
      disposed = true
      lifetime.abort()
      await writing
    },
  }
}
