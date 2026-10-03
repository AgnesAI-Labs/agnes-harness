import type { CallContext, Outcome, ServiceProvider } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import {
  allowed,
  checkAccess,
  decode,
  inline,
  type MemoryAccess,
  MemoryFault,
  refused,
} from '../memory/access.js'
import {
  deletionFingerprint,
  hybridScore,
  type IndexBatch,
  terms,
  validateIndexBatch,
} from '../retrieval/index-revisions.js'
import { type RemoteRetrievalAccess, remoteRetrievalAction } from '../retrieval/remote.js'

import type { RetrievalStorage } from '../retrieval/storage.js'

export interface RetrievalOptions extends MemoryAccess, RemoteRetrievalAccess {
  storage: RetrievalStorage
  memory: { call(method: string, input: unknown, context: CallContext): Promise<Outcome<unknown>> }
}
export interface RetrievalService extends ServiceProvider {
  readonly binding: Wire.BindingRef
  indexRef(): Wire.DomainObjectRef
  replaceIndex(batch: IndexBatch, context: CallContext): Promise<Outcome<Wire.DomainObjectRef>>
  removeDeleted(receipt: Wire.DeletionReceipt): Promise<void>
  call(method: string, input: unknown, context: CallContext): Promise<Outcome<unknown>>
  deletionWatermark(): number
}

