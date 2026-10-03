import type {
  ActionProviderFactory,
  CallContext,
  LoopReadPorts,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import {
  allowed,
  checkAccess,
  decode,
  inline,
  interrupted,
  type MemoryAccess,
  MemoryFault,
  refused,
} from '../memory/access.js'

export interface RemoteRetrievalAccess extends MemoryAccess {
  remote?: {
    /** Selected State service supplying ready, Hook-processed child result views. */
    state: W.BindingRef
    /** Resolve exact ResourceRef/version/digest under current authority; null means refused. */
    select(target: W.ResourceRef, context: CallContext): W.BindingRef | null
  }
  memory: {
    call(
      method: string,
      input: unknown,
      context: CallContext,
    ): Promise<import('@agnes/extension-api/runtime').Outcome<unknown>>
  }
}
const stateShape = {
  type: 'object',
  additionalProperties: false,
  required: ['request', 'target'],
  properties: { request: { type: 'string' }, target: { anyOf: [{ type: 'object' }, { type: 'null' }] } },
}
export const remoteRetrievalCodec: W.StateCodecRef = {
  namespace: 'agh.default/retrieval-remote',
  codecVersion: '1',
  schema: {
    typeId: 'agh.retrieval/remote-continuation@1',
    revision: 1,
    digest: canonicalJsonDigest(stateShape),
  },
}

export function remoteRetrievalAction(
  options: RemoteRetrievalAccess,
  service: ServiceProvider,
  binding: W.BindingRef,
  lifetime: AbortSignal,
): ActionProviderFactory {
  return {
    kind: 'composite',
    recovery: 'R2',
    stateCodec: remoteRetrievalCodec,
    async create(scope) {
      const stop = new AbortController(),
        active = new Set<string>()
      async function step(
        frame: W.ActionFrame,
        ports: LoopReadPorts,
        resumed: boolean,
      ): Promise<W.ProviderTransition> {
        const ctx: CallContext = {
          ...frame.context,
          signal: AbortSignal.any([scope.signal, stop.signal, lifetime]),
        }
        let target: W.BindingRef | null = null
        const state = () => {
          const data = inline(remoteRetrievalCodec.schema, { request: frame.inputDigest, target })
          if (!data.ok) throw new MemoryFault(data.error.code, data.error.detailCode)
          return {
            namespace: remoteRetrievalCodec.namespace,
            codecVersion: '1',
            data: data.value,
            provenance: { sourceRefs: [], producer: binding, trustLabels: [] },
            createdAt: frame.observedAt,
            references: [],
          }
        }
        const transition = (next: W.NextStep, children: W.PreparedAction[] = []): W.ProviderTransition => ({
          expectedProviderRevision: frame.providerRevision,
          continuation: state(),
          consumeSignals: [],
          children,
          next,
        })
        const key = 'remote-search'
        const wait = (): W.NextStep => ({
          kind: 'wait',
          condition: {
            anyOf: [{ kind: 'actions', mode: 'all', actions: [{ localKey: key }], readyWhen: 'resolved' }],
            deadline: frame.context.deadline,
          },
        })
        try {
          const ready = await service.ready(ctx)
          if (!ready.ok) throw new MemoryFault(ready.error.code, ready.error.detailCode)
          checkAccess(options, ctx, stop.signal.aborted)
          if (
            scope.bindingId !== binding.bindingId ||
            frame.runId !== scope.runId ||
            frame.actionId !== scope.actionId ||
            frame.bindingId !== binding.bindingId ||
            frame.method !== 'searchRemote' ||
            frame.inputDigest !==
              (frame.input.kind === 'inline' ? frame.input.digest : frame.input.blob.digest)
          )
            throw new MemoryFault('denied', 'retrieval_binding_denied')
          const decoded = decode(frame.input, RuntimeMethodSchemaRefs['agh.retrieval'].searchRemote.input)
          if (!decoded.ok) throw new MemoryFault(decoded.error.code, decoded.error.detailCode)
          const parsed = validateRuntime('RetrievalSearchRemoteRequest', decoded.value)
          if (!parsed.ok || parsed.value.topK < 1 || parsed.value.topK > 100)
            throw new MemoryFault('invalid_input', 'retrieval_input_schema')
          if (parsed.value.embeddingRoute !== null)
            throw new MemoryFault('incompatible', 'retrieval_embedding_unavailable')
          if (!options.remote || !allowed(options, 'searchRemote', null, ctx))
            throw new MemoryFault('denied', 'retrieval_remote_denied')
          target = structuredClone(options.remote.select(structuredClone(parsed.value.targetRef), ctx))
          if (
            !target ||
            !validateRuntime('BindingRef', target).ok ||
            target.contract !== 'agh.retrieval' ||
            target.bindingId === binding.bindingId
          )
            throw new MemoryFault('denied', 'retrieval_remote_denied')
          if (!resumed) {
            if (frame.continuation !== null)
              throw new MemoryFault('conflict', 'retrieval_continuation_conflict')
            const child = ports.prepare({
              key,
              target,
              method: 'searchRemote',
              input: frame.input,
              dependencies: [],
              retry: { mode: 'never', maxAttempts: 1, backoffMs: [] },
              obligation: 'mandatory',
              deadline: ctx.deadline,
              resultSchema: RuntimeMethodSchemaRefs['agh.retrieval'].searchRemote.output,
              references: [],
            })
            if (!child.ok) throw new MemoryFault(child.error.code, child.error.detailCode)
            return transition(wait(), [child.value])
          }
          const saved = frame.continuation
          if (!saved || saved.namespace !== remoteRetrievalCodec.namespace || saved.codecVersion !== '1')
            throw new MemoryFault('conflict', 'retrieval_continuation_conflict')
          const previous = decode(saved.data, remoteRetrievalCodec.schema)
          if (
            !previous.ok ||
            canonicalJsonDigest(previous.value as W.JsonValue) !==
              canonicalJsonDigest({ request: frame.inputDigest, target })
          )
            throw new MemoryFault('conflict', 'retrieval_continuation_conflict')
          for (const receipt of frame.receipts.items) {
            const queryInput = inline(RuntimeMethodSchemaRefs['agh.state'].probeActionResult.input, {
              actionId: receipt.actionId,
              sourceReceiptId: receipt.receiptId,
            })
            if (!queryInput.ok) throw new MemoryFault(queryInput.error.code, queryInput.error.detailCode)
            const response = await interrupted(
              ports.query({
                target: options.remote.state,
                method: 'probeActionResult',
                input: queryInput.value,
              }),
              ctx,
            )
            checkAccess(options, ctx, stop.signal.aborted)
            if (!response.ok)
              throw new MemoryFault(response.error.code, 'retrieval_remote_result_unavailable')
            if (response.value.kind !== 'value') continue
            const decodedView = decode(
              response.value.output,
              RuntimeMethodSchemaRefs['agh.state'].probeActionResult.output,
            )
            const view = decodedView.ok
              ? validateRuntime('ProbeActionResultResult', decodedView.value)
              : decodedView
            if (!view.ok) throw new MemoryFault('incompatible', 'retrieval_remote_result_invalid')
            if (view.value === null || view.value.state !== 'ready') continue
            const result = view.value.result
            if (
              result.actionId !== receipt.actionId ||
              result.sourceReceiptId !== receipt.receiptId ||
              result.bindingId !== target.bindingId ||
              result.inputDigest !== frame.inputDigest
            )
              continue
            if (result.outcome !== 'succeeded' || !result.result)
              return transition({
                kind: 'fail',
                error:
                  result.error ??
                  refused(
                    result.outcome === 'unknown_effect' ? 'unknown_effect' : 'denied',
                    'retrieval_remote_failed',
                  ).error,
              })
            const data = decode(result.result, RuntimeMethodSchemaRefs['agh.retrieval'].searchRemote.output),
              output = data.ok ? validateRuntime('RetrievalSearchRemoteResult', data.value) : data
            if (!output.ok) throw new MemoryFault('incompatible', 'retrieval_remote_result_invalid')
            const memories = await interrupted(
              options.memory.call('get', { ids: [], atRevision: null }, ctx),
              ctx,
            )
            checkAccess(options, ctx, stop.signal.aborted)
            if (!memories.ok) throw new MemoryFault(memories.error.code, 'retrieval_memory_unavailable')
            const current = validateRuntime('MemoryGetResult', memories.value)
            if (!current.ok) throw new MemoryFault('incompatible', 'retrieval_memory_invalid')
            const hits = output.value.hits
              .filter((hit) =>
                hit.ref.kind === 'domain' && hit.ref.value.typeId === 'agh.memory/item@1'
                  ? current.value.items.some(
                      (item) =>
                        canonicalJsonDigest(item.ref) ===
                          canonicalJsonDigest(hit.ref.kind === 'domain' ? hit.ref.value : null) &&
                        allowed(options, 'get', item, ctx),
                    )
                  : options.sourceAvailable(hit.ref, hit.trust, ctx) === true,
              )
              .slice(0, parsed.value.topK)
            const encoded = inline(RuntimeMethodSchemaRefs['agh.retrieval'].searchRemote.output, {
              ...output.value,
              hits,
            })
            if (!encoded.ok) throw new MemoryFault(encoded.error.code, encoded.error.detailCode)
            return transition({ kind: 'complete', output: encoded.value, references: [] })
          }
          return transition(wait())
        } catch (error) {
          return transition({
            kind: 'fail',
            error:
              error instanceof MemoryFault
                ? refused(error.code, error.detail).error
                : refused('retryable', 'retrieval_dependency_unavailable').error,
          })
        }
      }
      return {
        kind: 'composite',
        async ready(ctx) {
          return stop.signal.aborted ? refused('denied', 'provider_closed') : service.ready(ctx)
        },
        async health(ctx) {
          return stop.signal.aborted ? refused('denied', 'provider_closed') : service.health(ctx)
        },
        async drain(_deadline, ctx) {
          const ready = await service.ready(ctx)
          if (!ready.ok) return ready
          stop.abort()
          return {
            ok: true,
            value: {
              state: active.size ? 'blocked' : 'drained',
              activeInvocationIds: [...active],
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        async close() {
          stop.abort()
        },
        async start(frame, ports) {
          active.add(frame.invocationId)
          try {
            return await step(frame, ports, false)
          } finally {
            active.delete(frame.invocationId)
          }
        },
        async resume(frame, ports) {
          active.add(frame.invocationId)
          try {
            return await step(frame, ports, true)
          } finally {
            active.delete(frame.invocationId)
          }
        },
      }
    },
  }
}
