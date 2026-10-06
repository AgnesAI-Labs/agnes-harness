import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  buildWireRequest,
  createPreparedRegistry,
  handleIdOf,
  headerOf,
  type ModelCapture,
  modelInputDigest,
  type PreparedEntry,
  preparedIdOf,
  type WireIdentity,
} from '@agnes/core'
import type { ActionFrame, CallContext, LoopReadPorts, Outcome } from '@agnes/extension-api/runtime'
import type { ModelRecord } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { modelCrashFixture } from '../../../../ai/test/runtime/model-crash-fixture.js'
import { collectPreparedMedia } from '../../../../core/src/runtime/media/continuation.js'
import { planMediaForView } from '../../../../core/src/runtime/media/plan.js'
import type { MediaDeployment, VisionTarget } from '../../../../core/src/runtime/media/ports.js'
import {
  type ResolvedMedia,
  resolveMediaParts,
  toModelWireMedia,
} from '../../../../core/src/runtime/media/resolve.js'
import { verifyPreparedMedia } from '../../../../core/src/runtime/media/verify.js'
import { createDefaultMediaFactory } from '../../../../core/src/runtime/providers/media.js'
import { png } from '../../../../core/test/runtime/media-fixture.js'
import { createModelSourceReader } from '../../../src/runtime/model/model-source-reader.js'
import { fixtureContext, fixtureFrame, fixtureIds, sessionWith } from '../model-source-fixture.js'

type Api = 'openai-completions' | 'anthropic-messages'
type Mode = 'first' | 'resume' | 'main' | 'replan'
type Scenario = 'convert' | 'native'
const [api, endpoint, world, mode, scenario = 'convert', speed = 'normal'] = process.argv.slice(2) as [
  Api,
  string,
  string,
  Mode,
  Scenario?,
  ('normal' | 'fast')?,
]
const send = (value: Record<string, unknown>) => process.send?.({ pid: process.pid, ...value })
if (!process.send) throw new Error('IPC channel missing')
mkdirSync(join(world, 'bytes'), { recursive: true })

// ---- the persisted "State": child receipts and the parent frames a restart resumes ----
// Prepared requests are not here: they are objects of one process and are gone with it.
type Saved = { receipts: Record<string, W.ActionResultView>; parents: Record<string, ActionFrame> }
const statePath = join(world, 'state.json')
const load = (): Saved =>
  existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { receipts: {}, parents: {} }
function save(next: Saved) {
  const temporary = `${statePath}.tmp`
  const fd = openSync(temporary, 'w')
  writeSync(fd, JSON.stringify(next))
  fsyncSync(fd)
  closeSync(fd)
  renameSync(temporary, statePath)
}
/** What a prepared-request registry holds in this process; a restart starts it empty. */
const prepared = new Map<string, W.PreparedModelRequest>()

