import type {
  ActionProviderFactory,
  CallContext,
  LoopReadPorts,
  Outcome,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import {
  access,
  caught,
  failure,
  pack,
  type ReferenceAccess,
  ReferenceRefusal,
  unpack,
  visibility,
} from './memory-store.js'

export interface ReferenceRemoteAccess extends ReferenceAccess {
  remote?: { state: W.BindingRef; select(ref: W.ResourceRef, context: CallContext): W.BindingRef | null }
  memory: { call(operation: string, request: unknown, context: CallContext): Promise<Outcome<unknown>> }
}
export const referenceRemoteCodec: W.StateCodecRef = {
  namespace: 'agh.reference/retrieval-remote',
  codecVersion: '1',
  schema: {
    typeId: 'agh.reference/retrieval-continuation@1',
    revision: 1,
    digest: canonicalJsonDigest({
      type: 'object',
      additionalProperties: false,
      required: ['digest', 'binding'],
      properties: { digest: { type: 'string' }, binding: { anyOf: [{ type: 'object' }, { type: 'null' }] } },
    }),
  },
}
export function referenceRemoteAction(
  policy: ReferenceRemoteAccess,
  parent: ServiceProvider,
  owner: W.BindingRef,
  lifetime: AbortSignal,
): ActionProviderFactory {
  return {
    stateCodec: referenceRemoteCodec,
    recovery: 'R2',
    kind: 'composite',
    async create(handler) {
      const inProgress = new Set<string>()
      const controller = new AbortController(),
        schemas = RuntimeMethodSchemaRefs['agh.retrieval'].searchRemote
      async function advance(
        frame: W.ActionFrame,
        reader: LoopReadPorts,
        recovering: boolean,
      ): Promise<W.ProviderTransition> {
        let selected: W.BindingRef | null = null
        const context: CallContext = {
          ...frame.context,
          signal: AbortSignal.any([controller.signal, handler.signal, lifetime]),
        }
        const packageTransition = (
          next: W.NextStep,
          children: W.PreparedAction[] = [],
        ): W.ProviderTransition => {
          const encoded = pack(referenceRemoteCodec.schema, { digest: frame.inputDigest, binding: selected })
          if (!encoded.ok) throw new Error('reference continuation budget')
          return {
            expectedProviderRevision: frame.providerRevision,
            consumeSignals: [],
            children,
            next,
            continuation: {
              data: encoded.value,
              namespace: referenceRemoteCodec.namespace,
              codecVersion: '1',
              provenance: { producer: owner, trustLabels: [], sourceRefs: [] },
              createdAt: frame.observedAt,
              references: [],
            },
          }
        }
        const waiting: W.NextStep = {
          kind: 'wait',
          condition: {
            deadline: context.deadline,
            anyOf: [
              {
                kind: 'actions',
                actions: [{ localKey: 'remote-search' }],
                readyWhen: 'resolved',
                mode: 'all',
              },
            ],
          },
        }
        try {
          const readiness = await parent.ready(context)
          if (!readiness.ok) throw new ReferenceRefusal(readiness.error.code, readiness.error.detailCode)
          access(policy, context, controller.signal.aborted)
          if (
            handler.bindingId !== owner.bindingId ||
            handler.runId !== frame.runId ||
            frame.method !== 'searchRemote' ||
            frame.bindingId !== owner.bindingId ||
            frame.actionId !== handler.actionId ||
            frame.inputDigest !== (frame.input.kind === 'blob' ? frame.input.blob.digest : frame.input.digest)
          )
            throw new ReferenceRefusal('denied', 'retrieval_binding_denied')
          const raw = unpack(frame.input, schemas.input),
            request = raw.ok ? validateRuntime('RetrievalSearchRemoteRequest', raw.value) : raw
          if (
            !request.ok ||
            !('topK' in request.value) ||
            request.value.topK === 0 ||
            request.value.topK > 100
          )
            throw new ReferenceRefusal('invalid_input', 'retrieval_input_schema')
          if (request.value.embeddingRoute !== null)
            throw new ReferenceRefusal('incompatible', 'retrieval_embedding_unavailable')
          if (!policy.remote || !visibility(policy, 'searchRemote', null, context))
            throw new ReferenceRefusal('denied', 'retrieval_remote_denied')
          selected = structuredClone(policy.remote.select(structuredClone(request.value.targetRef), context))
          if (
            !selected ||
            !validateRuntime('BindingRef', selected).ok ||
            selected.contract !== 'agh.retrieval' ||
            selected.bindingId === owner.bindingId
          )
            throw new ReferenceRefusal('denied', 'retrieval_remote_denied')
          if (!recovering) {
            if (frame.continuation) throw new ReferenceRefusal('conflict', 'retrieval_continuation_conflict')
            const child = reader.prepare({
              method: 'searchRemote',
              key: 'remote-search',
              target: selected,
              input: frame.input,
              resultSchema: schemas.output,
              deadline: context.deadline,
              obligation: 'mandatory',
              retry: { maxAttempts: 1, backoffMs: [], mode: 'never' },
              dependencies: [],
              references: [],
            })
            if (!child.ok) throw new ReferenceRefusal(child.error.code, child.error.detailCode)
            return packageTransition(waiting, [child.value])
          }
          const checkpoint = frame.continuation
          if (
            !checkpoint ||
            checkpoint.namespace !== referenceRemoteCodec.namespace ||
            checkpoint.codecVersion !== '1'
          )
            throw new ReferenceRefusal('conflict', 'retrieval_continuation_conflict')
          const previous = unpack(checkpoint.data, referenceRemoteCodec.schema)
          if (
            !previous.ok ||
            canonicalJsonDigest(previous.value as W.JsonValue) !==
              canonicalJsonDigest({ digest: frame.inputDigest, binding: selected })
          )
            throw new ReferenceRefusal('conflict', 'retrieval_continuation_conflict')
          for (const receipt of frame.receipts.items) {
            const spec = RuntimeMethodSchemaRefs['agh.state'].probeActionResult,
              queryInput = pack(spec.input, {
                sourceReceiptId: receipt.receiptId,
                actionId: receipt.actionId,
              })
            if (!queryInput.ok) throw new ReferenceRefusal(queryInput.error.code, queryInput.error.detailCode)
            const reply = await awaitRemote(
              reader.query({
                target: policy.remote.state,
                input: queryInput.value,
                method: 'probeActionResult',
              }),
              context,
            )
            access(policy, context, controller.signal.aborted)
            if (!reply.ok) throw new ReferenceRefusal(reply.error.code, 'retrieval_remote_result_unavailable')
            if (reply.value.kind === 'refresh_required') continue
            const rawView = unpack(reply.value.output, spec.output),
              published = rawView.ok ? validateRuntime('ProbeActionResultResult', rawView.value) : rawView
            if (!published.ok) throw new ReferenceRefusal('incompatible', 'retrieval_remote_result_invalid')
            if (!published.value || published.value.state === 'pending') continue
            const visible = published.value.result
            if (
              visible.inputDigest !== frame.inputDigest ||
              visible.bindingId !== selected.bindingId ||
              visible.actionId !== receipt.actionId ||
              visible.sourceReceiptId !== receipt.receiptId
            )
              continue
            if (!visible.result || visible.outcome !== 'succeeded')
              return packageTransition({
                kind: 'fail',
                error:
                  visible.error ||
                  failure(
                    visible.outcome === 'unknown_effect' ? 'unknown_effect' : 'denied',
                    'retrieval_remote_failed',
                  ).error,
              })
            const rawResult = unpack(visible.result, schemas.output),
              result = rawResult.ok
                ? validateRuntime('RetrievalSearchRemoteResult', rawResult.value)
                : rawResult
            if (!result.ok) throw new ReferenceRefusal('incompatible', 'retrieval_remote_result_invalid')
            const memory = await awaitRemote(
              policy.memory.call('get', { atRevision: null, ids: [] }, context),
              context,
            )
            access(policy, context, controller.signal.aborted)
            if (!memory.ok) throw new ReferenceRefusal(memory.error.code, 'retrieval_memory_unavailable')
            const current = validateRuntime('MemoryGetResult', memory.value)
            if (!current.ok) throw new ReferenceRefusal('incompatible', 'retrieval_memory_invalid')
            const hits = result.value.hits
              .filter((hit) => {
                if (hit.ref.kind === 'domain' && hit.ref.value.typeId === 'agh.memory/item@1')
                  return current.value.items.some(
                    (item) =>
                      canonicalJsonDigest(item.ref) ===
                        canonicalJsonDigest(hit.ref.kind === 'domain' ? hit.ref.value : null) &&
                      visibility(policy, 'get', item, context),
                  )
                return policy.sourceAvailable(hit.ref, hit.trust, context) === true
              })
              .slice(0, request.value.topK)
            const packed = pack(schemas.output, { ...result.value, hits })
            if (!packed.ok) throw new ReferenceRefusal(packed.error.code, packed.error.detailCode)
            return packageTransition({ kind: 'complete', output: packed.value, references: [] })
          }
          return packageTransition(waiting)
        } catch (exception) {
          return packageTransition({ kind: 'fail', error: caught(exception, 'retrieval').error })
        }
      }
      return {
        kind: 'composite',
        async ready(context) {
          return controller.signal.aborted ? failure('denied', 'provider_closed') : parent.ready(context)
        },
        async health(context) {
          return controller.signal.aborted ? failure('denied', 'provider_closed') : parent.health(context)
        },
        async drain(_expires, context) {
          const status = await parent.ready(context)
          if (!status.ok) return status
          controller.abort()
          return {
            ok: true,
            value: {
              state: inProgress.size ? 'blocked' : 'drained',
              activeInvocationIds: Array.from(inProgress),
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        async close() {
          controller.abort()
        },
        async start(frame, reader) {
          inProgress.add(frame.invocationId)
          try {
            return await advance(frame, reader, false)
          } finally {
            inProgress.delete(frame.invocationId)
          }
        },
        async resume(frame, reader) {
          inProgress.add(frame.invocationId)
          try {
            return await advance(frame, reader, true)
          } finally {
            inProgress.delete(frame.invocationId)
          }
        },
      }
    },
  }
}
async function awaitRemote<T>(pending: Promise<T>, context: CallContext): Promise<T> {
  const expires = new AbortController(),
    timeout = setTimeout(
      () => expires.abort(),
      Math.min(2147483647, Math.max(1, Date.parse(context.deadline) - Date.now())),
    )
  const token = AbortSignal.any([expires.signal, context.signal])
  let cancel = () => {}
  const cancelled = new Promise<never>((_done, reject) => {
    cancel = () => reject(new ReferenceRefusal('cancelled', 'request_cancelled'))
    if (token.aborted) cancel()
    else token.addEventListener('abort', cancel, { once: true })
  })
  try {
    return await Promise.race([pending, cancelled])
  } finally {
    clearTimeout(timeout)
    token.removeEventListener('abort', cancel)
  }
}
