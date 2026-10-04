import type { CallContext, MaintenanceStore, Outcome } from '@agnes/extension-api/runtime'
import type {
  BindingRef,
  DataRef,
  MaintenanceStoreCommitRequest,
  MaintenanceStoreCommitResult,
  ScopeRef,
  StateAuthorityRef,
} from '@agnes/protocol/runtime'
import {
  journalMutation,
  MaintenanceFailure,
  maintenanceOutcome,
  readReleaseSnapshot,
  releaseSnapshot,
} from './maintenance-journal.js'
import { equal, freeze, readWire, requireRelease } from './primitives.js'
import {
  producerFactsRef,
  type ReleaseProducerFacts,
  readProducerDeployment,
  readProducerFacts,
  resolveProducerSource,
} from './release-producer-source.js'

/** Private original-reader seam. A native installer must authenticate it; ordinary JSON is insufficient. */
export interface ProducerPublication {
  request: MaintenanceStoreCommitRequest
  receipt: MaintenanceStoreCommitResult
  source: DataRef
}
export interface ReleaseProducerCommitPort {
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
  return freeze({ source: original.source, qualifiedUntil: original.qualifiedUntil })
}

function publicationRequest(
  facts: ReleaseProducerFacts,
  port: ReleaseProducerCommitPort,
): MaintenanceStoreCommitRequest {
  const transactionId = `publish:${facts.release.releaseSetId}`,
    now = facts.observations.now
  const directory = {
    ...facts.observations.directory,
    routeRevision: 1,
    releaseSetId: facts.release.releaseSetId,
  }
  const head = {
    directory,
    jointDomains: facts.observations.jointDomains,
    migrations: facts.observations.migrations,
    stateAuthorityRef: facts.binding.stateAuthorityAtCreation,
  }
  const route = {
    routeId: directory.routeId,
    activeReleaseSetId: facts.release.releaseSetId,
    authorityEpoch: facts.binding.stateAuthorityAtCreation.authorityEpoch,
    cutoverId: transactionId,
  }
  return readWire('MaintenanceStoreCommitRequest', {
    transactionId,
    authority: port.authority,
    expectedWriterEpoch: port.writerEpoch,
    mutations: [
      journalMutation(port, port.headRecordId, 'current-head', head, null, now),
      journalMutation(port, `release-route:${directory.routeId}`, 'release-route', route, null, now),
      journalMutation(
        port,
        `release:${facts.release.releaseSetId}`,
        'release-snapshot',
        releaseSnapshot(facts.release),
        null,
        now,
      ),
    ],
    outbox: [],
  })
}
function verifyPublication(
  original: ProducerPublication,
  port: ReleaseProducerCommitPort,
): ReleaseProducerFacts {
  const facts = readProducerFacts(readWire('DataRef', original.source))
  const request = readWire('MaintenanceStoreCommitRequest', original.request)
  const receipt = readWire('MaintenanceStoreCommitResult', original.receipt)
  const expected = publicationRequest(facts, port)
  requireRelease(
    equal(request, expected) &&
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
  const release = request.mutations[2]
  requireRelease(
    release &&
      equal(readReleaseSnapshot(release.next), facts.release) &&
      equal(facts.binding.stateAuthorityAtCreation, port.stateAuthority) &&
      equal(facts.producer, port.producer) &&
      equal(facts.scope, port.scope),
    'producer_source_mismatch',
    '/publication/source',
  )
  return facts
}

/** Detached provisional producer. No startup registration; production readiness always refuses. */
export function createReleaseProducer(deploymentDirectory: string, port?: ReleaseProducerCommitPort) {
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
    const facts = verifyPublication(original, originalPort)
    // Preserve the exact native result pointer. Never substitute the codec's detached receipt.
    await originalPort.acceptPublishedAdmissionRelease(original.receipt, context)
    return { receipt: original.receipt, source: original.source, facts }
  }
  return {
    async ready(): Promise<Outcome<never>> {
      return maintenanceOutcome(async () => {
        requireRelease(port, 'producer_commit_port_missing', '/publication')
        requireRelease(false, 'producer_codec_confirmation_pending', '/publication')
        throw new Error('unreachable')
      })
    },
    publish(context: CallContext) {
      const operation = writing.then(() =>
        maintenanceOutcome(async () => {
          const selected = permitted(context)
          const source = readProducerDeployment(deploymentDirectory)
          const transactionId = `publish:${source.plan.targetReleaseSet.releaseSetId}`
          const prior = await selected.readPublication(transactionId, context)
          if (prior) {
            const fixed = verifyPublication(prior, selected)
            requireRelease(
              fixed.sourceFingerprint === source.sourceFingerprint,
              'producer_fingerprint_conflict',
              '/publication/replay',
            )
            source.deployment.preClock()
            permitted(context)
            return accept(prior, context, selected)
          }
          const facts = await resolveProducerSource(
            source,
            selected.stateAuthority,
            selected.now(),
            context.deadline,
            selected.producer,
            selected.scope,
          )
          permitted(context)
          requireRelease(!lifetime.signal.aborted, 'producer_cancelled', '/publication')
          const request = publicationRequest(facts, selected),
            proof = producerFactsRef(facts)
          originalRequests.set(request, {
            context,
            source: proof,
            qualifiedUntil: facts.qualifiedUntil,
            preClock: () => {
              source.deployment.preClock()
              requireRelease(
                Date.parse(selected.now()) < Date.parse(facts.qualifiedUntil),
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
