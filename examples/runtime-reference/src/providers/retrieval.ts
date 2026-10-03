import type { CallContext, Outcome, ServiceProvider } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
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
import { type ReferenceRemoteAccess, referenceRemoteAction } from './retrieval-remote.js'

interface Document {
  memoryId: string
  text: string
  vector: readonly number[]
  createdAt: string
}
interface Batch {
  expectedRevision: number
  dimensions: number
  documents: readonly Document[]
  queryVectors: Readonly<Record<string, readonly number[]>>
}
export interface ReferenceRetrievalOptions extends ReferenceAccess, ReferenceRemoteAccess {
  directory: string
  memory: { call(method: string, data: unknown, context: CallContext): Promise<Outcome<unknown>> }
}
type IndexSnapshot = {
  revision: number
  dimensions: number
  documents: Document[]
  postings: Record<string, string[]>
  queries: Record<string, readonly number[]>
  removals: Record<string, { digest: string; watermark: number }>
}
const tokenize = (text: string) =>
  Array.from(
    new Set(
      text
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .match(/[\p{L}\p{N}]+/gu) || [],
    ),
  )
function similarity(left: readonly number[], right: readonly number[] | undefined): number {
  if (!right) return 0
  const leftMax = Math.max(...left.map((coordinate) => Math.abs(coordinate))),
    rightMax = Math.max(...right.map((coordinate) => Math.abs(coordinate)))
  if (leftMax === 0 || rightMax === 0) return 0
  const x = left.map((coordinate) => coordinate / leftMax),
    y = right.map((coordinate) => coordinate / rightMax)
  const xNorm = Math.hypot(...x),
    yNorm = Math.hypot(...y)
  const dot = x
    .map((coordinate, index) => (coordinate / xNorm) * (y[index]! / yNorm))
    .reduce((total, value) => total + value, 0)
  return Math.max(0, Math.min(1, dot))
}
/** Persistent inverted postings, not FTS or an import of the default indexing algorithm. */
export function createReferenceRetrieval(policy: ReferenceRetrievalOptions) {
  const storage = snapshotStore<IndexSnapshot>(policy.directory, 'retrieval', policy, {
    revision: 0,
    dimensions: 0,
    documents: [],
    postings: {},
    queries: {},
    removals: {},
  })
  const binding: W.BindingRef = {
    providerId: 'agh.reference/retrieval',
    bindingId: 'agh.reference/retrieval/binding',
    logicalName: 'retrieval',
    contract: 'agh.retrieval',
  }
  const reference = (): W.DomainObjectRef => ({
    authorityId: 'retrieval',
    typeId: 'agh.retrieval/index@1',
    id: 'primary',
    revision: storage.load().revision,
  })
  let disposed = false,
    draining = false
  const pending = new Set<string>(),
    cancelAll = new AbortController()
  async function permitted(context: CallContext): Promise<W.MemoryGetResult> {
    const deadline = new AbortController(),
      delay = setTimeout(
        () => deadline.abort(),
        Math.min(2147483647, Math.max(1, Date.parse(context.deadline) - Date.now())),
      )
    const signal = AbortSignal.any([context.signal, cancelAll.signal, deadline.signal])
    let rejectOnAbort = () => {}
    const cancelled = new Promise<never>((_yes, no) => {
      rejectOnAbort = () =>
        no(
          new ReferenceRefusal(
            cancelAll.signal.aborted ? 'denied' : 'cancelled',
            cancelAll.signal.aborted ? 'provider_closed' : 'request_cancelled',
          ),
        )
      signal.addEventListener('abort', rejectOnAbort, { once: true })
    })
    try {
      const answer = await Promise.race([
        policy.memory.call('get', { atRevision: null, ids: [] }, { ...context, signal }),
        cancelled,
      ])
      access(policy, context, disposed || draining)
      if (!answer.ok) throw new ReferenceRefusal(answer.error.code, 'retrieval_memory_unavailable')
      const decoded = validateRuntime('MemoryGetResult', answer.value)
      if (!decoded.ok) throw new ReferenceRefusal('incompatible', 'retrieval_memory_invalid')
      return decoded.value
    } finally {
      clearTimeout(delay)
      signal.removeEventListener('abort', rejectOnAbort)
    }
  }
  async function call(method: string, data: unknown, context: CallContext): Promise<Outcome<unknown>> {
    pending.add(context.invocationId)
    try {
      access(policy, context, disposed || draining)
      if (!visibility(policy, 'get', null, context)) return failure('denied', 'retrieval_denied')
      if (method !== 'search')
        return failure(
          'incompatible',
          method === 'searchRemote' ? 'retrieval_remote_action_required' : 'retrieval_unknown_method',
        )
      const checked = validateRuntime('RetrievalSearchRequest', data)
      if (!checked.ok || checked.value.topK === 0 || checked.value.topK > 100)
        return failure('invalid_input', 'retrieval_input_schema')
      const request = checked.value,
        index = storage.load()
      if (canonicalJsonDigest(request.indexRef) !== canonicalJsonDigest(reference()))
        return failure('conflict', 'retrieval_revision_conflict')
      const source = await permitted(context),
        words = tokenize(request.queryText),
        queryVector = Object.hasOwn(index.queries, request.queryText)
          ? index.queries[request.queryText]
          : undefined
      const matched = new Set(
        words.flatMap((word) => (Object.hasOwn(index.postings, word) ? index.postings[word]! : [])),
      )
      const hits: W.RetrievalHit[] = []
      for (const document of index.documents) {
        const vectorScore = similarity(document.vector, queryVector)
        if (!matched.has(document.memoryId) && vectorScore <= 0) continue
        const item = source.items.find((candidate) => candidate.ref.id === document.memoryId)
        if (!item || !visibility(policy, 'get', item, context)) continue
        if (request.filter.labels?.some((label) => !item.labels.includes(label))) continue
        if (request.filter.after && Date.parse(document.createdAt) <= Date.parse(request.filter.after))
          continue
        const tokens = tokenize(document.text),
          keywordScore = words.length
            ? words.reduce((total, word) => total + Number(tokens.includes(word)), 0) / words.length
            : 0
        const score = (keywordScore + vectorScore) * 0.5
        if (score > 0)
          hits.push({
            source: item.provenance,
            trust: item.trust,
            score,
            ref: { kind: 'domain', value: item.ref },
          })
      }
      hits.sort(
        (left, right) =>
          right.score - left.score ||
          canonicalJsonDigest(left.ref).localeCompare(canonicalJsonDigest(right.ref)),
      )
      const rechecked = await permitted(context)
      if (
        storage.load().revision !== index.revision ||
        canonicalJsonDigest(rechecked) !== canonicalJsonDigest(source)
      )
        return failure('conflict', 'retrieval_snapshot_stale')
      const scope = canonicalJsonDigest({ scope: policy.scope, tenant: policy.tenantRef })
      const snapshot = canonicalJsonDigest({
        scope,
        principal: context.principalRef,
        authorization: context.authorizationRef,
        request: { ...request, cursor: null },
        memory: rechecked,
        hits,
      })
      let start = 0
      if (request.cursor !== null) {
        try {
          const saved = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'))
          if (
            saved.snapshot !== snapshot ||
            !Number.isSafeInteger(saved.offset) ||
            saved.offset < 1 ||
            saved.offset >= hits.length
          )
            throw new Error('cursor')
          start = saved.offset
        } catch {
          return failure('conflict', 'retrieval_cursor_stale')
        }
      }
      const stop = Math.min(hits.length, start + request.topK)
      return {
        ok: true,
        value: {
          items: hits.slice(start, stop),
          snapshot,
          complete: stop === hits.length,
          nextCursor:
            stop < hits.length
              ? Buffer.from(JSON.stringify({ snapshot, offset: stop })).toString('base64url')
              : null,
        },
      }
    } catch (exception) {
      return caught(exception, 'retrieval')
    } finally {
      pending.delete(context.invocationId)
    }
  }
  const provider: ServiceProvider = {
    async ready(context) {
      try {
        access(policy, context, disposed || draining)
        return { ok: true, value: undefined }
      } catch (exception) {
        return caught(exception, 'retrieval')
      }
    },
    async health(context) {
      const result = await provider.ready(context)
      return result.ok ? { ok: true, value: { status: 'ready', diagnosticIds: [] } } : result
    },
    async drain(_time, context) {
      const result = await provider.ready(context)
      if (!result.ok) return result
      draining = true
      return {
        ok: true,
        value: {
          state: pending.size ? 'blocked' : 'drained',
          activeInvocationIds: [...pending],
          durableOwnerRefs: [],
          diagnosticIds: [],
        },
      }
    },
    async close() {
      if (!disposed) {
        disposed = true
        cancelAll.abort()
        storage.finish()
      }
    },
    async query(request, context) {
      if (request.method !== 'search' || request.target.bindingId !== binding.bindingId)
        return failure('denied', 'retrieval_binding_denied')
      const schema = RuntimeMethodSchemaRefs['agh.retrieval'].search,
        decoded = unpack(request.input, schema.input)
      const result = decoded.ok ? await call('search', decoded.value, context) : decoded
      if (!result.ok) return result
      const output = pack(schema.output, result.value)
      return output.ok
        ? {
            ok: true,
            value: {
              kind: 'value',
              output: output.value,
              snapshot: (result.value as W.PageRetrievalHit).snapshot,
            },
          }
        : output
    },
  }
  provider.actions = { searchRemote: referenceRemoteAction(policy, provider, binding, cancelAll.signal) }
  return Object.assign(provider, {
    binding,
    call,
    indexRef: reference,
    deletionWatermark: () =>
      Math.max(0, ...Object.values(storage.load().removals).map((removal) => removal.watermark)),
    async replaceIndex(sourceBatch: Batch, context: CallContext): Promise<Outcome<W.DomainObjectRef>> {
      pending.add(context.invocationId)
      try {
        access(policy, context, disposed || draining)
        const batch = structuredClone(sourceBatch)
        if (!visibility(policy, 'rebuild', null, context)) return failure('denied', 'retrieval_denied')
        if (
          !Number.isSafeInteger(batch.dimensions) ||
          batch.dimensions < 1 ||
          batch.dimensions > 8192 ||
          !Number.isSafeInteger(batch.expectedRevision) ||
          batch.expectedRevision < 0 ||
          batch.documents.length > 10000 ||
          new Set(batch.documents.map((document) => document.memoryId)).size !== batch.documents.length
        )
          return failure('invalid_input', 'retrieval_index_invalid')
        for (const coordinates of [
          ...batch.documents.map((document) => document.vector),
          ...Object.values(batch.queryVectors),
        ])
          if (coordinates.length !== batch.dimensions || !coordinates.every(Number.isFinite))
            return failure('invalid_input', 'retrieval_dimension_mismatch')
        if (
          batch.documents.some(
            (document) =>
              !document.memoryId ||
              typeof document.text !== 'string' ||
              !Number.isFinite(Date.parse(document.createdAt)),
          )
        )
          return failure('invalid_input', 'retrieval_document_invalid')
        const source = await permitted(context)
        if (
          batch.documents.some(
            (document) =>
              !source.items.some(
                (item) => item.ref.id === document.memoryId && visibility(policy, 'get', item, context),
              ),
          )
        )
          return failure('denied', 'retrieval_document_denied')
        const result = storage.update((index) => {
          if (index.revision !== batch.expectedRevision)
            throw new ReferenceRefusal('conflict', 'retrieval_revision_conflict')
          index.dimensions = batch.dimensions
          index.documents = structuredClone([...batch.documents])
          index.queries = structuredClone(batch.queryVectors)
          index.postings = Object.create(null) as Record<string, string[]>
          for (const document of index.documents)
            for (const word of tokenize(document.text)) {
              const posting = Object.hasOwn(index.postings, word) ? index.postings[word]! : []
              posting.push(document.memoryId)
              index.postings[word] = posting
            }
          index.revision++
          return {
            authorityId: 'retrieval',
            typeId: 'agh.retrieval/index@1',
            id: 'primary',
            revision: index.revision,
          }
        })
        return { ok: true, value: result }
      } catch (exception) {
        return caught(exception, 'retrieval')
      } finally {
        pending.delete(context.invocationId)
      }
    },
    async removeDeleted(receipt: W.DeletionReceipt): Promise<void> {
      if (disposed) throw new ReferenceRefusal('denied', 'provider_closed')
      if (
        !validateRuntime('DeletionReceipt', receipt).ok ||
        receipt.authorityId !== 'memory' ||
        receipt.invalidatedRefs.some(
          (ref) =>
            ref.kind !== 'domain' ||
            ref.value.authorityId !== 'memory' ||
            ref.value.typeId !== 'agh.memory/item@1',
        )
      )
        throw new ReferenceRefusal('invalid_input', 'retrieval_deletion_invalid')
      storage.update((index) => {
        const digest = canonicalJsonDigest(receipt),
          prior = index.removals[receipt.deletionId]
        if (prior) {
          if (prior.digest !== digest) throw new ReferenceRefusal('conflict', 'retrieval_deletion_conflict')
          return
        }
        const deleted = new Set(
          receipt.invalidatedRefs.flatMap((ref) => (ref.kind === 'domain' ? [ref.value.id] : [])),
        )
        index.documents = index.documents.filter((document) => !deleted.has(document.memoryId))
        for (const key of Object.keys(index.postings))
          index.postings[key] = index.postings[key]!.filter((id) => !deleted.has(id))
        index.removals[receipt.deletionId] = { digest, watermark: receipt.watermark }
        index.revision++
      })
    },
  })
}
