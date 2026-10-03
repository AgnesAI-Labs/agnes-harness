import type {
  ActionProviderFactory,
  CallContext,
  Outcome,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  access,
  caught,
  failure,
  pack,
  type ReferenceAccess,
  ReferenceRefusal,
  snapshotStore,
  unpack,
  visibility,
} from './memory-store.js'

export interface ReferenceMemoryOptions extends ReferenceAccess {
  directory: string
}
type JournalEntry = { fingerprint: string; output: W.MemoryRememberResult | W.MemoryForgetResult }
type Snapshot = {
  revision: number
  entries: W.MemoryItem[]
  journal: Record<string, JournalEntry>
  pending: W.DeletionReceipt[]
}
export function createReferenceMemory(policy: ReferenceMemoryOptions) {
  if (policy.scope.kind !== 'workspace' || !validateRuntime('ScopeRef', policy.scope).ok || !policy.tenantRef)
    throw new Error('memory_workspace_required')
  const storage = snapshotStore<Snapshot>(policy.directory, 'memory', policy, {
    revision: 0,
    entries: [],
    journal: {},
    pending: [],
  })
  const binding: W.BindingRef = {
    providerId: 'agh.reference/memory',
    bindingId: 'agh.reference/memory/binding',
    logicalName: 'memory',
    contract: 'agh.memory',
  }
  let stopped = false,
    quiescing = false
  const schemas = {
    get: 'MemoryGetRequest',
    remember: 'MemoryRememberRequest',
    forget: 'MemoryForgetRequest',
  } as const
  async function call(
    operation: string,
    data: unknown,
    ctx: CallContext,
    delivery = ctx.invocationId,
  ): Promise<Outcome<unknown>> {
    try {
      access(policy, ctx, stopped || quiescing)
      if (!Object.hasOwn(schemas, operation)) return failure('incompatible', 'memory_unknown_method')
      const operationName = operation as keyof typeof schemas,
        canonical = boundedCanonicalJson(data, { maxBytes: 16384, maxDepth: 32, maxMembers: 4096 })
      if (!canonical.ok) return failure('invalid_input', 'memory_input_schema')
      const checked = validateRuntime(schemas[operationName], canonical.value.json)
      if (!checked.ok) return failure('invalid_input', 'memory_input_schema')
      if (!visibility(policy, operation, null, ctx)) return failure('denied', 'memory_denied')
      const run = (state: Snapshot): Outcome<unknown> => {
        if (state.entries.some((entry) => !validateRuntime('MemoryItem', entry).ok))
          throw new ReferenceRefusal('incompatible', 'memory_corrupt')
        if (operationName === 'get') {
          const selection = checked.value as W.MemoryGetRequest
          if (selection.atRevision !== null && selection.atRevision !== state.revision)
            throw new ReferenceRefusal('conflict', 'memory_revision_conflict')
          const entries = state.entries
            .filter(
              (entry) =>
                (!selection.ids.length || selection.ids.includes(entry.ref.id)) &&
                entry.status === 'active' &&
                (entry.expiresAt === null || Date.parse(entry.expiresAt) > Date.now()) &&
                visibility(policy, 'get', entry, ctx),
            )
            .sort((a, b) => a.ref.id.localeCompare(b.ref.id))
          return { ok: true, value: { revision: state.revision, items: entries } }
        }
        const request = checked.value as W.MemoryRememberRequest | W.MemoryForgetRequest
        if (operationName === 'remember') {
          for (const proposed of (request as W.MemoryRememberRequest).items) {
            if (
              !proposed.sourceRefs.length ||
              proposed.sourceRefs.some(
                (source) => policy.sourceAvailable(structuredClone(source), proposed.trust, ctx) !== true,
              )
            )
              throw new ReferenceRefusal('denied', 'memory_source_denied')
            if (proposed.contentRef.kind === 'inline') {
              const encoded = pack(proposed.contentRef.schema, proposed.contentRef.value)
              if (
                !encoded.ok ||
                encoded.value.kind !== 'inline' ||
                encoded.value.bytes !== proposed.contentRef.bytes ||
                encoded.value.digest !== proposed.contentRef.digest
              )
                throw new ReferenceRefusal('invalid_input', 'memory_content_invalid')
            }
          }
        } else
          for (const id of (request as W.MemoryForgetRequest).memoryIds) {
            const entry = state.entries.find((candidate) => candidate.ref.id === id)
            if (!entry) throw new ReferenceRefusal('invalid_input', 'memory_not_found')
            if (!visibility(policy, 'forget', entry, ctx))
              throw new ReferenceRefusal('denied', 'memory_denied')
          }
        const token = canonicalJsonDigest({
            tenant: policy.tenantRef,
            principal: ctx.principalRef,
            method: operation,
            deliveryId: delivery,
          }),
          digest = canonicalJsonDigest(request)
        const previous = state.journal[token]
        if (previous) {
          if (previous.fingerprint !== digest)
            throw new ReferenceRefusal('conflict', 'memory_delivery_conflict')
          return { ok: true, value: previous.output }
        }
        if (request.expectedRevision !== state.revision)
          throw new ReferenceRefusal('conflict', 'memory_revision_conflict')
        const version = ++state.revision
        let answer: W.MemoryRememberResult | W.MemoryForgetResult
        if (operationName === 'remember') {
          const memoryRefs = (request as W.MemoryRememberRequest).items.map((input, offset) => {
            const reference = {
              authorityId: 'memory',
              typeId: 'agh.memory/item@1',
              id: canonicalJsonDigest({ key: token, i: offset }),
              revision: version,
            }
            state.entries.push({
              ...structuredClone(input),
              ref: reference,
              ownerPrincipalRef: ctx.principalRef,
              status: 'active',
              provenance: {
                producer: binding,
                sourceRefs: input.sourceRefs.map((source) => canonicalJsonDigest(source)),
                trustLabels: [input.trust],
              },
            })
            return reference
          })
          answer = { memoryRefs, revision: version }
        } else {
          const invalidatedRefs: W.PublicRef[] = []
          for (const id of new Set((request as W.MemoryForgetRequest).memoryIds)) {
            const entry = state.entries.find((candidate) => candidate.ref.id === id)!
            invalidatedRefs.push({ kind: 'domain', value: structuredClone(entry.ref) })
            entry.status = 'deleted'
            entry.ref.revision = version
          }
          const deletionReceipt = {
            deletionId: token,
            authorityId: 'memory',
            watermark: version,
            invalidatedRefs,
          }
          state.pending.push(deletionReceipt)
          answer = {
            deletionReceipt,
            propagationJobRef: {
              authorityId: 'memory',
              typeId: 'agh.memory/deletion-propagation@1',
              id: token,
              revision: version,
            },
          }
        }
        const encoded = pack(RuntimeMethodSchemaRefs['agh.memory'][operationName].output, answer)
        if (!encoded.ok) throw new ReferenceRefusal(encoded.error.code, encoded.error.detailCode)
        access(policy, ctx, stopped || quiescing)
        state.journal[token] = { fingerprint: digest, output: answer }
        return { ok: true, value: answer }
      }
      return operationName === 'get' ? run(storage.load()) : storage.update(run)
    } catch (exception) {
      return caught(exception, 'memory')
    }
  }
  const provider: ServiceProvider = {
    async ready(ctx) {
      try {
        access(policy, ctx, stopped || quiescing)
        return { ok: true, value: undefined }
      } catch (exception) {
        return caught(exception, 'memory')
      }
    },
    async health(ctx) {
      const result = await provider.ready(ctx)
      return result.ok ? { ok: true, value: { status: 'ready', diagnosticIds: [] } } : result
    },
    async drain(_deadline, ctx) {
      const result = await provider.ready(ctx)
      if (!result.ok) return result
      quiescing = true
      return {
        ok: true,
        value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
      }
    },
    async close() {
      if (!stopped) {
        stopped = true
        storage.finish()
      }
    },
    async query(request, ctx) {
      if (request.method !== 'get' || request.target.bindingId !== binding.bindingId)
        return failure('denied', 'memory_binding_denied')
      const schemas = RuntimeMethodSchemaRefs['agh.memory'].get,
        input = unpack(request.input, schemas.input)
      const result = input.ok ? await call('get', input.value, ctx) : input
      if (!result.ok) return result
      const output = pack(schemas.output, result.value)
      return output.ok
        ? {
            ok: true,
            value: {
              kind: 'value',
              snapshot: String((result.value as W.MemoryGetResult).revision),
              output: output.value,
            },
          }
        : output
    },
  }
  const actions: Record<string, ActionProviderFactory> = {}
  for (const name of ['remember', 'forget'] as const)
    actions[name] = {
      recovery: 'R2',
      kind: 'leaf',
      stateCodec: null,
      async create(scope) {
        const stop = new AbortController()
        const handlerReady = async (context: CallContext): Promise<Outcome<void>> =>
          stop.signal.aborted ? failure('denied', 'provider_closed') : provider.ready(context)
        return {
          ...provider,
          ready: handlerReady,
          async health(context) {
            const status = await handlerReady(context)
            return status.ok ? { ok: true, value: { status: 'ready', diagnosticIds: [] } } : status
          },
          async drain(_until, context) {
            const status = await handlerReady(context)
            if (!status.ok) return status
            stop.abort()
            return {
              ok: true,
              value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
            }
          },
          kind: 'leaf',
          effectSemantics: 'idempotent',
          async close() {
            stop.abort()
          },
          async execute(frame, ctx) {
            if (
              stop.signal.aborted ||
              scope.bindingId !== binding.bindingId ||
              scope.runId !== frame.runId ||
              frame.actionId !== scope.actionId ||
              frame.method !== name ||
              frame.bindingId !== binding.bindingId ||
              frame.inputDigest !==
                (frame.input.kind === 'blob' ? frame.input.blob.digest : frame.input.digest)
            )
              return {
                outcome: 'failed',
                error: failure('denied', 'memory_binding_denied').error,
                usage: [],
                references: [],
                externalRequests: [],
              }
            const specification = RuntimeMethodSchemaRefs['agh.memory'][name],
              decoded = unpack(frame.input, specification.input)
            const response = decoded.ok
              ? await call(
                  name,
                  decoded.value,
                  { ...ctx.call, signal: AbortSignal.any([scope.signal, ctx.call.signal, stop.signal]) },
                  frame.actionId,
                )
              : decoded
            const encoded = response.ok ? pack(specification.output, response.value) : response
            return encoded.ok
              ? {
                  outcome: 'succeeded',
                  result: encoded.value,
                  usage: [],
                  references: [],
                  externalRequests: [],
                }
              : {
                  outcome: encoded.error.code === 'cancelled' ? 'cancelled' : 'failed',
                  error: encoded.error,
                  usage: [],
                  references: [],
                  externalRequests: [],
                }
          },
          async reconcile(frame, _evidence, ctx) {
            if (stopped || stop.signal.aborted)
              return { kind: 'unknown', evidence: frame.input, reason: 'provider_closed' }
            const token = canonicalJsonDigest({
              tenant: policy.tenantRef,
              principal: ctx.call.principalRef,
              method: name,
              deliveryId: frame.actionId,
            })
            if (!storage.load().journal[token])
              return { kind: 'not_found', evidence: frame.input, safeToRetry: true }
            const spec = RuntimeMethodSchemaRefs['agh.memory'][name],
              decoded = unpack(frame.input, spec.input),
              response = decoded.ok ? await call(name, decoded.value, ctx.call, frame.actionId) : decoded
            const encoded = response.ok ? pack(spec.output, response.value) : response
            return {
              kind: 'resolved',
              evidence: frame.input,
              result: encoded.ok
                ? {
                    outcome: 'succeeded',
                    result: encoded.value,
                    externalRequests: [],
                    usage: [],
                    references: [],
                  }
                : {
                    outcome: 'failed',
                    error: encoded.error,
                    externalRequests: [],
                    usage: [],
                    references: [],
                  },
            }
          },
        }
      },
    }
  provider.actions = actions
  return Object.assign(provider, {
    binding,
    call,
    pendingDeletions: () => {
      if (stopped) throw new Error('provider_closed')
      return storage.load().pending
    },
    acknowledgeDeletion: (id: string) => {
      if (stopped) throw new Error('provider_closed')
      storage.update((state) => {
        state.pending = state.pending.filter((receipt) => receipt.deletionId !== id)
      })
    },
  })
}