/** FTS5 candidates plus vector candidates, followed by the current Memory authorization set. */
export function createRetrievalService(options: RetrievalOptions): RetrievalService {
  const storage = options.storage
  const scope = canonicalJsonDigest({ scope: options.scope, tenant: options.tenantRef })
  storage.assertOwner(scope)
  const binding: Wire.BindingRef = {
    bindingId: 'agh.default/retrieval/binding',
    contract: 'agh.retrieval',
    logicalName: 'retrieval',
    providerId: 'agh.default/retrieval',
  }
  let closed = false,
    draining = false
  const active = new Set<string>(),
    lifetime = new AbortController()
  const revision = () => storage.revision()
  const indexRef = (): Wire.DomainObjectRef => ({
    authorityId: 'retrieval',
    typeId: 'agh.retrieval/index@1',
    id: 'primary',
    revision: revision(),
  })
  const documents = () => storage.documents()
  async function memory(ctx: CallContext): Promise<Wire.MemoryGetResult> {
    const timeout = new AbortController(),
      timer = setTimeout(
        () => timeout.abort(),
        Math.min(2_147_483_647, Math.max(1, Date.parse(ctx.deadline) - Date.now())),
      )
    const signal = AbortSignal.any([ctx.signal, lifetime.signal, timeout.signal])
    let cancel = () => {}
    const abort = new Promise<never>((_resolve, reject) => {
      cancel = () =>
        reject(
          new MemoryFault(
            lifetime.signal.aborted ? 'denied' : 'cancelled',
            lifetime.signal.aborted ? 'provider_closed' : 'request_cancelled',
          ),
        )
      signal.addEventListener('abort', cancel, { once: true })
    })
    try {
      const result = await Promise.race([
        options.memory.call('get', { ids: [], atRevision: null }, { ...ctx, signal }),
        abort,
      ])
      checkAccess(options, ctx, closed || draining)
      if (!result.ok) throw new MemoryFault(result.error.code, 'retrieval_memory_unavailable')
      const parsed = validateRuntime('MemoryGetResult', result.value)
      if (!parsed.ok) throw new MemoryFault('incompatible', 'retrieval_memory_invalid')
      return parsed.value
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
    }
  }
  const failure = (error: unknown) =>
    error instanceof MemoryFault
      ? refused(error.code, error.detail)
      : refused('retryable', 'retrieval_dependency_unavailable')
  const service: RetrievalService = {
    binding,
    indexRef,
    deletionWatermark: () => storage.deletionWatermark(),
    async replaceIndex(source, ctx) {
      active.add(ctx.invocationId)
      try {
        checkAccess(options, ctx, closed || draining)
        if (!allowed(options, 'rebuild', null, ctx)) return refused('denied', 'retrieval_denied')
        const batch = structuredClone(source)
        validateIndexBatch(batch)
        const authorized = await memory(ctx),
          ids = new Set(
            authorized.items.filter((item) => allowed(options, 'get', item, ctx)).map((item) => item.ref.id),
          )
        if (batch.documents.some((doc) => !ids.has(doc.memoryId)))
          return refused('denied', 'retrieval_document_denied')
        return {
          ok: true,
          value: storage.transaction(() => {
            if (batch.expectedRevision !== revision())
              throw new MemoryFault('conflict', 'retrieval_revision_conflict')
            storage.replace(
              batch.documents.map((doc) => ({ ...doc, keywordTerms: terms(doc.text) })),
              batch.dimensions,
              batch.queryVectors,
              revision() + 1,
            )
            return indexRef()
          }),
        }
      } catch (error) {
        return failure(error)
      } finally {
        active.delete(ctx.invocationId)
      }
    },
    async removeDeleted(receipt) {
      if (closed) throw new MemoryFault('denied', 'provider_closed')
      const fingerprint = deletionFingerprint(receipt)
      storage.transaction(() => {
        const prior = storage.removal(receipt.deletionId)
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new MemoryFault('conflict', 'retrieval_deletion_conflict')
          return
        }
        storage.removeDocuments(
          receipt.invalidatedRefs.flatMap((ref) => (ref.kind === 'domain' ? [ref.value.id] : [])),
        )
        storage.putRemoval(receipt.deletionId, fingerprint, receipt.watermark, revision() + 1)
      })
    },
    async call(method, input, ctx) {
      active.add(ctx.invocationId)
      try {
        checkAccess(options, ctx, closed || draining)
        if (!allowed(options, 'get', null, ctx)) return refused('denied', 'retrieval_denied')
        if (method !== 'search')
          return refused(
            'incompatible',
            method === 'searchRemote' ? 'retrieval_remote_action_required' : 'retrieval_unknown_method',
          )
        const checked = validateRuntime('RetrievalSearchRequest', input)
        if (!checked.ok || checked.value.topK < 1 || checked.value.topK > 100)
          return refused('invalid_input', 'retrieval_input_schema')
        const request = checked.value
        if (canonicalJsonDigest(request.indexRef) !== canonicalJsonDigest(indexRef()))
          return refused('conflict', 'retrieval_revision_conflict')
        const before = revision(),
          permitted = await memory(ctx)
        const sought = terms(request.queryText),
          candidates = new Set<string>()
        for (const id of storage.keywordCandidates(sought)) candidates.add(id)
        const vectors = storage.queryVectors()
        const docs = documents(),
          q = Object.hasOwn(vectors, request.queryText) ? vectors[request.queryText] : undefined
        for (const doc of docs)
          if (q && hybridScore('', doc.text, doc.vector, q) > 0) candidates.add(doc.memoryId)
        const hits: Wire.RetrievalHit[] = []
        for (const item of permitted.items) {
          const doc = docs.find((row) => row.memoryId === item.ref.id)
          if (
            !doc ||
            !candidates.has(item.ref.id) ||
            !allowed(options, 'get', item, ctx) ||
            (!request.filter.labels?.every((label) => item.labels.includes(label)) &&
              request.filter.labels !== undefined) ||
            (request.filter.after !== undefined &&
              Date.parse(doc.createdAt) <= Date.parse(request.filter.after))
          )
            continue
          const score = hybridScore(request.queryText, doc.text, doc.vector, q)
          if (score > 0)
            hits.push({
              ref: { kind: 'domain', value: item.ref },
              score,
              source: item.provenance,
              trust: item.trust,
            })
        }
        hits.sort(
          (a, b) => b.score - a.score || canonicalJsonDigest(a.ref).localeCompare(canonicalJsonDigest(b.ref)),
        )
        const current = await memory(ctx)
        if (before !== revision() || canonicalJsonDigest(current) !== canonicalJsonDigest(permitted))
          return refused('conflict', 'retrieval_snapshot_stale')
        const snapshot = canonicalJsonDigest({
          scope,
          principal: ctx.principalRef,
          authorization: ctx.authorizationRef,
          request: { ...request, cursor: null },
          memory: current,
          hits,
        })
        let offset = 0
        if (request.cursor !== null) {
          try {
            const page = JSON.parse(atob(request.cursor.replaceAll('-', '+').replaceAll('_', '/')))
            if (
              page.snapshot !== snapshot ||
              !Number.isSafeInteger(page.offset) ||
              page.offset < 1 ||
              page.offset >= hits.length
            )
              throw new Error()
            offset = page.offset
          } catch {
            return refused('conflict', 'retrieval_cursor_stale')
          }
        }
        const end = Math.min(offset + request.topK, hits.length)
        return {
          ok: true,
          value: {
            items: hits.slice(offset, end),
            snapshot,
            nextCursor:
              end < hits.length
                ? btoa(JSON.stringify({ snapshot, offset: end }))
                    .replaceAll('+', '-')
                    .replaceAll('/', '_')
                    .replaceAll('=', '')
                : null,
            complete: end === hits.length,
          },
        }
      } catch (error) {
        return failure(error)
      } finally {
        active.delete(ctx.invocationId)
      }
    },
    async ready(ctx) {
      try {
        checkAccess(options, ctx, closed || draining)
        return { ok: true, value: undefined }
      } catch (error) {
        return failure(error)
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
        value: {
          state: active.size ? 'blocked' : 'drained',
          activeInvocationIds: [...active],
          durableOwnerRefs: [],
          diagnosticIds: [],
        },
      }
    },
    async close() {
      if (!closed) {
        closed = true
        lifetime.abort()
        storage.close()
      }
    },
    async query(request, ctx) {
      if (request.target.bindingId !== binding.bindingId || request.method !== 'search')
        return refused('denied', 'retrieval_binding_denied')
      const decoded = decode(request.input, RuntimeMethodSchemaRefs['agh.retrieval'].search.input)
      if (!decoded.ok) return decoded
      const result = await service.call('search', decoded.value, ctx)
      if (!result.ok) return result
      const encoded = inline(RuntimeMethodSchemaRefs['agh.retrieval'].search.output, result.value)
      return encoded.ok
        ? {
            ok: true,
            value: {
              kind: 'value',
              output: encoded.value,
              snapshot: (result.value as Wire.PageRetrievalHit).snapshot,
            },
          }
        : encoded
    },
  }
  service.actions = { searchRemote: remoteRetrievalAction(options, service, binding, lifetime.signal) }
  return service
}
