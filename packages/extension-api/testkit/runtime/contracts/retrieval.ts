import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, LoopReadPorts, Outcome, ServiceProvider } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs } from '@agnes/protocol/runtime'
import { SCENARIOS, type ScenarioName } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'
import {
  insistMemory,
  type MemoryContractBinding,
  type MemoryContractOptions,
  type MemoryContractSubject,
  memoryActionFrame,
  memoryContext,
  memoryData,
  memoryDetail,
  memoryOptions,
  memoryRequest,
  memoryScope,
  memoryValue,
} from './memory.js'

export interface RetrievalContractOptions extends MemoryContractOptions {
  memory: Pick<MemoryContractSubject, 'call'>
  remote?: { state: W.BindingRef; select(target: W.ResourceRef, context: CallContext): W.BindingRef | null }
}
export interface RemoteRetrievalFixture {
  remote: NonNullable<RetrievalContractOptions['remote']>
  target: W.ResourceRef
  ports: LoopReadPorts
  dispatch(child: W.PreparedAction): Promise<void>
  requests(): number
  close(): Promise<void>
}
export interface RetrievalContractSubject extends ServiceProvider {
  binding: W.BindingRef
  indexRef(): W.DomainObjectRef
  replaceIndex(
    batch: {
      expectedRevision: number
      dimensions: number
      documents: readonly { memoryId: string; text: string; vector: readonly number[]; createdAt: string }[]
      queryVectors: Readonly<Record<string, readonly number[]>>
    },
    context: CallContext,
  ): Promise<Outcome<W.DomainObjectRef>>
  removeDeleted(receipt: W.DeletionReceipt): Promise<void>
  deletionWatermark(): number
  call(method: string, input: unknown, context: CallContext): Promise<Outcome<unknown>>
}
export interface RetrievalContractBinding extends Omit<MemoryContractBinding, 'create' | 'coldRead'> {
  createMemory(options: MemoryContractOptions): MemoryContractSubject
  create(options: RetrievalContractOptions): RetrievalContractSubject
  coldSearch(directory: string): Promise<{ result: Outcome<unknown>; watermark: number; pending: number }>
  remoteFixture(directory: string): Promise<RemoteRetrievalFixture>
  coldRemote(directory: string, frame: W.ActionFrame): Promise<W.ProviderTransition>
}
export async function exerciseRetrieval(
  binding: RetrievalContractBinding,
  scenario: ScenarioName,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-contract-')),
    options = memoryOptions(join(directory, 'memory')),
    memory = binding.createMemory(options),
    subject = binding.create({ ...options, directory: join(directory, 'index'), memory })
  const context = memoryContext(),
    request = memoryRequest()
  try {
    insistMemory(subject.binding.providerId === `agh.${binding.providerId}/retrieval`, 'selected Retrieval')
    const remembered = memoryValue<W.MemoryRememberResult>(
        'MemoryRememberResult',
        await memory.call(
          'remember',
          {
            ...request,
            items: [
              ...request.items,
              {
                ...request.items[0]!,
                contentRef: memoryData(request.items[0]!.contentRef.schema, 'semantic neighbour'),
              },
            ],
          },
          context,
        ),
      ),
      ids = remembered.memoryRefs.map((ref) => ref.id)
    const batch = {
      expectedRevision: 0,
      dimensions: 2,
      documents: [
        { memoryId: ids[0]!, text: 'alpha knowledge', vector: [0, 1], createdAt: '2026-01-01T00:00:00Z' },
        { memoryId: ids[1]!, text: 'semantic neighbour', vector: [1, 0], createdAt: '2026-01-02T00:00:00Z' },
      ],
      queryVectors: { alpha: [1, 0] },
    }
    insistMemory((await subject.replaceIndex(batch, context)).ok, 'durable index build')
    const query = () => ({
      queryText: 'alpha',
      indexRef: subject.indexRef(),
      topK: 100,
      filter: {},
      cursor: null,
    })
    const search = () => subject.call('search', query(), context)
    const hits = memoryValue<W.PageRetrievalHit>('PageRetrievalHit', await search())
    insistMemory(
      hits.items.length === 2 &&
        hits.items.every((hit) => hit.score > 0 && hit.source.sourceRefs.length === 1),
      'keyword and vector-only sourced candidates',
    )
    const publicQuery = await subject.query!(
      {
        target: subject.binding,
        method: 'search',
        input: memoryData(RuntimeMethodSchemaRefs['agh.retrieval'].search.input, query()),
      },
      context,
    )
    insistMemory(publicQuery.ok && publicQuery.value.kind === 'value', 'public query SPI')
    if (scenario === 'normal') {
      const page = memoryValue<W.PageRetrievalHit>(
        'PageRetrievalHit',
        await subject.call('search', { ...query(), topK: 1 }, context),
      )
      const next = memoryValue<W.PageRetrievalHit>(
        'PageRetrievalHit',
        await subject.call('search', { ...query(), topK: 1, cursor: page.nextCursor }, context),
      )
      insistMemory(
        page.items.length === 1 &&
          next.items.length === 1 &&
          next.complete &&
          canonicalJsonDigest(page.items[0]!.ref) !== canonicalJsonDigest(next.items[0]!.ref),
        'bounded stable pages',
      )
      const empty = memoryValue<W.PageRetrievalHit>(
        'PageRetrievalHit',
        await subject.call('search', { ...query(), queryText: 'absent' }, context),
      )
      insistMemory(empty.items.length === 0 && empty.complete && empty.nextCursor === null, 'empty success')
      const deleted = memoryValue<W.MemoryForgetResult>(
        'MemoryForgetResult',
        await memory.call(
          'forget',
          { memoryIds: [ids[0]], expectedRevision: 1, reason: 'withdrawn' },
          memoryContext('forget'),
        ),
      )
      insistMemory(
        memoryValue<W.PageRetrievalHit>('PageRetrievalHit', await search()).items.length === 1,
        'tombstone filtered before propagation',
      )
      await subject.removeDeleted(deleted.deletionReceipt)
      const revision = subject.indexRef().revision
      await subject.removeDeleted(deleted.deletionReceipt)
      insistMemory(
        subject.indexRef().revision === revision && subject.deletionWatermark() === 2,
        'idempotent persisted index invalidation',
      )
      memory.acknowledgeDeletion(deleted.deletionReceipt.deletionId)
      insistMemory(memory.pendingDeletions().length === 0, 'outbox acknowledgement')
    } else if (scenario === 'deny') {
      insistMemory(
        memoryDetail(
          await subject.call(
            'search',
            { ...query(), indexRef: { ...subject.indexRef(), revision: 0 } },
            context,
          ),
        ) === 'retrieval_revision_conflict',
        'stale index',
      )
      insistMemory(
        memoryDetail(
          await subject.call('search', query(), { ...context, authorizationRef: 'other-tenant' }),
        ) === 'tenant_denied',
        'tenant fenced',
      )
      insistMemory(
        memoryDetail(
          await subject.replaceIndex(
            { ...batch, expectedRevision: 1, documents: [{ ...batch.documents[0]!, vector: [1] }] },
            context,
          ),
        ) === 'retrieval_dimension_mismatch' && subject.indexRef().revision === 1,
        'dimension refusal is atomic',
      )
      insistMemory(
        memoryDetail(
          await subject.replaceIndex(
            { ...batch, expectedRevision: 1, documents: [{ ...batch.documents[0]!, memoryId: 'unowned' }] },
            context,
          ),
        ) === 'retrieval_document_denied',
        'unauthorized ingestion',
      )
      options.sourceAvailable = () => false
      insistMemory(
        memoryValue<W.PageRetrievalHit>('PageRetrievalHit', await search()).items.length === 0,
        'source revocation removes all candidates',
      )
      options.sourceAvailable = () => {
        throw new Error('source unavailable')
      }
      insistMemory(
        memoryDetail(await search()) === 'retrieval_memory_unavailable',
        'dependency failure not empty success',
      )
    } else if (scenario === 'cancel') {
      const controller = new AbortController(),
        blocked = new Promise<Outcome<unknown>>(() => {})
      const original = memory.call
      memory.call = async () => {
        controller.abort()
        return blocked
      }
      insistMemory(
        memoryDetail(await subject.call('search', query(), memoryContext('cancel', controller.signal))) ===
          'request_cancelled',
        'in-flight dependency cancellation',
      )
      memory.call = original
      insistMemory(
        memoryValue<W.PageRetrievalHit>('PageRetrievalHit', await search()).items.length === 2,
        'cancelled query leaves index unchanged',
      )
    } else if (scenario === 'recover') {
      insistMemory(
        (
          await memory.call(
            'forget',
            { memoryIds: [ids[0]], expectedRevision: 1, reason: 'restart pending' },
            memoryContext('forget'),
          )
        ).ok,
        'persist deletion before propagation',
      )
      await subject.close('shutdown')
      await memory.close('shutdown')
      const cold = await binding.coldSearch(directory),
        restored = memoryValue<W.PageRetrievalHit>('PageRetrievalHit', cold.result)
      insistMemory(
        restored.items.length === 1 && cold.watermark === 2 && cold.pending === 0,
        'cold process recovers index and propagates persisted deletion',
      )
    } else if (scenario === 'dispose') {
      const controller = new AbortController(),
        original = memory.call
      let started = () => {}
      const start = new Promise<void>((resolve) => {
        started = resolve
      })
      memory.call = async () => {
        started()
        return new Promise<Outcome<unknown>>(() => {})
      }
      const inflight = subject.call('search', query(), memoryContext('dispose', controller.signal))
      await start
      const closedQuery = query()
      await subject.close('shutdown')
      await subject.close('shutdown')
      insistMemory(memoryDetail(await inflight) === 'provider_closed', 'close interrupts pending query')
      memory.call = original
      insistMemory(
        memoryDetail(await subject.call('search', closedQuery, context)) === 'provider_closed',
        'disposed index refuses requests',
      )
    }
  } finally {
    await subject.close('shutdown')
    await memory.close('shutdown')
    rmSync(directory, { recursive: true, force: true })
  }
}
export function registerRetrievalContract(
  harness: ConformanceHarness,
  binding: RetrievalContractBinding,
): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.retrieval',
      providerId: binding.providerId,
      scenario,
      qualification: 'required',
      async run() {
        await exerciseRetrieval(binding, scenario)
        await exerciseRemoteRetrieval(binding, scenario)
        return {
          id: `agh.retrieval/${binding.providerId}/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: 'persistent-hybrid-index',
          features: ['search', 'searchRemote', 'keyword', 'vector', 'revision', 'deletion-propagation'],
          build: binding.build,
          consumer: 'retrieval-contract-consumer',
          command: binding.command,
          status: 'passed',
          configDigest: canonicalJsonDigest(memoryScope),
          releaseSetDigest: canonicalJsonDigest('memory-fixture-release'),
          attachmentDigest: canonicalJsonDigest('retrieval-contract-v1'),
          fixture: 'restricted-effects',
          sharedEvidenceId: null,
          reuse: {
            scope: 'workspace',
            methodKind: 'query',
            lifecycle:
              scenario === 'recover' || scenario === 'cancel' || scenario === 'dispose' ? scenario : 'call',
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
}
export async function exerciseRemoteRetrieval(
  binding: RetrievalContractBinding,
  scenario: ScenarioName,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-remote-')),
    options = memoryOptions(join(directory, 'memory')),
    memory = binding.createMemory(options),
    peer = await binding.remoteFixture(directory),
    index = binding.create({
      ...options,
      directory: join(directory, 'index'),
      memory,
      remote: peer.remote,
      sourceAvailable: (...args) => options.sourceAvailable(...args),
    }),
    cancellation = new AbortController()
  const handler = await index.actions!.searchRemote!.create({
    actionId: 'remote-parent',
    runId: 'fixture-run',
    bindingId: index.binding.bindingId,
    instanceId: 'fixture-instance',
    scope: options.scope,
    signal: cancellation.signal,
  })
  insistMemory(handler.kind === 'composite', 'remote is explicit composite')
  const frame = memoryActionFrame(index.binding, 'searchRemote', {
    queryText: 'alpha',
    targetRef: peer.target,
    topK: 10,
    filter: {},
    embeddingRoute: null,
  })
  try {
    const started = await handler.start(frame, peer.ports)
    insistMemory(
      started.children.length === 1 && started.next.kind === 'wait',
      'prepared external child action',
    )
    await peer.dispatch(started.children[0]!)
    const resumed: W.ActionFrame = {
      ...frame,
      providerRevision: 1,
      continuation: started.continuation,
      receipts: {
        items: [{ actionId: 'remote-child', receiptId: 'remote-receipt', outcome: 'succeeded' }],
        snapshot: 'remote-published',
        nextCursor: null,
        complete: true,
      },
    }
    if (scenario === 'cancel' || scenario === 'dispose') {
      let began = () => {}
      const waiting = new Promise<void>((resolve) => {
        began = resolve
      })
      const pending = handler.resume(resumed, {
        ...peer.ports,
        query: async () => {
          began()
          return new Promise<Outcome<W.QueryReply>>(() => {})
        },
      })
      await waiting
      if (scenario === 'cancel') cancellation.abort()
      else await handler.close('shutdown')
      insistMemory((await pending).next.kind === 'fail', 'pending result read interrupted')
      if (scenario === 'dispose')
        insistMemory(
          (await index.ready(memoryContext())).ok,
          'action disposal keeps parent service available',
        )
      if (scenario === 'dispose')
        insistMemory(!(await handler.ready(memoryContext())).ok, 'closed action is unavailable')
    } else if (scenario === 'recover') {
      await handler.close('shutdown')
      await index.close('shutdown')
      await memory.close('shutdown')
      const restored = await binding.coldRemote(directory, resumed)
      insistMemory(
        restored.children.length === 0 && restored.next.kind === 'complete',
        'new process resumes published child without reissuing effect',
      )
      insistMemory(peer.requests() === 1, 'single external effect across cold resume')
    } else {
      const complete = await handler.resume(resumed, peer.ports)
      insistMemory(
        complete.children.length === 0 &&
          complete.next.kind === 'complete' &&
          complete.next.output.kind === 'inline',
        'ready child result completes composite',
      )
      const output = memoryValue<W.RetrievalSearchRemoteResult>('RetrievalSearchRemoteResult', {
        ok: true,
        value: complete.next.output.value,
      })
      insistMemory(
        output.hits.length === 1 && output.usageRefs.length === 0 && peer.requests() === 1,
        'real HTTP result without invented usage',
      )
      if (scenario === 'deny') {
        const foreign = await handler.start({ ...frame, runId: 'foreign-run' }, peer.ports)
        insistMemory(
          foreign.next.kind === 'fail' &&
            foreign.next.error.detailCode === 'retrieval_binding_denied' &&
            foreign.children.length === 0 &&
            peer.requests() === 1,
          'foreign run cannot issue a child',
        )
        const embedding = memoryActionFrame(index.binding, 'searchRemote', {
          queryText: 'alpha',
          targetRef: peer.target,
          topK: 10,
          filter: {},
          embeddingRoute: {
            routeId: 'waiting-route',
            routeRevision: 1,
            adapter: {
              bindingId: 'waiting-adapter',
              contract: 'agh.model-adapter',
              logicalName: 'adapter',
              providerId: 'fixture/adapter',
            },
            model: 'waiting-model',
            endpointRef: 'waiting-endpoint',
            catalogRevision: 1,
            features: {
              input: ['text'],
              output: ['text'],
              tools: false,
              structuredOutput: false,
              streaming: false,
            },
            priceVersion: 'waiting-price',
            credentialAudience: 'waiting-audience',
            credentialBinding: null,
          },
        })
        const unavailable = await handler.start(embedding, peer.ports)
        insistMemory(
          unavailable.next.kind === 'fail' &&
            unavailable.next.error.detailCode === 'retrieval_embedding_unavailable' &&
            unavailable.children.length === 0,
          'Embedding explicitly waits for fixed schema',
        )
        const altered = memoryActionFrame(index.binding, 'searchRemote', {
          queryText: 'alpha',
          targetRef: { ...peer.target, digest: '0'.repeat(64) },
          topK: 10,
          filter: {},
          embeddingRoute: null,
        })
        const denied = await handler.start(altered, peer.ports)
        insistMemory(
          denied.next.kind === 'fail' &&
            denied.next.error.detailCode === 'retrieval_remote_denied' &&
            denied.children.length === 0,
          'changed target digest denied before dispatch',
        )
        options.sourceAvailable = () => false
        const empty = await handler.resume(resumed, peer.ports)
        insistMemory(
          empty.next.kind === 'complete' &&
            empty.next.output.kind === 'inline' &&
            (empty.next.output.value as { hits: unknown[] }).hits.length === 0,
          'current remote source authorization',
        )
      }
    }
  } finally {
    await handler.close('shutdown')
    await index.close('shutdown')
    await memory.close('shutdown')
    await peer.close()
    rmSync(directory, { recursive: true, force: true })
  }
}