// ---- constants ----
const SCHEMA: W.SchemaRef = { typeId: 'fixture/schema@1', revision: 1, digest: 'a'.repeat(64) }
const mediaBinding: W.BindingRef = {
  bindingId: 'media-binding',
  providerId: 'agh.default/media',
  contract: 'agh.media',
  logicalName: 'default',
}
const stateBinding: W.BindingRef = {
  bindingId: 'state-binding',
  providerId: 'agh.default/state',
  contract: 'agh.state',
  logicalName: 'default',
}
const modelBinding: W.BindingRef = {
  bindingId: 'model-binding',
  providerId: 'agh.default/model',
  contract: 'agh.model',
  logicalName: 'default',
}
const features = (image: boolean): W.ModelFeatures => ({
  input: image ? ['text', 'image'] : ['text'],
  output: ['text'],
  tools: false,
  structuredOutput: false,
  streaming: true,
})
const routeOf = (model: string, image: boolean): W.ModelRouteSnapshot => ({
  routeId: 'fixed-route',
  routeRevision: 1,
  adapter: {
    bindingId: 'fixture-adapter',
    providerId: 'agh.default/model-adapter',
    contract: 'agh.model-adapter',
    logicalName: 'default',
  },
  model,
  endpointRef: 'fixture-endpoint',
  catalogRevision: 1,
  features: features(image),
  priceVersion: 'fixture-price-1',
  credentialAudience: 'fixture-endpoint',
  credentialBinding: {
    consumer: 'model',
    secretId: 'fixture-secret',
    accountRef: null,
    serverRef: 'fixture-endpoint',
    audience: 'fixture-endpoint',
    purpose: 'model-inference',
  },
})
const LIMITS = {
  maxManifestEntries: 8,
  maxSelectedImages: 8,
  maxSelectedBlocks: 16,
  maxBytesPerImage: 4096,
  maxDimensionPerImage: 1456,
  maxPixelsPerImage: 10_000_000,
  maxSelectedBytes: 16_384,
  maxSelectedPixels: 10_000_000,
}
const HANDLE: W.SecretHandle = {
  handleId: 'fixture-handle',
  secretId: 'fixture-secret',
  version: 'fixed-v1',
  audience: 'fixture-endpoint',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
}
const digestOf = (value: unknown) => canonicalJsonDigest(value as W.JsonValue)
const ok = <T>(outcome: Outcome<T>): T => {
  if (!outcome.ok) throw new Error(outcome.error.detailCode)
  return outcome.value
}
const pack = (schema: W.SchemaRef, value: unknown): W.DataRef => {
  const bounded = boundedCanonicalJson(value, { maxBytes: 65_536, maxDepth: 32, maxMembers: 10_000 })
  if (!bounded.ok) throw new Error('worker data bound')
  return {
    kind: 'inline',
    schema,
    value: bounded.value.json,
    digest: canonicalJsonDigest(bounded.value.json),
    bytes: bounded.value.bytes,
  }
}
const modelRecord = (id: string, input: ModelRecord['input']): ModelRecord => ({
  id,
  name: id,
  api,
  route: 'fixed-route',
  baseUrl: endpoint,
  reasoning: false,
  input,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})
const captureOf = (id: string, input: ModelRecord['input']): ModelCapture => ({
  adapterPackageDigest: 'c'.repeat(64),
  route: { route: 'fixed-route', api, baseUrl: endpoint },
  model: modelRecord(id, input),
})
const wireOf = (slot: 'image' | 'primary'): WireIdentity => ({
  sessionKey: 'fixture-session',
  slot,
  contractId: null,
})

// ---- sources: PNG files; access and its epoch follow the `revoked` marker ----
const sourceRefs: W.PublicRef[] = [1, 2].map((marker) => {
  const bytes = png(8, 8, marker)
  const digest = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(join(world, 'bytes', `${digest}.png`), bytes)
  return {
    kind: 'blob',
    value: {
      authorityId: 'blob-authority',
      blobId: `blob-${marker}`,
      digest,
      bytes: bytes.length,
      mediaType: 'image/png',
      pinId: `pin-${marker}`,
    },
  }
})
const revoked = () => existsSync(join(world, 'revoked'))
const readBlob = (blob: W.BlobRef) => new Uint8Array(readFileSync(join(world, 'bytes', `${blob.digest}.png`)))
const deadline = new Date(Date.now() + (speed === 'fast' ? 3_000 : 120_000)).toISOString()
const context = (): CallContext => ({
  principalRef: 'principal',
  scope: { kind: 'runtime', installationId: 'inst', runtimeId: 'rt' },
  bindingId: mediaBinding.bindingId,
  invocationId: 'invocation',
  deadline,
  traceRef: 'trace',
  authorizationRef: 'authorization',
  signal: new AbortController().signal,
})
const denied = (detailCode: string): Outcome<never> => ({
  ok: false,
  error: { code: 'denied', detailCode, message: '', diagnosticId: 'worker', retryAdvice: { kind: 'never' } },
})
const reader = {
  async read(blob: W.BlobRef): Promise<Outcome<Uint8Array>> {
    return revoked() ? denied('media_source_denied') : { ok: true, value: readBlob(blob) }
  },
}

