import type { CallContext, Outcome, ServiceProvider } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  allowed,
  checkAccess,
  decode,
  inline,
  type MemoryAccess,
  MemoryFault,
  refused,
} from '../memory/access.js'

import type { MemoryStorage } from '../memory/storage.js'

export interface MemoryOptions extends MemoryAccess {
  storage: MemoryStorage
}
export interface MemoryService extends ServiceProvider {
  readonly binding: Wire.BindingRef
  call(method: string, input: unknown, context: CallContext, deliveryId?: string): Promise<Outcome<unknown>>
  pendingDeletions(): readonly Wire.DeletionReceipt[]
  acknowledgeDeletion(deletionId: string): void
}
const methods = {
  remember: ['MemoryRememberRequest', 'MemoryRememberResult'],
  forget: ['MemoryForgetRequest', 'MemoryForgetResult'],
  get: ['MemoryGetRequest', 'MemoryGetResult'],
} as const

/** Separate domain storage: this never reads or writes the session ledger. */
export function createMemoryService(options: MemoryOptions): MemoryService {
  if (
    options.scope.kind !== 'workspace' ||
    !validateRuntime('ScopeRef', options.scope).ok ||
    !options.tenantRef
  )
    throw new Error('memory_workspace_required')
  const storage = options.storage
  storage.assertOwner(canonicalJsonDigest({ scope: options.scope, tenant: options.tenantRef }))
  const binding: Wire.BindingRef = {
    bindingId: 'agh.default/memory/binding',
    contract: 'agh.memory',
    logicalName: 'memory',
    providerId: 'agh.default/memory',
  }
  let closed = false,
    draining = false
  const revision = () => storage.revision()
  const records = (): readonly Wire.MemoryItem[] => {
    const items = storage.items()
    for (const item of items)
      if (!validateRuntime('MemoryItem', item).ok) throw new MemoryFault('incompatible', 'memory_corrupt')
    return items
  }
  const permit = (method: string, item: Wire.MemoryItem | null, ctx: CallContext) => {
    if (!allowed(options, method, item, ctx)) throw new MemoryFault('denied', 'memory_denied')
  }
  async function call(
    method: string,
    input: unknown,
    context: CallContext,
    deliveryId = context.invocationId,
  ): Promise<Outcome<unknown>> {
    try {
      checkAccess(options, context, closed || draining)
      if (!Object.hasOwn(methods, method)) return refused('incompatible', 'memory_unknown_method')
      const name = method as keyof typeof methods
      const safe = boundedCanonicalJson(input, { maxBytes: 16_384, maxDepth: 32, maxMembers: 4096 })
      if (!safe.ok) return refused('invalid_input', 'memory_input_schema')
      const parsed = validateRuntime(methods[name][0], safe.value.json)
      if (!parsed.ok) return refused('invalid_input', 'memory_input_schema')
      permit(name, null, context)
      const all = records()
      if (name === 'get') {
        const request = parsed.value as Wire.MemoryGetRequest
        if (request.atRevision !== null && request.atRevision !== revision())
          return refused('conflict', 'memory_revision_conflict')
        const selected = all.filter(
          (item) =>
            (request.ids.length === 0 || request.ids.includes(item.ref.id)) &&
            item.status === 'active' &&
            (item.expiresAt === null || Date.parse(item.expiresAt) > Date.now()) &&
            allowed(options, 'get', item, context),
        )
        return { ok: true, value: { items: selected, revision: revision() } }
      }
      const request = parsed.value as Wire.MemoryRememberRequest | Wire.MemoryForgetRequest
      const key = canonicalJsonDigest({
        tenant: options.tenantRef,
        principal: context.principalRef,
        method,
        deliveryId,
      })
      const fingerprint = canonicalJsonDigest(request)
      // Re-authorize replay; a stored receipt is not an authorization grant.
      if (name === 'remember') {
        for (const item of (request as Wire.MemoryRememberRequest).items) {
          if (
            !item.sourceRefs.length ||
            !item.sourceRefs.every(
              (source) => options.sourceAvailable(structuredClone(source), item.trust, context) === true,
            )
          )
            return refused('denied', 'memory_source_denied')
          if (item.contentRef.kind === 'inline') {
            const encoded = inline(item.contentRef.schema, item.contentRef.value)
            if (
              !encoded.ok ||
              encoded.value.kind !== 'inline' ||
              encoded.value.digest !== item.contentRef.digest ||
              encoded.value.bytes !== item.contentRef.bytes
            )
              return refused('invalid_input', 'memory_content_invalid')
          }
        }
      } else
        for (const id of (request as Wire.MemoryForgetRequest).memoryIds) {
          const item = all.find((row) => row.ref.id === id)
          if (!item) return refused('invalid_input', 'memory_not_found')
          permit('forget', item, context)
        }
      return storage.transaction(() => {
        const delivered = storage.delivery(key)
        if (delivered) {
          if (delivered.fingerprint !== fingerprint)
            throw new MemoryFault('conflict', 'memory_delivery_conflict')
          return { ok: true, value: delivered.output }
        }
        if (request.expectedRevision !== revision())
          throw new MemoryFault('conflict', 'memory_revision_conflict')
        const next = revision() + 1
        let output: Wire.MemoryRememberResult | Wire.MemoryForgetResult
        if (name === 'remember') {
          const refs: Wire.DomainObjectRef[] = []
          for (const [i, entry] of (request as Wire.MemoryRememberRequest).items.entries()) {
            const ref = {
              authorityId: 'memory',
              typeId: 'agh.memory/item@1',
              id: canonicalJsonDigest({ key, i }),
              revision: next,
            }
            const item: Wire.MemoryItem = {
              ...entry,
              ref,
              ownerPrincipalRef: context.principalRef,
              status: 'active',
              provenance: {
                sourceRefs: entry.sourceRefs.map((source) => canonicalJsonDigest(source)),
                producer: binding,
                trustLabels: [entry.trust],
              },
            }
            storage.putItem(item)
            refs.push(ref)
          }
          output = { memoryRefs: refs, revision: next }
        } else {
          const invalidatedRefs: Wire.PublicRef[] = []
          for (const id of new Set((request as Wire.MemoryForgetRequest).memoryIds)) {
            const old = all.find((item) => item.ref.id === id)!
            invalidatedRefs.push({ kind: 'domain', value: old.ref })
            storage.putItem({ ...old, status: 'deleted', ref: { ...old.ref, revision: next } })
          }
          const receipt: Wire.DeletionReceipt = {
            deletionId: key,
            authorityId: 'memory',
            watermark: next,
            invalidatedRefs,
          }
          storage.putDeletion(receipt)
          output = {
            deletionReceipt: receipt,
            propagationJobRef: {
              authorityId: 'memory',
              typeId: 'agh.memory/deletion-propagation@1',
              id: key,
              revision: next,
            },
          }
        }
        const encoded = inline(RuntimeMethodSchemaRefs['agh.memory'][name].output, output)
        if (!encoded.ok) throw new MemoryFault(encoded.error.code, encoded.error.detailCode)
        checkAccess(options, context, closed || draining)
        storage.setRevision(next)
        storage.putDelivery(key, fingerprint, output)
        return { ok: true, value: output }
      })
    } catch (error) {
      return error instanceof MemoryFault
        ? refused(error.code, error.detail)
        : refused('retryable', 'memory_dependency_unavailable')
    }
  }
  const service: MemoryService = {
    binding,
    call,
    pendingDeletions: () => {
      if (closed) throw new Error('provider_closed')
      return storage.pendingDeletions()
    },
    acknowledgeDeletion: (id) => {
      if (closed) throw new Error('provider_closed')
      storage.acknowledgeDeletion(id)
    },
    async ready(ctx) {
      try {
        checkAccess(options, ctx, closed || draining)
        return { ok: true, value: undefined }
      } catch (error) {
        return error instanceof MemoryFault
          ? refused(error.code, error.detail)
          : refused('retryable', 'memory_dependency_unavailable')
      }
    },
    async health(ctx) {
      const ready = await service.ready(ctx)
      return ready.ok ? { ok: true, value: { status: 'ready', diagnosticIds: [] } } : ready
    },
    async drain(_deadline, ctx) {
      const ready = await service.ready(ctx)
      if (!ready.ok) return ready
      draining = true
      return {
        ok: true,
        value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
      }
    },
    async close() {
      if (!closed) {
        closed = true
        storage.close()
      }
    },
    async query(request, ctx) {
      if (request.target.bindingId !== binding.bindingId || request.method !== 'get')
        return refused('denied', 'memory_binding_denied')
      const data = decode(request.input, RuntimeMethodSchemaRefs['agh.memory'].get.input)
      if (!data.ok) return data
      const output = await call('get', data.value, ctx)
      if (!output.ok) return output
      const encoded = inline(RuntimeMethodSchemaRefs['agh.memory'].get.output, output.value)
      return encoded.ok
        ? {
            ok: true,
            value: {
              kind: 'value',
              output: encoded.value,
              snapshot: String((output.value as Wire.MemoryGetResult).revision),
            },
          }
        : encoded
    },
    actions: {},
  }
  const actions: NonNullable<ServiceProvider['actions']> extends Readonly<infer T> ? T : never = {}
  for (const method of ['remember', 'forget'] as const) {
    const schema =
      method === 'remember'
        ? RuntimeMethodSchemaRefs['agh.memory'].remember
        : RuntimeMethodSchemaRefs['agh.memory'].forget
    actions[method] = {
      kind: 'leaf',
      recovery: 'R2',
      stateCodec: null,
      async create(handlerScope) {
        const stop = new AbortController()
        const ready = (ctx: CallContext): Promise<Outcome<void>> =>
          stop.signal.aborted ? Promise.resolve(refused('denied', 'provider_closed')) : service.ready(ctx)
        return {
          ...service,
          ready,
          async health(ctx) {
            const result = await ready(ctx)
            return result.ok ? { ok: true, value: { status: 'ready', diagnosticIds: [] } } : result
          },
          async drain(_deadline, ctx) {
            const result = await ready(ctx)
            if (!result.ok) return result
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
              handlerScope.bindingId !== binding.bindingId ||
              frame.runId !== handlerScope.runId ||
              frame.actionId !== handlerScope.actionId ||
              frame.bindingId !== binding.bindingId ||
              frame.method !== method ||
              frame.inputDigest !==
                (frame.input.kind === 'inline' ? frame.input.digest : frame.input.blob.digest)
            )
              return {
                outcome: 'failed',
                error: refused('denied', 'memory_binding_denied').error,
                externalRequests: [],
                usage: [],
                references: [],
              }
            const data = decode(frame.input, schema.input)
            const result = data.ok
              ? await call(
                  method,
                  data.value,
                  {
                    ...ctx.call,
                    signal: AbortSignal.any([ctx.call.signal, handlerScope.signal, stop.signal]),
                  },
                  frame.actionId,
                )
              : data
            const output = result.ok ? inline(schema.output, result.value) : result
            return output.ok
              ? {
                  outcome: 'succeeded',
                  result: output.value,
                  externalRequests: [],
                  usage: [],
                  references: [],
                }
              : {
                  outcome: output.error.code === 'cancelled' ? 'cancelled' : 'failed',
                  error: output.error,
                  externalRequests: [],
                  usage: [],
                  references: [],
                }
          },
          async reconcile(frame, _evidence, ctx) {
            const key = canonicalJsonDigest({
              tenant: options.tenantRef,
              principal: ctx.call.principalRef,
              method,
              deliveryId: frame.actionId,
            })
            if (closed || stop.signal.aborted)
              return { kind: 'unknown', evidence: frame.input, reason: 'provider_closed' }
            if (!storage.delivery(key)) return { kind: 'not_found', evidence: frame.input, safeToRetry: true }
            const data = decode(frame.input, schema.input),
              result = data.ok ? await call(method, data.value, ctx.call, frame.actionId) : data
            const output = result.ok ? inline(schema.output, result.value) : result
            return {
              kind: 'resolved',
              evidence: frame.input,
              result: output.ok
                ? {
                    outcome: 'succeeded',
                    result: output.value,
                    externalRequests: [],
                    usage: [],
                    references: [],
                  }
                : { outcome: 'failed', error: output.error, externalRequests: [], usage: [], references: [] },
            }
          },
        }
      },
    }
  }
  service.actions = actions
  return service
}
