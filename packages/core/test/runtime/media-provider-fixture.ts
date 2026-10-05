import type { CallContext, LoopReadPorts, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs } from '@agnes/protocol/runtime'
import { pack } from '../../src/runtime/media/identity.js'
import { framedVisionText } from '../../src/runtime/media/legacy-bridge.js'
import type { MediaDeployment, VisionTarget } from '../../src/runtime/media/ports.js'
import { createDefaultMediaFactory } from '../../src/runtime/providers/media.js'
import {
  blobOf,
  digestOf,
  LIMITS,
  legacyImage,
  mediaBinding,
  modelBinding,
  must,
  planOf,
  routeSnapshot,
  stateBinding,
  VISION_TEXT,
} from './media-fixture.js'

export const SCHEMA: W.SchemaRef = { typeId: 'fixture/schema@1', revision: 1, digest: 'a'.repeat(64) }
const FUTURE = () => new Date(Date.now() + 60_000).toISOString()
const NOW = () => new Date().toISOString()

export const ctxWire = (deadline = FUTURE()): W.CallContextWire => ({
  principalRef: 'principal',
  scope: { kind: 'runtime', installationId: 'inst', runtimeId: 'rt' },
  bindingId: mediaBinding.bindingId,
  invocationId: 'invocation',
  deadline,
  traceRef: 'trace',
  authorizationRef: 'authorization',
})
export const callOf = (signal = new AbortController().signal, deadline = FUTURE()): CallContext => ({
  ...ctxWire(deadline),
  signal,
})

export function frameFor(plan: W.MediaPlan, extra: Partial<W.ActionFrame> = {}): W.ActionFrame {
  const input = must(pack(RuntimeMethodSchemaRefs['agh.media'].prepare.input, plan))
  return {
    actionId: 'media-parent',
    parentActionId: null,
    runId: 'run',
    bindingId: mediaBinding.bindingId,
    method: 'prepare',
    input,
    inputDigest: input.kind === 'inline' ? input.digest : '',
    attemptId: 'attempt',
    attemptNumber: 1,
    invocationId: 'invocation',
    requestIdentity: null,
    providerRevision: 0,
    continuation: null,
    signals: { items: [], snapshot: 's', nextCursor: null, complete: true },
    receipts: { items: [], snapshot: 's', nextCursor: null, complete: true },
    signalHighWater: 0,
    snapshot: 'snapshot',
    observedAt: NOW(),
    context: ctxWire(),
    actionTimebox: { defaultTimeoutMs: 60_000, maxDeadline: FUTURE() },
    ...extra,
  }
}

export const visionTarget = (over: Partial<VisionTarget> = {}): VisionTarget => ({
  model: modelBinding,
  route: routeSnapshot(),
  generation: { maxOutputTokens: 256, thinking: null },
  sessionParameterRef: {
    authorityId: 'cfg',
    recordId: 'parameters',
    recordRevision: 1,
    schema: SCHEMA,
    digest: digestOf({}),
  },
  credentialRef: null,
  parserVersion: '1',
  viewSchema: SCHEMA,
  ...over,
})

export function readyView(over: {
  actionId: string
  receiptId: string
  bindingId: string
  inputDigest: W.Digest
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown_effect'
  result?: W.DataRef
  error?: W.RuntimeError
}): W.ActionResultView {
  return {
    receiptId: over.receiptId,
    actionId: over.actionId,
    attemptId: `${over.actionId}-attempt`,
    bindingId: over.bindingId,
    inputDigest: over.inputDigest,
    outcome: over.outcome,
    ...(over.result ? { result: over.result } : {}),
    ...(over.error ? { error: over.error } : {}),
    externalRequests: [],
    usageRefs: [`${over.actionId}-attempt:model`],
    references: [],
    provenance: { sourceRefs: [], producer: modelBinding, trustLabels: [] },
    completedAt: NOW(),
    visibility: 'ready',
    viewId: `${over.actionId}-view`,
    sourceReceiptId: over.receiptId,
    hookResultSetRef: null,
  }
}

export const modelOutput = (text: string | null = VISION_TEXT): W.ModelOutput => ({
  outputRef: must(
    pack(
      SCHEMA,
      text === null
        ? { content: [], structured: { thinking: '', toolCalls: [] } }
        : { content: [{ type: 'text', text }], structured: { thinking: '', toolCalls: [] } },
    ),
  ),
  finishReason: 'stop',
  usageFactRefs: [
    { authorityId: 'usage-authority', usageId: 'vision-attempt:model', digest: digestOf({ usage: 1 }) },
  ],
  providerReceipt: null,
  actualModel: 'vision-model',
})

