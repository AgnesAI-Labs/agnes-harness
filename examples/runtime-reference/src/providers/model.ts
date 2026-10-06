import type {
  ActionHandlerScope,
  ActionProviderFactory,
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  FactoryContext,
  LoopReadPorts,
  Outcome,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import type { ModelRecord, RequestBody } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import { RequestBody as WireBodySchema } from '@agnes/protocol/gen/model'
import {
  type ActionFrame,
  type BindingRef,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type DomainReference,
  type ExactQuantity,
  type JsonValue,
  MAX_AUTHOR_INLINE_BYTES,
  type ModelPrepareRequest,
  type ModelPrepareResult,
  type ModelRouteSnapshot,
  type NextStep,
  type OwnerRef,
  type PreparedAction,
  type PreparedModelHeader,
  type PreparedModelRequest,
  type ProviderDescriptor,
  type ProviderTransition,
  RuntimeAuthorCapabilities,
  type RuntimeError,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  type RuntimeWireTypes,
  type SchemaRef,
  type SecretConsumerBinding,
  type SecretHandle,
  type StateCodecRef,
  type VersionedState,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { type ReferenceResolvedTools, toolHistoryOf, toolSchemasOf, withDescriptions } from './model-tools.js'

/*
 * Independent reference for the `agh.model` provider. It shares no code with the default: the
 * preparation steps are an ordered table, the registry keeps serialised text, and the lifecycle of
 * both actions comes from one builder. The behaviour it must match is the public contract only.
 */

type Digest = string
type Code = RuntimeError['code']
type Refusal = readonly [Code, string]
type BodySlot = RequestBody['slot']

/** The route and model record the catalog contributes to the input digest. */
export type ReferenceCatalogPick = Readonly<{
  route: Readonly<{ route: string; api: string; baseUrl: string; compat?: unknown; keyless?: boolean }>
  model: ModelRecord
}>
export type ReferenceWireIdentity = Readonly<{
  sessionKey: string
  slot: BodySlot
  contractId: string | null
}>
type Capture = Readonly<{
  adapterPackageDigest: string
  route: Record<string, JsonValue>
  model: ModelRecord
}>

/** What one prepared call keeps in this process: the facts a later start compares, and the wire body. */
export type ReferenceModelHold = Readonly<{
  runId: string
  sessionId: string
  ownerBinding: BindingRef
  inputDigest: Digest
  header: PreparedModelHeader
  body: RequestBody
}>
export interface ReferenceModelRegistry {
  put(handleId: string, hold: ReferenceModelHold): void
  get(handleId: string): ReferenceModelHold | undefined
  clear(): void
  readonly size: number
}

export interface ReferenceModelDeployment {
  readonly packageDigest: string
  readonly config: AuthorSchema<EmptyAuthorConfig>
  /** Registered provider id; a host that registers this recipe under another name sets it. */
  readonly providerId?: string
  readonly secrets: BindingRef | null
  readonly state: BindingRef
  current(context: CallContext): boolean
  catalog: {
    capture(
      context: CallContext,
    ): Outcome<
      Readonly<{ digest: string; select(route: string, model: string): ReferenceCatalogPick | undefined }>
    >
  }
  prices: { version(target: ModelRouteSnapshot, capture: Capture): string | null }
  wire: {
    resolve(request: {
      context: CallContext
      sessionParameterRef: DomainReference
      route: ModelRouteSnapshot
    }): Promise<Outcome<ReferenceWireIdentity>>
  }
  adapters: {
    select(target: BindingRef, context: CallContext): { binding: BindingRef; packageDigest: string } | null
  }
  /** Resolves a request's tool catalog to descriptions and schema documents; absent or refusing keeps `model_wire_tools`. */
  tools?: {
    resolve(request: {
      context: CallContext
      catalog: NonNullable<ModelPrepareRequest['toolCatalog']>
    }): Promise<Outcome<ReferenceResolvedTools>>
  }
  credentials?: {
    verifyIssued(handle: SecretHandle, binding: SecretConsumerBinding, context: CallContext): Promise<boolean>
  }
  estimate?(prepared: PreparedModelRequest): readonly ExactQuantity[]
  registry: ReferenceModelRegistry
  bridge: { ready(context: CallContext): Outcome<void> }
  now?(): number
}

const methods = RuntimeMethodSchemaRefs['agh.model']
const BOUNDS = { maxBytes: MAX_AUTHOR_INLINE_BYTES, maxDepth: 128, maxMembers: 10000 }
const HANDLE_KIND = 'agh.model/prepared-handle@1'
const CHILD_KEY = 'adapter-invoke'
const digestOf = (value: unknown): Digest => canonicalJsonDigest(value as never)
const equal = (a: unknown, b: unknown) => digestOf(a) === digestOf(b)

/** A bounded in-process registry. Entries are kept as canonical text, so a reader can never alter one. */
export function createReferenceModelRegistry(
  options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {},
): ReferenceModelRegistry {
  const limit = Math.max(1, options.maxEntries ?? 256)
  const ttl = options.ttlMs ?? 30 * 60_000
  const clock = options.now ?? Date.now
  const rows = new Map<string, { text: string; until: number }>()
  const sweep = () => {
    const at = clock()
    for (const [key, row] of rows) if (row.until <= at) rows.delete(key)
  }
  return {
    put(handleId, hold) {
      sweep()
      const text = JSON.stringify(
        boundedCanonicalJson(hold, BOUNDS).ok ? JSON.parse(JSON.stringify(hold)) : null,
      )
      const prior = rows.get(handleId)
      if (prior && digestOf(JSON.parse(prior.text)) !== digestOf(JSON.parse(text)))
        throw new Error('Prepared handle already holds other content')
      rows.delete(handleId)
      rows.set(handleId, { text: prior?.text ?? text, until: clock() + ttl })
      while (rows.size > limit) {
        const oldest = rows.keys().next()
        if (oldest.done) break
        rows.delete(oldest.value)
      }
    },
    get(handleId) {
      sweep()
      const row = rows.get(handleId)
      return row ? (JSON.parse(row.text) as ReferenceModelHold) : undefined
    },
    clear: () => rows.clear(),
    get size() {
      sweep()
      return rows.size
    },
  }
}

class Refused extends Error {
  constructor(
    readonly code: Code,
    readonly detail: string,
    readonly owner?: OwnerRef,
  ) {
    super(detail)
  }
}
const stop = (code: Code, detail: string, owner?: OwnerRef): never => {
  throw new Refused(code, detail, owner)
}
const refuse = (code: Code, detail: string, owner?: OwnerRef): Outcome<never> => {
  if (code === 'unknown_effect' && !owner) throw new TypeError('unknown_effect needs an owner')
  return {
    ok: false,
    error: {
      code,
      detailCode: detail,
      message: 'Model request refused',
      retryAdvice:
        owner && code === 'unknown_effect' ? { kind: 'reconcile', ownerRef: owner } : { kind: 'never' },
      diagnosticId: 'model-provider',
    },
  }
}
const errorOf = (cause: unknown): RuntimeError => {
  const out =
    cause instanceof Refused
      ? refuse(cause.code, cause.detail, cause.owner)
      : refuse('retryable', 'model_dependency_unavailable')
  return out.ok ? stop('internal', 'unreachable') : out.error
}
const asOutcome = (cause: unknown): Outcome<never> => ({ ok: false, error: errorOf(cause) })

function inline(schema: SchemaRef, value: unknown): Extract<DataRef, { kind: 'inline' }> {
  const body = boundedCanonicalJson(value, BOUNDS)
  if (!body.ok) return stop('quota', 'model_output_budget')
  return {
    kind: 'inline',
    schema,
    value: body.value.json,
    digest: digestOf(body.value.json),
    bytes: body.value.bytes,
  }
}
/** Read a reference back: the schema, the digest of its own value and the named wire type must all hold. */
function open<K extends keyof RuntimeWireTypes>(
  ref: DataRef,
  schema: SchemaRef,
  name: K,
  fail: Refusal = ['invalid_input', 'model_input_schema'],
): RuntimeWireTypes[K] {
  const sound = ref.kind === 'inline' && equal(ref.schema, schema) && ref.digest === digestOf(ref.value)
  const parsed = sound ? validateRuntime(name, ref.value) : null
  return parsed?.ok ? (parsed.value as RuntimeWireTypes[K]) : stop(fail[0], fail[1])
}
function rawInline(ref: DataRef, schema: SchemaRef): unknown {
  const sound = ref.kind === 'inline' && equal(ref.schema, schema) && ref.digest === digestOf(ref.value)
  return sound && ref.kind === 'inline' ? ref.value : stop('incompatible', 'model_child_invalid')
}
async function until<T>(work: Promise<T>, call: CallContext): Promise<T> {
  const cancelled = () => new Refused('cancelled', 'model_cancelled')
  if (call.signal.aborted) throw cancelled()
  let detach = () => {}
  const interrupt = new Promise<never>((_, reject) => {
    const onAbort = () => reject(cancelled())
    call.signal.addEventListener('abort', onAbort, { once: true })
    detach = () => call.signal.removeEventListener('abort', onAbort)
  })
  try {
    return await Promise.race([work, interrupt])
  } finally {
    detach()
  }
}
const ownerOf = (scope: CallContext['scope']) =>
  scope.kind === 'run' || scope.kind === 'action'
    ? { sessionId: scope.sessionId, runId: scope.runId }
    : stop('denied', 'model_scope')

// ---- digest, wire request and handle -------------------------------------------------------------

const PREIMAGE_DROPS = new Set(['preparedId', 'inputDigest', 'estimatedUnits'])
function inputDigestOf(
  prepared: PreparedModelRequest,
  capture: Capture,
  wire: ReferenceWireIdentity,
  tools: ReferenceResolvedTools | null = null,
): Digest {
  const kept = Object.entries(prepared).filter(([name]) => !PREIMAGE_DROPS.has(name))
  return digestOf({
    kind: 'agh.model/input@1',
    ...Object.fromEntries(kept),
    wire: withDescriptions(wire, tools),
    capture,
  })
}

const WIRE_REFUSALS: ReadonlyArray<readonly [string, (p: PreparedModelRequest) => boolean]> = [
  ['model_wire_output_schema', (p) => p.outputSchema !== null],
  ['model_wire_media', (p) => p.mediaPlans.length > 0],
  ['model_wire_overrides', (p) => p.hookResults !== null || p.legacyRequestOverrides !== null],
  ['model_wire_seed', (p) => p.generation.seed !== undefined],
]
function wireBodyOf(
  prepared: PreparedModelRequest,
  capture: Capture,
  wire: ReferenceWireIdentity,
  tools: ReferenceResolvedTools | null = null,
): RequestBody {
  const fail = (detail: string): never => stop('incompatible', detail)
  const { toolCatalog } = prepared
  if ((toolCatalog === null) !== (tools === null)) fail('model_wire_tools')
  const schemas =
    toolCatalog === null || tools === null
      ? []
      : toolSchemasOf(toolCatalog, tools, prepared, capture as never, fail)
  for (const [detail, applies] of WIRE_REFUSALS) if (applies(prepared)) fail(detail)
  const system: string[] = []
  const messages: RequestBody['messages'] = []
  for (let at = 0; at < prepared.view.items.length; at += 1) {
    const item = prepared.view.items[at] as PreparedModelRequest['view']['items'][number]
    if (tools !== null && (item.kind === 'tool-call' || item.kind === 'tool-result')) {
      const run = toolHistoryOf(prepared.view.items, at, prepared, capture as never, fail)
      messages.push(...run.messages)
      at = run.end - 1
      continue
    }
    const text = item.body.kind === 'inline' && typeof item.body.value === 'string' ? item.body.value : null
    const side = item.kind === 'message' && text !== null ? item.trust : null
    if (side === 'system') system.push(text as string)
    else if (side === 'user')
      messages.push({ role: 'user', content: [{ type: 'text', text: text as string }] })
    else stop('incompatible', 'model_wire_item')
  }
  if (messages.length === 0) stop('incompatible', 'model_wire_empty')
  const { generation } = prepared
  const candidate = {
    kind: 'inference',
    sessionKey: wire.sessionKey,
    slot: wire.slot,
    route: capture.route.route,
    model: prepared.target.model,
    contractId: wire.contractId,
    derivedHash: inputDigestOf(prepared, capture, wire, tools),
    system: system.join('\n\n'),
    messages,
    tools: schemas,
    sampling: {
      maxTokens: generation.maxOutputTokens,
      ...(generation.temperature === undefined ? {} : { temperature: generation.temperature }),
      ...(generation.thinking === null ? {} : { thinking: generation.thinking }),
    },
  }
  const checked = validateAgainst<RequestBody>(WireBodySchema, candidate)
  return checked.ok ? checked.value : stop('incompatible', 'model_wire_schema')
}
const handleIdOf = (runId: string, sessionId: string, inputDigest: Digest) =>
  `hdl-${digestOf({ kind: HANDLE_KIND, runId, sessionId, inputDigest }).slice(0, 32)}`
const externalKeyOf = (runId: string, parentActionId: string) =>
  `ext-${digestOf({ kind: 'agh.model/external-key@1', runId, parentActionId, key: CHILD_KEY })}`

type Assembly = Readonly<{
  prepared: PreparedModelRequest
  handleId: string
  ref: Extract<DataRef, { kind: 'inline' }>
  hold: ReferenceModelHold
}>
function assemble(args: {
  runId: string
  sessionId: string
  owner: BindingRef
  request: ModelPrepareRequest
  capture: Capture
  wire: ReferenceWireIdentity
  units: readonly ExactQuantity[]
  tools: ReferenceResolvedTools | null
}): Assembly {
  const { request, capture, wire, owner, tools } = args
  const draft: PreparedModelRequest = {
    preparedId: 'pending',
    ownerBinding: owner,
    target: request.route,
    view: request.view,
    inputDigest: '0'.repeat(64),
    outputSchema: request.outputSchema,
    toolCatalog: request.toolCatalog,
    generation: request.generation,
    mediaPlans: [],
    estimatedUnits: [...args.units],
    hookResults: null,
    sessionParameterRef: request.sessionParameterRef,
    legacyRequestOverrides: null,
    credentialRef: request.credentialRef,
  }
  const inputDigest = inputDigestOf(draft, capture, wire, tools)
  const prepared = { ...draft, inputDigest, preparedId: `prep-${inputDigest.slice(0, 32)}` }
  const body = wireBodyOf(prepared, capture, wire, tools)
  if (!validateRuntime('PreparedModelRequest', prepared).ok) stop('invalid_input', 'model_input_schema')
  if (!boundedCanonicalJson(prepared, BOUNDS).ok) stop('incompatible', 'model_prepared_too_large')
  const header: PreparedModelHeader = {
    route: prepared.target,
    adapterPackageDigest: capture.adapterPackageDigest,
    maxOutputTokens: prepared.generation.maxOutputTokens,
    thinking: prepared.generation.thinking,
    wire: {
      slot: wire.slot,
      contractId: wire.contractId,
      sessionKeyDigest: digestOf({ kind: 'agh.model/session-key@1', sessionKey: wire.sessionKey }),
    },
    sessionParameterRef: prepared.sessionParameterRef,
    credentialRef: prepared.credentialRef,
    mediaPlanDigests: prepared.mediaPlans.map(digestOf),
  }
  const handleId = handleIdOf(args.runId, args.sessionId, inputDigest)
  const handle = { kind: HANDLE_KIND, handleId, inputDigest, ownerBinding: owner, header }
  if (!validateRuntime('PreparedModelHandle', handle).ok) stop('invalid_input', 'model_input_schema')
  const sized = boundedCanonicalJson(handle, BOUNDS)
  if (!sized.ok) stop('incompatible', 'model_prepared_too_large')
  return {
    prepared,
    handleId,
    ref: inline(RuntimeSchemaRefs.PreparedModelHandle, handle),
    hold: { runId: args.runId, sessionId: args.sessionId, ownerBinding: owner, inputDigest, header, body },
  }
}
/** The caller's handle reference: its schema, digest and byte count must be those of its own body. */
function readHandle(ref: DataRef) {
  if (ref.kind !== 'inline') return null
  const sized = boundedCanonicalJson(ref.value, BOUNDS)
  const sound =
    sized.ok &&
    equal(ref.schema, RuntimeSchemaRefs.PreparedModelHandle) &&
    ref.digest === digestOf(ref.value) &&
    ref.bytes === sized.value.bytes
  const parsed = sound ? validateRuntime('PreparedModelHandle', ref.value) : null
  return parsed?.ok && parsed.value.kind === HANDLE_KIND ? { ref, handle: parsed.value } : null
}

// ---- preparation ---------------------------------------------------------------------------------

type Scratch = {
  adapter?: { binding: BindingRef; packageDigest: string }
  capture?: Capture
}
type Gate = (
  d: ReferenceModelDeployment,
  input: ModelPrepareRequest,
  call: CallContext,
  s: Scratch,
  viaAction: boolean,
) => Refusal | null | undefined | Promise<Refusal | null>
const credentialRefusal = (
  route: ModelRouteSnapshot,
  handle: SecretHandle | null,
  at: number,
): Refusal | null => {
  const binding = route.credentialBinding
  if (binding === null) return handle === null ? null : ['denied', 'model_credential_binding']
  const related =
    handle !== null &&
    binding.consumer === 'model' &&
    binding.secretId === handle.secretId &&
    binding.audience === handle.audience &&
    route.credentialAudience === handle.audience
  if (!related) return ['denied', 'model_credential_binding']
  return Date.parse(handle.expiresAt) > at ? null : ['denied', 'model_credential_expired']
}
const clockOf = (d: ReferenceModelDeployment) => (d.now ?? Date.now)()
const PREPARE_GATES: readonly Gate[] = [
  (d, _i, call) => (d.current(call) ? null : ['denied', 'model_binding_denied']),
  (_d, _i, call) =>
    call.scope.kind === 'run' || call.scope.kind === 'action' ? null : ['denied', 'model_scope'],
  (_d, i) => (i.hookResults === null ? null : ['incompatible', 'model_hooks_unsupported']),
  (d, i) => credentialRefusal(i.route, i.credentialRef, clockOf(d)),
  async (d, i, call, _s, viaAction) => {
    if (viaAction || i.route.credentialBinding === null) return null
    const verified =
      d.credentials !== undefined &&
      (await until(
        d.credentials.verifyIssued(i.credentialRef as SecretHandle, i.route.credentialBinding, call),
        call,
      )) === true
    return verified ? null : ['incompatible', 'model_credential_unverified']
  },
  (d, i, call, s) => {
    const picked = d.adapters.select(i.route.adapter, call)
    if (picked) s.adapter = picked
    return picked && equal(picked.binding, i.route.adapter) ? null : ['denied', 'model_adapter_unavailable']
  },
  (_d, i) =>
    (i.toolCatalog !== null && !i.route.features.tools) ||
    (i.outputSchema !== null && !i.route.features.structuredOutput)
      ? ['incompatible', 'model_feature_mismatch']
      : null,
  (d, i, call, s) => {
    const catalog = d.catalog.capture(call)
    if (!catalog.ok) return [catalog.error.code, catalog.error.detailCode]
    const hit = catalog.value.select(i.route.routeId, i.route.model)
    if (!hit) return ['denied', 'model_catalog_missing']
    const { route } = hit
    s.capture = {
      adapterPackageDigest: (s.adapter as NonNullable<Scratch['adapter']>).packageDigest,
      route: {
        route: route.route,
        api: route.api,
        baseUrl: route.baseUrl,
        ...(route.compat === undefined ? {} : { compat: route.compat as JsonValue }),
        ...(route.keyless === undefined ? {} : { keyless: route.keyless }),
      },
      model: hit.model,
    }
    return null
  },
  (d, i, _call, s) => {
    const price = d.prices.version(i.route, s.capture as Capture)
    if (price === null) return ['internal', 'model_not_ready']
    return price === i.route.priceVersion ? null : ['denied', 'model_price_mismatch']
  },
]

async function prepareOnce(
  d: ReferenceModelDeployment,
  owner: BindingRef,
  input: ModelPrepareRequest,
  call: CallContext,
  viaAction: boolean,
): Promise<ModelPrepareResult> {
  const cancelled = () => stop('cancelled', 'model_cancelled')
  if (call.signal.aborted) cancelled()
  const scratch: Scratch = {}
  for (const gate of PREPARE_GATES) {
    const failure = await gate(d, input, call, scratch, viaAction)
    if (failure) stop(failure[0], failure[1])
  }
  const { sessionId, runId } = ownerOf(call.scope)
  const capture = scratch.capture as Capture
  const wire = await until(
    d.wire.resolve({ context: call, sessionParameterRef: input.sessionParameterRef, route: input.route }),
    call,
  )
  if (!wire.ok) stop(wire.error.code, wire.error.detailCode)
  // The adapter sends only with a bound credential, so a route without one is refused by name.
  if (input.route.credentialBinding === null) stop('incompatible', 'model_credential_required')
  const answer =
    input.toolCatalog === null || !d.tools
      ? null
      : await until(d.tools.resolve({ context: call, catalog: input.toolCatalog }), call)
  const tools = answer?.ok ? answer.value : null
  const build = (units: readonly ExactQuantity[]) =>
    assemble({
      runId,
      sessionId,
      owner,
      request: input,
      capture,
      wire: (wire as Extract<typeof wire, { ok: true }>).value,
      units,
      tools,
    })
  const first = build([])
  const estimated = d.estimate ? [...d.estimate(first.prepared)] : []
  const final = estimated.length === 0 ? first : build(estimated)
  if (call.signal.aborted) cancelled()
  d.registry.put(final.handleId, final.hold)
  return {
    preparedRef: final.ref,
    targetSnapshot: input.route,
    inputDigest: final.prepared.inputDigest,
    estimatedUnits: final.prepared.estimatedUnits,
    mediaPlanRefs: [],
  }
}

// ---- actions --------------------------------------------------------------------------------------

const continuationDigest = (required: string[], properties: Record<string, unknown>): Digest =>
  digestOf({ type: 'object', additionalProperties: false, required, properties })
const prepareCodec: StateCodecRef = {
  namespace: 'agh.reference/model-prepare-request',
  codecVersion: '1',
  schema: {
    typeId: 'agh.model/prepare-request-continuation@1',
    revision: 1,
    digest: continuationDigest(['request'], { request: { type: 'string' } }),
  },
}
const inferCodec: StateCodecRef = {
  namespace: 'agh.reference/model-infer',
  codecVersion: '1',
  schema: {
    typeId: 'agh.model/infer-continuation@1',
    revision: 1,
    digest: continuationDigest(['request', 'child'], {
      request: { type: 'string' },
      child: { type: 'object' },
    }),
  },
}
type Child = { childKey: string; externalKey: string; adapter: BindingRef; childInputDigest: Digest }
type Shared = {
  d: ReferenceModelDeployment
  owner: BindingRef
  factory: FactoryContext
  phase: () => string
  active: Set<string>
}
type StepInput = Readonly<{
  frame: ActionFrame
  ports: LoopReadPorts
  call: CallContext
  scope: ActionHandlerScope
  closed: () => boolean
  resumed: boolean
}>

/** The lifecycle both composite actions share; only the step and what `drain` reports differ. */
function actionOf(
  shared: Shared,
  codec: StateCodecRef,
  step: (input: StepInput) => Promise<ProviderTransition>,
  reportsActive: boolean,
): ActionProviderFactory {
  const { factory, active } = shared
  return {
    kind: 'composite',
    recovery: 'R2',
    stateCodec: codec,
    async create(scope: ActionHandlerScope) {
      const closing = new AbortController()
      const run = (resumed: boolean) => async (frame: ActionFrame, ports: LoopReadPorts) => {
        active.add(frame.invocationId)
        try {
          const signal = AbortSignal.any([scope.signal, closing.signal, factory.signal])
          const call: CallContext = { ...frame.context, signal }
          return await step({ frame, ports, call, scope, closed: () => closing.signal.aborted, resumed })
        } finally {
          active.delete(frame.invocationId)
        }
      }
      return {
        kind: 'composite',
        ready: async () =>
          closing.signal.aborted ? refuse('denied', 'provider_closed') : { ok: true, value: undefined },
        health: async () => ({
          ok: true,
          value: { status: closing.signal.aborted ? 'failed' : 'ready', diagnosticIds: [] },
        }),
        async drain() {
          closing.abort()
          const listed = reportsActive ? [...active] : []
          return {
            ok: true,
            value: {
              state: listed.length > 0 ? 'blocked' : 'drained',
              activeInvocationIds: listed,
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        close: async () => closing.abort(),
        start: run(false),
        resume: run(true),
      }
    },
  }
}
const stateOf = (
  shared: Shared,
  codec: StateCodecRef,
  frame: ActionFrame,
  body: unknown,
): VersionedState => ({
  namespace: codec.namespace,
  codecVersion: '1',
  data: inline(codec.schema, body),
  provenance: { sourceRefs: [], producer: shared.owner, trustLabels: [] },
  createdAt: frame.observedAt,
  references: [],
})
function checkFrame(shared: Shared, scope: ActionHandlerScope, frame: ActionFrame, method: string) {
  const own = shared.factory.bindingId
  const declared = frame.input.kind === 'inline' ? frame.input.digest : frame.input.blob.digest
  const fine =
    scope.bindingId === own &&
    frame.bindingId === own &&
    frame.runId === scope.runId &&
    frame.actionId === scope.actionId &&
    frame.method === method &&
    frame.inputDigest === declared
  if (!fine) stop('denied', 'model_binding_denied')
}
const notOpen = (shared: Shared, closed: () => boolean) => {
  if (closed() || shared.phase() !== 'ready') stop('denied', 'provider_closed')
}

function prepareRequestAction(shared: Shared): ActionProviderFactory {
  const { d, owner } = shared
  return actionOf(
    shared,
    prepareCodec,
    async ({ frame, ports, call, scope, closed }) => {
      const finish = (next: NextStep): ProviderTransition => ({
        expectedProviderRevision: frame.providerRevision,
        continuation: stateOf(shared, prepareCodec, frame, { request: frame.inputDigest }),
        consumeSignals: [],
        children: [],
        next,
      })
      try {
        notOpen(shared, closed)
        checkFrame(shared, scope, frame, 'prepareRequest')
        const input = open(frame.input, methods.prepareRequest.input, 'ModelPrepareRequestRequest')
        if (input.credentialRefresh !== null) stop('incompatible', 'model_refresh_unsupported')
        let handle: SecretHandle | null = null
        const binding = input.route.credentialBinding
        if (binding !== null) {
          if (!d.secrets) stop('incompatible', 'model_credential_unverified')
          const resolve = RuntimeMethodSchemaRefs['agh.secrets'].resolve
          const reply = await until(
            ports.query({
              target: d.secrets as BindingRef,
              method: 'resolve',
              input: inline(resolve.input, {
                secretId: binding.secretId,
                audience: binding.audience,
                purpose: binding.purpose,
              }),
            }),
            call,
          )
          if (!reply.ok || reply.value.kind !== 'value') stop('internal', 'model_credential_unavailable')
          const answered = reply.ok && reply.value.kind === 'value' ? reply.value.output : null
          handle = open(answered as DataRef, resolve.output, 'SecretHandle')
        }
        if (input.credentialRef !== null && !equal(input.credentialRef, handle))
          stop('denied', 'model_credential_binding')
        const { credentialRefresh: _dropped, ...rest } = input
        const result = await prepareOnce(
          d,
          owner,
          { ...rest, hookResults: null, credentialRef: handle },
          call,
          true,
        )
        return finish({
          kind: 'complete',
          output: inline(methods.prepareRequest.output, result),
          references: [],
        })
      } catch (cause) {
        return finish({ kind: 'fail', error: errorOf(cause) })
      }
    },
    false,
  )
}

function inferAction(shared: Shared): ActionProviderFactory {
  const { d, owner } = shared
  const probe = RuntimeMethodSchemaRefs['agh.state'].probeActionResult
  const retryNever = { mode: 'never', maxAttempts: 1, backoffMs: [] } as const
  return actionOf(
    shared,
    inferCodec,
    async ({ frame, ports, call, scope, closed, resumed }) => {
      let child: Child | null = null
      const finish = (next: NextStep, children: PreparedAction[] = []): ProviderTransition => ({
        expectedProviderRevision: frame.providerRevision,
        continuation: stateOf(shared, inferCodec, frame, { request: frame.inputDigest, child: child ?? {} }),
        consumeSignals: [],
        children,
        next,
      })
      const waitForChild = (): NextStep => ({
        kind: 'wait',
        condition: {
          anyOf: [
            { kind: 'actions', mode: 'all', actions: [{ localKey: CHILD_KEY }], readyWhen: 'resolved' },
          ],
          deadline: frame.context.deadline,
        },
      })
      try {
        notOpen(shared, closed)
        if (call.signal.aborted) stop('cancelled', 'model_cancelled')
        if (!d.current(call)) stop('denied', 'model_binding_denied')
        checkFrame(shared, scope, frame, 'infer')
        const request = open(frame.input, methods.infer.input, 'ModelInferRequest')
        const read = readHandle(request.preparedRef)
        if (!read) return stop('invalid_input', 'model_infer_input')
        const { ref, handle } = read
        const { sessionId } = ownerOf(call.scope)
        if (handle.handleId !== handleIdOf(frame.runId, sessionId, handle.inputDigest))
          stop('denied', 'model_binding_denied')
        if (!equal(handle.ownerBinding, owner)) stop('denied', 'model_binding_denied')
        const target = handle.header.route
        const adapter = d.adapters.select(target.adapter, call)
        if (!adapter) stop('denied', 'model_adapter_unavailable')
        const bound = (adapter as NonNullable<typeof adapter>).binding
        if (!equal(bound, target.adapter)) stop('denied', 'model_target_changed')
        const credential = credentialRefusal(target, handle.header.credentialRef, clockOf(d))
        if (credential) stop(credential[0], credential[1])
        if (!resumed) {
          const held = d.registry.get(handle.handleId)
          if (!held) stop('incompatible', 'model_prepared_lost')
          const h = held as ReferenceModelHold
          const same =
            h.runId === frame.runId &&
            h.sessionId === sessionId &&
            h.inputDigest === handle.inputDigest &&
            equal(h.ownerBinding, handle.ownerBinding) &&
            equal(h.header, handle.header)
          if (!same) stop('denied', 'model_prepared_mismatch')
        }
        const externalKey = externalKeyOf(frame.runId, frame.actionId)
        const invokeValue = { preparedCallRef: ref, externalIdempotencyKey: externalKey }
        if (!validateRuntime('ModelAdapterInvokeRequest', invokeValue).ok)
          stop('invalid_input', 'model_infer_input')
        const invoke = inline(RuntimeMethodSchemaRefs['agh.model-adapter'].invoke.input, invokeValue)
        child = { childKey: CHILD_KEY, externalKey, adapter: bound, childInputDigest: invoke.digest }
        if (!resumed) {
          if (frame.continuation !== null) stop('conflict', 'model_continuation_conflict')
          const spec = ports.prepare({
            key: CHILD_KEY,
            target: bound,
            method: 'invoke',
            input: invoke,
            dependencies: [],
            retry: { ...retryNever, backoffMs: [] },
            obligation: 'mandatory',
            deadline: frame.context.deadline,
            resultSchema: RuntimeMethodSchemaRefs['agh.model-adapter'].invoke.output,
            references: [],
          })
          if (!spec.ok) return stop(spec.error.code, spec.error.detailCode)
          return finish(waitForChild(), [spec.value])
        }
        const saved = frame.continuation
        const savedOk = saved && saved.namespace === inferCodec.namespace && saved.codecVersion === '1'
        if (!savedOk) stop('conflict', 'model_continuation_conflict')
        const savedBody = rawInline((saved as VersionedState).data, inferCodec.schema)
        if (!equal(savedBody, { request: frame.inputDigest, child }))
          stop('conflict', 'model_continuation_conflict')
        const mine = child as Child
        for (const receipt of frame.receipts.items) {
          const reply = await until(
            ports.query({
              target: d.state,
              method: 'probeActionResult',
              input: inline(probe.input, { actionId: receipt.actionId, sourceReceiptId: receipt.receiptId }),
            }),
            call,
          )
          if (!reply.ok) stop(reply.error.code, 'model_child_invalid')
          if (!reply.ok || reply.value.kind !== 'value') continue
          const view = validateRuntime('ProbeActionResultResult', rawInline(reply.value.output, probe.output))
          if (!view.ok) stop('incompatible', 'model_child_invalid')
          const published = view.ok ? view.value : null
          if (published === null || published.state !== 'ready') continue
          const found = published.result
          const ours =
            found.actionId === receipt.actionId &&
            found.sourceReceiptId === receipt.receiptId &&
            found.bindingId === mine.adapter.bindingId &&
            found.inputDigest === mine.childInputDigest
          if (!ours) continue
          if (found.outcome === 'unknown_effect') {
            if (Date.parse(frame.context.deadline) <= Date.now())
              stop('unknown_effect', 'model_child_unknown', { kind: 'action', id: found.actionId })
            return finish(waitForChild())
          }
          if (found.outcome !== 'succeeded' || !found.result)
            return finish({
              kind: 'fail',
              error: found.error ?? errorOf(new Refused('denied', 'model_child_invalid')),
            })
          const output = validateRuntime(
            'ModelOutput',
            found.result.kind === 'inline' ? found.result.value : null,
          )
          if (!output.ok) return stop('incompatible', 'model_child_invalid')
          const model = output.ok ? output.value : null
          if (model?.usageFactRefs.some((usage) => !found.usageRefs.includes(usage.usageId)))
            stop('denied', 'model_usage_attribution')
          return finish({
            kind: 'complete',
            output: inline(methods.infer.output, model),
            references: [...found.references],
          })
        }
        return finish(waitForChild())
      } catch (cause) {
        return finish({ kind: 'fail', error: errorOf(cause) })
      }
    },
    true,
  )
}

// ---- factory --------------------------------------------------------------------------------------

export function createReferenceModelFactory(d: ReferenceModelDeployment): ProviderFactory<ServiceProvider> {
  const providerId = d.providerId ?? 'agh.reference/model'
  const inference = RuntimeAuthorCapabilities.modelInference
  const capability = {
    ...inference,
    resourceTypes: [...inference.resourceTypes],
    operations: [...inference.operations],
  }
  const operations = (
    [
      ['prepare', 'compute', 'read-only'],
      ['prepareRequest', 'action', 'never'],
      ['infer', 'action', 'never'],
    ] as const
  ).map(([method, kind, retrySafety]) => ({
    method,
    kind,
    inputSchema: methods[method].input,
    outputSchema: methods[method].output,
    requiredCapabilities: method === 'infer' ? [capability] : [],
    retrySafety,
  }))
  const descriptor: ProviderDescriptor = {
    providerId,
    contract: 'agh.model',
    major: 1,
    logicalName: 'default',
    packageVersion: '0.0.0',
    packageDigest: d.packageDigest,
    features: [],
    scope: 'runtime',
    configSchema: d.config.ref,
    requires: [],
    capabilities: [capability],
    recovery: 'R2',
    isolation: ['trusted-in-process'],
    stateCodecs: [prepareCodec, inferCodec],
    activationMode: 'eager',
    operations,
  }
  if (!validateRuntime('ProviderDescriptor', descriptor).ok) throw new TypeError('Invalid model descriptor')
  return {
    descriptor,
    async create(_config, _dependencies, factory) {
      const owner: BindingRef = {
        bindingId: factory.bindingId,
        contract: 'agh.model',
        logicalName: 'default',
        providerId,
      }
      let phase: 'starting' | 'ready' | 'draining' | 'closed' = 'starting'
      const active = new Set<string>()
      const shared: Shared = { d, owner, factory, phase: () => phase, active }
      const live = (call: CallContext) =>
        phase === 'ready' && !factory.signal.aborted && !call.signal.aborted && d.current(call)
      const service: ServiceProvider = {
        async ready(call) {
          const bridge = d.bridge.ready(call)
          if (!bridge.ok) return bridge
          if ((phase !== 'starting' && phase !== 'ready') || !d.current(call))
            return refuse('denied', 'model_binding_denied')
          phase = 'ready'
          return { ok: true, value: undefined }
        },
        health: async (call) => ({
          ok: true,
          value: { status: live(call) ? 'ready' : 'failed', diagnosticIds: [] },
        }),
        async drain() {
          if (phase !== 'closed') phase = 'draining'
          return {
            ok: true,
            value: {
              state: active.size > 0 ? 'blocked' : 'drained',
              activeInvocationIds: [...active],
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        async close() {
          phase = 'closed'
          d.registry.clear()
        },
        compute: async (request, call) => {
          if (request.target.bindingId !== factory.bindingId || request.method !== 'prepare')
            return refuse('denied', 'model_binding_denied')
          if (phase !== 'ready') return refuse('denied', 'provider_closed')
          active.add(call.invocationId)
          try {
            const input = open(request.input, methods.prepare.input, 'ModelPrepareRequest')
            const result = await prepareOnce(d, owner, input, call, false)
            return { ok: true, value: inline(methods.prepare.output, result) }
          } catch (cause) {
            return asOutcome(cause)
          } finally {
            active.delete(call.invocationId)
          }
        },
      }
      service.actions = { prepareRequest: prepareRequestAction(shared), infer: inferAction(shared) }
      return service
    },
  }
}
