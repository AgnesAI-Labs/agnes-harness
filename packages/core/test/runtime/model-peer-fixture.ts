import type { LoopReadPorts, Outcome } from '@agnes/extension-api/runtime'
import { runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { inlineRef } from './model-deployment-fixture.js'
import { fixtureAdapter } from './model-fixture.js'

export type PeerChild = Readonly<{ actionId: string; spec: W.PreparedAction }>
export type DispatchOptions = Readonly<{ foreignUsage?: boolean }>
export type RestrictedPeer = Readonly<{
  ports: LoopReadPorts
  /** Creates the child the way State would: stable per parent and key, one fingerprint per key. */
  commit(parentActionId: string, child: W.PreparedAction): Outcome<PeerChild>
  /** Runs the child on a fake adapter leaf, once per child id, and records its result. */
  dispatch(child: PeerChild, outcome: 'succeeded' | 'failed' | 'unknown_effect', options?: DispatchOptions): Promise<void>
  /** Publishes the recorded result under a receipt so the state query can answer it. */
  publish(child: PeerChild, receiptId: string): W.ActionResultView
  deliveries(): number
}>

const refused = (code: W.RuntimeError['code'], detailCode: string): { ok: false; error: W.RuntimeError } => ({
  ok: false,
  error: { code, detailCode, message: 'm', retryAdvice: { kind: 'never' }, diagnosticId: 'peer' },
})

export function restrictedPeer(options: {
  adapter?: W.BindingRef
  state?: string
  usageIds?: readonly string[]
}): RestrictedPeer {
  const adapter = options.adapter ?? fixtureAdapter
  const usageIds = options.usageIds ?? ['usage-1']
  const children = new Map<string, PeerChild>()
  const results = new Map<string, W.ActionResultView>()
  const published = new Map<string, W.ActionVisibilityValue>()
  let delivered = 0
  const probe = RuntimeMethodSchemaRefs['agh.state'].probeActionResult
  const ports: LoopReadPorts = {
    prepare(spec) {
      const prepared = validateRuntime('PreparedAction', { ...spec, intentFingerprint: canonicalJsonDigest(spec) })
      return prepared.ok ? { ok: true, value: prepared.value } : refused('invalid_input', 'peer_prepare')
    },
    async query(request) {
      if (request.target.bindingId !== (options.state ?? 'state') || request.method !== 'probeActionResult')
        return refused('denied', 'peer_method')
      const input = request.input.kind === 'inline' ? validateRuntime('ProbeActionResultRequest', request.input.value) : null
      if (!input?.ok) return refused('invalid_input', 'peer_query')
      const view = published.get(`${input.value.actionId}\0${input.value.sourceReceiptId}`) ?? null
      return { ok: true, value: { kind: 'value', snapshot: 'peer', output: inlineRef(probe.output, view) } }
    },
    async compute() {
      return refused('denied', 'peer_compute')
    },
    async resolveData(ref) {
      return ref.kind === 'inline' ? { ok: true, value: ref.value } : refused('denied', 'peer_data')
    },
  }
  return {
    ports,
    commit(parentActionId, child) {
      const key = `${parentActionId}\0${child.key}`
      const prior = children.get(key)
      if (prior) {
        return prior.spec.intentFingerprint === child.intentFingerprint
          ? { ok: true, value: prior }
          : refused('conflict', 'idempotency_conflict')
      }
      const created = { actionId: `child-${canonicalJsonDigest(key).slice(0, 16)}`, spec: child }
      children.set(key, created)
      return { ok: true, value: created }
    },
    async dispatch(child, outcome, dispatch = {}) {
      if (results.has(child.actionId)) return
      delivered++
      const input = child.spec.input
      const common = {
        receiptId: 'pending',
        actionId: child.actionId,
        attemptId: 'attempt',
        bindingId: adapter.bindingId,
        inputDigest: input.kind === 'inline' ? input.digest : input.blob.digest,
        outcome,
        externalRequests: [],
        usageRefs: outcome === 'succeeded' ? [...usageIds] : [],
        references: [],
        provenance: { sourceRefs: [], producer: adapter, trustLabels: [] },
        completedAt: new Date().toISOString(),
        visibility: 'ready' as const,
        viewId: 'view',
        sourceReceiptId: 'pending',
        hookResultSetRef: null,
      }
      const refs = [...usageIds, ...(dispatch.foreignUsage ? ['usage-foreign'] : [])]
      const output: W.ModelOutput = {
        outputRef: inlineRef(runtimeAuthorSchemas.StandardToolOutput.ref, { content: [], structured: { text: 'ok' } }),
        finishReason: 'stop',
        usageFactRefs: refs.map((usageId) => ({ authorityId: 'usage', usageId, digest: 'd'.repeat(64) })),
        providerReceipt: null,
        actualModel: 'fixture-model',
      }
      const failure = (code: W.RuntimeError['code'], detailCode: string) => refused(code, detailCode).error
      results.set(child.actionId, {
        ...common,
        ...(outcome === 'succeeded'
          ? { result: inlineRef(RuntimeMethodSchemaRefs['agh.model-adapter'].invoke.output, output) }
          : {
              error:
                outcome === 'failed'
                  ? failure('denied', 'credential_refresh_required')
                  : failure('unknown_effect', 'peer_unknown'),
            }),
      })
    },
    publish(child, receiptId) {
      const recorded = results.get(child.actionId)
      if (!recorded) throw new Error('child was not dispatched')
      const view: W.ActionResultView = { ...recorded, receiptId, sourceReceiptId: receiptId }
      published.set(`${child.actionId}\0${receiptId}`, {
        actionId: child.actionId,
        sourceReceiptId: receiptId,
        revision: 1,
        state: 'ready',
        stageActionId: null,
        registrationDigest: null,
        result: view,
        uiResult: null,
        publishedByCommitId: 'peer-commit',
      })
      return view
    },
    deliveries: () => delivered,
  }
}