const deployment = (): MediaDeployment => ({
  binding: mediaBinding,
  packageDigest: 'f'.repeat(64),
  configSchema: SCHEMA,
  requires: [],
  state: stateBinding,
  limits: LIMITS,
  sources: {
    async open(ref) {
      if (revoked() || ref.kind !== 'blob') return denied('media_source_denied')
      return {
        ok: true,
        value: {
          blob: ref.value,
          bytes: readBlob(ref.value),
          version: 'v1',
          trust: 'user',
          sourceTool: 'user_upload',
        },
      }
    },
    epoch: () => (revoked() ? 'revoked' : 'live'),
  },
  vision: {
    async resolve() {
      return {
        ok: true,
        value: {
          model: modelBinding,
          route: routeOf('vision-model', true),
          generation: { maxOutputTokens: 64, thinking: null },
          sessionParameterRef: {
            authorityId: 'fixture-config',
            recordId: 'parameters',
            recordRevision: 1,
            schema: SCHEMA,
            digest: digestOf({}),
          },
          credentialRef: HANDLE,
          parserVersion: '1',
          viewSchema: SCHEMA,
        } satisfies VisionTarget,
      }
    },
  },
  authorize: () => !revoked(),
})

// ---- the main request and its plan (identical in every process: planning is deterministic) ----
const mainRoute = routeOf('text-model', scenario === 'native')
const userItem = (id: string, text: string, refs: W.PublicRef[]): W.ContextItem => ({
  id,
  kind: 'message',
  body: pack(SCHEMA, text),
  sourceRefs: refs,
  provenance: { sourceRefs: [], producer: mediaBinding, trustLabels: [] },
  trust: 'user',
  tokenEstimate: 4,
  protected: false,
  toolPairRef: null,
  sourceRanges: [],
})
const mainView = (): W.ContextView => {
  const content = {
    viewId: 'main-view',
    format: 'fixture-text',
    schema: SCHEMA,
    baseRevision: 1,
    items: [userItem('u1', 'What is on screen?', sourceRefs)],
    tokenEstimate: 8,
    protectedRefs: [],
    runtimeInstructionRefs: [],
    inputDigest: digestOf({ main: 1 }),
  }
  return { ...content, digest: digestOf(content) } as W.ContextView
}
const parameters = {
  kind: 'agh.media/parameters@1' as const,
  slot: 'image' as const,
  maxEdge: 1456,
  maxOutputTokens: 64,
  failurePolicy: 'fail' as const,
  allowConversion: true,
  limits: LIMITS,
}
const mainPlan = (): W.MediaPlan =>
  ok(
    planMediaForView({ view: mainView(), target: mainRoute, provider: mediaBinding, parameters }),
  )[0] as W.MediaPlan

const frameFor = (plan: W.MediaPlan, parentId: string): ActionFrame => {
  const input = pack(RuntimeMethodSchemaRefs['agh.media'].prepare.input, plan)
  const { signal: _signal, ...wire } = context()
  return {
    actionId: parentId,
    parentActionId: null,
    runId: 'run',
    bindingId: mediaBinding.bindingId,
    method: 'prepare',
    input,
    inputDigest: (input as { digest: string }).digest,
    attemptId: 'attempt',
    attemptNumber: 1,
    invocationId: 'invocation',
    requestIdentity: null,
    providerRevision: 0,
    continuation: null,
    signals: { items: [], snapshot: 's', nextCursor: null, complete: true },
    receipts: { items: [], snapshot: 's', nextCursor: null, complete: true },
    signalHighWater: 0,
    snapshot: 'snap',
    observedAt: new Date().toISOString(),
    context: wire,
    actionTimebox: { defaultTimeoutMs: 60_000, maxDeadline: deadline },
  }
}