/** In-memory ports, source store and State view; every external effect is counted. */
export function harness() {
  let allowed = true
  let epoch = 'epoch-0'
  let vision: VisionTarget | null = visionTarget()
  const bytes = new Map<string, Uint8Array>()
  const receipts = new Map<string, W.ActionResultView>()
  const log = { computes: 0, prepared: [] as W.ActionSpec[], opens: 0, resolves: 0 }
  let preparedCounter = 0

  const ports: LoopReadPorts = {
    async query(request) {
      if (request.method !== 'probeActionResult') return { ok: false, error: refusal('incompatible') }
      const input =
        request.input.kind === 'inline'
          ? (request.input.value as { actionId: string; sourceReceiptId: string })
          : null
      const view = input ? receipts.get(`${input.actionId}:${input.sourceReceiptId}`) : undefined
      const value = view
        ? {
            actionId: view.actionId,
            sourceReceiptId: view.sourceReceiptId,
            revision: 1,
            state: 'ready',
            stageActionId: null,
            registrationDigest: null,
            result: view,
            uiResult: null,
            publishedByCommitId: 'commit',
          }
        : null
      return {
        ok: true,
        value: {
          kind: 'value',
          output: must(pack(RuntimeMethodSchemaRefs['agh.state'].probeActionResult.output, value)),
          snapshot: 's',
        },
      }
    },
    async compute(request) {
      log.computes += 1
      preparedCounter += 1 // worst case: every call yields a different reference, although real handles repeat for equal input
      const preparedRef = must(pack(SCHEMA, { preparedId: `prepared-${preparedCounter}` }))
      return {
        ok: true,
        value: must(
          pack(RuntimeMethodSchemaRefs['agh.model'].prepare.output, {
            preparedRef,
            targetSnapshot: routeSnapshot(),
            inputDigest: digestOf({ n: preparedCounter }),
            estimatedUnits: [],
            mediaPlanRefs: [],
          }),
        ),
      }
    },
    async resolveData() {
      return { ok: false, error: refusal('incompatible') }
    },
    prepare(spec) {
      log.prepared.push(spec)
      return {
        ok: true,
        value: { ...spec, obligation: 'mandatory', intentFingerprint: digestOf(spec) } as W.PreparedAction,
      }
    },
  }

  const deployment = (over: Partial<MediaDeployment> = {}): MediaDeployment => ({
    binding: mediaBinding,
    packageDigest: 'f'.repeat(64),
    configSchema: SCHEMA,
    requires: [],
    state: stateBinding,
    limits: LIMITS,
    sources: {
      async open(ref) {
        log.opens += 1
        if (!allowed || ref.kind !== 'blob') return { ok: false, error: refusal('denied') }
        const data = bytes.get(ref.value.digest)
        return data
          ? {
              ok: true,
              value: {
                blob: ref.value,
                bytes: data,
                version: 'v1',
                trust: 'external',
                sourceTool: 'computer_use',
              },
            }
          : { ok: false, error: refusal('denied') }
      },
      epoch: () => epoch,
    },
    vision: {
      async resolve() {
        log.resolves += 1
        return vision ? { ok: true, value: vision } : { ok: false, error: refusal('incompatible') }
      },
    },
    authorize: () => allowed,
    ...over,
  })

  for (const marker of [1, 2, 3]) {
    const image = legacyImage(marker, 0, marker)
    bytes.set(image.blob.digest, image.bytes)
  }
  const publish = (view: W.ActionResultView) => receipts.set(`${view.actionId}:${view.sourceReceiptId}`, view)
  return {
    ports,
    log,
    deployment,
    publish,
    bytes,
    setAllowed: (value: boolean) => {
      allowed = value
    },
    setEpoch: (value: string) => {
      epoch = value
    },
    setVision: (value: VisionTarget | null) => {
      vision = value
    },
    /** The receipt a succeeded vision child would leave: bound to the model binding and the child's input digest. */
    childReceipt(
      spawned: W.PreparedAction,
      text: string | null = VISION_TEXT,
      outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown_effect' = 'succeeded',
    ) {
      const view = readyView({
        actionId: 'vision-child',
        receiptId: 'vision-receipt',
        bindingId: spawned.target.bindingId,
        inputDigest: spawned.input.kind === 'inline' ? spawned.input.digest : '',
        outcome,
        ...(outcome === 'succeeded'
          ? { result: must(pack(RuntimeMethodSchemaRefs['agh.model'].infer.output, modelOutput(text))) }
          : {}),
        ...(outcome === 'failed' ? { error: refusal('internal') } : {}),
      })
      publish(view)
      return { actionId: view.actionId, receiptId: view.receiptId, outcome }
    },
  }
}

export const refusal = (code: W.RuntimeError['code']): W.RuntimeError => ({
  code,
  detailCode: 'fixture',
  message: 'fixture',
  diagnosticId: 'fixture',
  retryAdvice: { kind: 'never' },
})

export const scopeOf = (signal = new AbortController().signal) => ({
  instanceId: 'instance',
  actionId: 'media-parent',
  runId: 'run',
  bindingId: mediaBinding.bindingId,
  scope: ctxWire().scope,
  signal,
})

/** A fresh provider and prepare handler: stands in for a process that only has the persisted frame. */
export async function openAction(deployment: MediaDeployment, signal = new AbortController().signal) {
  const provider = await createDefaultMediaFactory(deployment).create(
    { kind: 'inline', schema: SCHEMA, value: {}, digest: canonicalJsonDigest({}), bytes: 2 },
    {} as never,
    { bindingId: deployment.binding.bindingId, instanceId: 'instance', signal } as never,
  )
  const action = await provider.actions!.prepare!.create(scopeOf(signal))
  if (action.kind !== 'composite') throw new Error('prepare must be composite')
  return { provider, action }
}

export { blobOf, framedVisionText, planOf }