// ---- ports: the State view, the child factory, and a stand-in for the model service's `prepare` ----
const failure = (detail: string) => ({
  ok: false as const,
  error: {
    code: 'incompatible' as const,
    detailCode: detail,
    message: '',
    diagnosticId: 'worker',
    retryAdvice: { kind: 'never' as const },
  },
})
const ports: LoopReadPorts = {
  async query(request) {
    const input =
      request.input.kind === 'inline'
        ? (request.input.value as { actionId: string; sourceReceiptId: string })
        : null
    const view = input ? load().receipts[`${input.actionId}:${input.sourceReceiptId}`] : undefined
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
        output: pack(RuntimeMethodSchemaRefs['agh.state'].probeActionResult.output, value),
        snapshot: 's',
      },
    }
  },
  async compute(request) {
    const body = request.input.kind === 'inline' ? request.input.value : null
    const input = ok(validateRuntime('ModelPrepareRequest', body) as Outcome<W.ModelPrepareRequest>)
    const plans = ok(
      planMediaForView({
        view: input.view,
        target: input.route,
        provider: mediaBinding,
        parameters: { ...parameters, allowConversion: false },
      }),
    )
    const base: W.PreparedModelRequest = {
      preparedId: 'pending',
      ownerBinding: modelBinding,
      target: input.route,
      view: input.view,
      inputDigest: '0'.repeat(64),
      outputSchema: null,
      toolCatalog: null,
      generation: input.generation,
      mediaPlans: [...plans],
      estimatedUnits: [],
      hookResults: null,
      sessionParameterRef: input.sessionParameterRef,
      legacyRequestOverrides: null,
      credentialRef: HANDLE,
    }
    const inputDigest = modelInputDigest(
      base,
      captureOf(input.route.model, ['text', 'image']),
      wireOf('image'),
    )
    const locked = { ...base, inputDigest, preparedId: preparedIdOf(inputDigest) }
    prepared.set(locked.preparedId, locked)
    return {
      ok: true,
      value: pack(RuntimeMethodSchemaRefs['agh.model'].prepare.output, {
        preparedRef: pack(SCHEMA, { preparedId: locked.preparedId }),
        targetSnapshot: input.route,
        inputDigest,
        estimatedUnits: [],
        mediaPlanRefs: plans.map((plan) => pack(SCHEMA, plan)),
      }),
    }
  },
  async resolveData() {
    return failure('worker')
  },
  prepare: (spec) => ({
    ok: true,
    value: { ...spec, obligation: 'mandatory', intentFingerprint: digestOf(spec) } as W.PreparedAction,
  }),
}

async function mediaAction(parentId: string) {
  const provider = await createDefaultMediaFactory(deployment()).create(
    pack(SCHEMA, {}),
    {} as never,
    {
      bindingId: mediaBinding.bindingId,
      instanceId: 'instance',
      signal: new AbortController().signal,
    } as never,
  )
  const action = await provider.actions?.prepare?.create({
    instanceId: 'instance',
    actionId: parentId,
    runId: 'run',
    bindingId: mediaBinding.bindingId,
    scope: context().scope,
    signal: new AbortController().signal,
  } as never)
  if (action?.kind !== 'composite') throw new Error('composite')
  return action
}

/** Runs the real adapter for one request against the local peer and returns its own EffectResult. */
async function adapter(
  role: string,
  locked: W.PreparedModelRequest,
  media: readonly ResolvedMedia[],
  input: ModelRecord['input'],
  slot: 'image' | 'primary',
) {
  const id = locked.target.model
  const fixture = await modelCrashFixture(
    api,
    endpoint,
    join(world, `${role}.receipt.json`),
    join(world, `${role}.operation.json`),
    false,
    undefined,
    {
      model: { id, input },
      prepared: () => locked,
      request: (p) => ok(buildWireRequest(p, captureOf(id, input), wireOf(slot), media)),
      media: () => media.map(toModelWireMedia),
    },
  )
  return fixture.action.execute(fixture.frame, fixture.call)
}

async function nativeMedia(locked: W.PreparedModelRequest, owner: string): Promise<ResolvedMedia[]> {
  const resolved: ResolvedMedia[] = []
  for (const plan of locked.mediaPlans) {
    const action = await mediaAction(`${owner}-${plan.key}`)
    const done = await action.start(frameFor(plan, `${owner}-${plan.key}`), ports)
    if (done.next.kind !== 'complete' || done.next.output.kind !== 'inline')
      throw new Error('native media did not complete')
    const media = ok(validateRuntime('PreparedMedia', done.next.output.value) as Outcome<W.PreparedMedia>)
    const verified = ok(verifyPreparedMedia(plan, media, { child: null }))
    resolved.push(ok(await resolveMediaParts(verified, reader, LIMITS, context())))
  }
  return resolved
}

/** Converts the main request's media: the media child, a vision request through the real adapter, its receipt. */
async function convertThroughVision(parentId: string) {
  const action = await mediaAction(parentId)
  const frame = frameFor(mainPlan(), parentId)
  const first = await action.start(frame, ports)
  const frame1: ActionFrame = { ...frame, providerRevision: 1, continuation: first.continuation }
  const second = await action.resume(frame1, ports)
  const child = second.children[0]
  if (!child) throw new Error('no vision child')
  // Stand-in for the model composite: take the vision request the child names and run the real adapter.
  const preparedId = (child.input as unknown as { value: { preparedRef: { value: { preparedId: string } } } })
    .value.preparedRef.value.preparedId
  const locked = prepared.get(preparedId)
  if (!locked) throw new Error('vision request is not prepared in this process')
  const media = await nativeMedia(locked, `vision-${parentId}`)
  const result = await adapter(`vision-${parentId}`, locked, media, ['text', 'image'], 'image')
  const actionId = `vision-child-${parentId}`
  const receiptId = `vision-receipt-${parentId}`
  const view: W.ActionResultView = {
    receiptId,
    actionId,
    attemptId: `${actionId}-attempt`,
    bindingId: child.target.bindingId,
    inputDigest: (child.input as { digest: string }).digest,
    outcome: result.outcome,
    // The model composite re-publishes the adapter's output as its own `infer` result, same body.
    ...(result.result?.kind === 'inline'
      ? { result: pack(RuntimeMethodSchemaRefs['agh.model'].infer.output, result.result.value) }
      : {}),
    ...(result.error ? { error: result.error } : {}),
    externalRequests: result.externalRequests,
    usageRefs: result.usage.map((u) => u.usageId),
    references: [],
    provenance: { sourceRefs: [], producer: modelBinding, trustLabels: [] },
    completedAt: new Date().toISOString(),
    visibility: 'ready',
    viewId: `${actionId}-view`,
    sourceReceiptId: receiptId,
    hookResultSetRef: null,
  }
  const saved = load()
  saved.receipts[`${actionId}:${receiptId}`] = view
  saved.parents[parentId] = {
    ...frame1,
    providerRevision: 2,
    continuation: second.continuation,
    receipts: {
      items: [{ actionId, receiptId, outcome: result.outcome }],
      snapshot: 'published',
      nextCursor: null,
      complete: true,
    },
  }
  save(saved)
  return { outcome: result.outcome, usageIds: result.usage.map((u) => u.usageId) }
}

/** Resumes the saved parent, publishes its result as State would, and reads it back the way a consumer does. */
async function completedMedia(parentId: string) {
  const parent = load().parents[parentId]
  if (!parent) throw new Error('no saved parent')
  const action = await mediaAction(parentId)
  let out = await action.resume(parent, ports)
  if (out.next.kind === 'wait') {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(parent.context.deadline) - Date.now()) + 50),
    )
    out = await action.resume(parent, ports)
  }
  const children = out.children.length
  if (out.next.kind === 'fail') {
    const detail = out.next.error.detailCode
    return { children, failed: `${out.next.error.code}/${detail}`, detail }
  }
  if (out.next.kind !== 'complete') return { children, failed: out.next.kind, detail: out.next.kind }
  const plan = mainPlan()
  const after = load()
  after.receipts[`${parentId}:media-receipt-${parentId}`] = {
    receiptId: `media-receipt-${parentId}`,
    actionId: parentId,
    attemptId: 'a',
    bindingId: mediaBinding.bindingId,
    inputDigest: digestOf(plan),
    outcome: 'succeeded',
    result: out.next.output,
    externalRequests: [],
    usageRefs: [],
    references: [],
    provenance: { sourceRefs: [], producer: mediaBinding, trustLabels: [] },
    completedAt: new Date().toISOString(),
    visibility: 'ready',
    viewId: 'v',
    sourceReceiptId: `media-receipt-${parentId}`,
    hookResultSetRef: null,
  }
  save(after)
  const collected = await collectPreparedMedia({
    plans: [plan],
    receipts: [{ actionId: parentId, receiptId: `media-receipt-${parentId}` }],
    ports,
    state: stateBinding,
    context: context(),
  })
  if (collected.kind !== 'ready')
    return {
      children,
      failed: 'collect',
      detail: collected.kind === 'failed' ? collected.error.detailCode : 'pending',
    }
  const verified = collected.media[0]
  if (!verified) return { children, failed: 'collect', detail: 'empty' }
  const resolved = await resolveMediaParts(verified, reader, LIMITS, context())
  if (!resolved.ok) return { children, failed: resolved.error.detailCode, detail: resolved.error.detailCode }
  return {
    children,
    verified: true,
    mediaDigest: verified.mediaDigest,
    usageIds: verified.usageIds,
    resolved: resolved.value,
  }
}

const mainPrepared = (): W.PreparedModelRequest => {
  const base: W.PreparedModelRequest = {
    preparedId: 'pending',
    ownerBinding: modelBinding,
    target: mainRoute,
    view: mainView(),
    inputDigest: '0'.repeat(64),
    outputSchema: null,
    toolCatalog: null,
    generation: { maxOutputTokens: 64, thinking: null },
    mediaPlans: [mainPlan()],
    estimatedUnits: [],
    hookResults: null,
    sessionParameterRef: {
      authorityId: 'fixture-config',
      recordId: 'parameters',
      recordRevision: 1,
      schema: SCHEMA,
      digest: digestOf({}),
    },
    legacyRequestOverrides: null,
    credentialRef: HANDLE,
  }
  const inputDigest = modelInputDigest(
    base,
    captureOf('text-model', scenario === 'native' ? ['text', 'image'] : ['text']),
    wireOf('primary'),
  )
  return { ...base, inputDigest, preparedId: preparedIdOf(inputDigest) }
}

/**
 * The handle reference a process before the restart sent for the main request. Its registry entry lived
 * in that process; here only the reference exists.
 */
function oldHandle() {
  const locked = mainPrepared()
  const capture = captureOf('text-model', scenario === 'native' ? ['text', 'image'] : ['text'])
  const header = headerOf(locked, capture, wireOf('primary'))
  const handle: W.PreparedModelHandle = {
    kind: 'agh.model/prepared-handle@1',
    handleId: handleIdOf({
      runId: fixtureIds.runId,
      sessionId: fixtureIds.sessionId,
      inputDigest: locked.inputDigest,
    }),
    inputDigest: locked.inputDigest,
    ownerBinding: locked.ownerBinding,
    header,
  } as W.PreparedModelHandle
  return pack(RuntimeSchemaRefs.PreparedModelHandle, handle) as Extract<W.DataRef, { kind: 'inline' }>
}

process.on('message', async (message: unknown) => {
  if (message === null || typeof message !== 'object' || (message as { op?: unknown }).op !== 'go') return
  try {
    if (mode === 'first') {
      const durable = await convertThroughVision('media-parent')
      send({ phase: 'durable', ...durable })
      await new Promise<never>(() => {}) // the test kills this process here
    } else if (mode === 'resume') {
      const { resolved: _resolved, ...answer } = await completedMedia('media-parent')
      send({ phase: 'media', ...answer })
    } else if (mode === 'main') {
      if (scenario === 'native') {
        const locked = mainPrepared()
        const media = await nativeMedia(locked, 'main')
        const result = await adapter('main', locked, media, ['text', 'image'], 'primary')
        send({ phase: 'sent', usageIds: result.usage.map((u) => u.usageId) })
      } else {
        // The main request's prepared call lived in the process that died: this process has an empty registry.
        const ref = oldHandle()
        const registry = createPreparedRegistry()
        const entryProbe: PreparedEntry | undefined = registry.get(
          handleIdOf({
            runId: fixtureIds.runId,
            sessionId: fixtureIds.sessionId,
            inputDigest: mainPrepared().inputDigest,
          }),
        )
        const loaded = await createModelSourceReader({
          packageDigest: 'c'.repeat(64),
          registry,
          prices: { version: (target) => target.priceVersion },
          session: sessionWith({}),
          authorize: { epoch: () => 1 },
        }).load(ref, fixtureFrame(ref), fixtureContext(new AbortController().signal))
        send({
          phase: loaded.ok ? 'loaded' : 'lost',
          detail: loaded.ok ? null : loaded.error.detailCode,
          registryHit: entryProbe !== undefined,
        })
      }
    } else {
      // Stand-in for the Loop planning again after the miss: a new parent action converts and the main request goes out.
      const durable = await convertThroughVision('media-parent-2')
      const done = await completedMedia('media-parent-2')
      if (!('resolved' in done) || !done.resolved) return send({ phase: 'refused', detail: done.detail })
      const result = await adapter('main', mainPrepared(), [done.resolved], ['text'], 'primary')
      send({
        phase: 'sent',
        usageIds: result.usage.map((u) => u.usageId),
        conversionUsageIds: durable.usageIds,
      })
    }
  } catch (error) {
    send({ phase: 'error', message: error instanceof Error ? error.message : 'worker failed' })
  }
})
send({ phase: 'ready' })
