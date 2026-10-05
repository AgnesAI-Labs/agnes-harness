import type {
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  Outcome,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  validateOwnedAuthorSchemaSource,
  validateRuntime,
} from '@agnes/protocol/runtime'

/** Native deployment input, not a caller permission or a production State owner. */
export interface ContextSourceSnapshot {
  session: W.SessionRef
  revision: W.Revision
  snapshot: W.Id
  inputDigest: W.Digest
  items: readonly W.ContextItem[]
  protectedRefs: readonly W.PublicRef[]
  hooks: W.EffectiveHookSnapshot
}
export interface ContextDeployment {
  /** These synchronous ports only read an already fixed, authorized snapshot. */
  capture(
    request: W.ContextViewRequest,
    snapshot: W.Id | undefined,
    call: CallContext,
  ): Outcome<ContextSourceSnapshot>
  checkCurrent(call: CallContext): boolean
  sourceCurrent(source: ContextSourceSnapshot, call: CallContext): boolean
}
export interface ContextFactoryOptions {
  descriptor: W.ProviderDescriptor
  configSchema: AuthorSchema<EmptyAuthorConfig>
  format: string
  textSource: W.GeneratedAuthorSchemaSource
  deployment: ContextDeployment
}
const refs = RuntimeMethodSchemaRefs['agh.context'].view
const limits = { maxBytes: 16_384, maxDepth: 32, maxMembers: 4096 }
function fault(detailCode: string, code: W.RuntimeError['code'] = 'invalid_input'): W.RuntimeError {
  return {
    code,
    detailCode,
    message: 'Context view refused',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'context-view',
  }
}
function require(
  condition: unknown,
  detail: string,
  code: W.RuntimeError['code'] = 'invalid_input',
): asserts condition {
  if (!condition) throw fault(detail, code)
}
function copy<T>(value: T): T {
  const safe = boundedCanonicalJson(value, limits)
  require(safe.ok, 'context_payload_limit', 'quota')
  return safe.value.json as T
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJsonDigest(a as W.JsonValue) === canonicalJsonDigest(b as W.JsonValue)
}
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  for (const child of Object.values(value)) freeze(child)
  Object.freeze(value)
}
function body(ref: W.DataRef, schema: W.SchemaRef): W.JsonValue {
  require(validateRuntime('DataRef', ref).ok && same(ref.schema, schema), 'context_schema_mismatch')
  require(ref.kind === 'inline', 'context_blob_unavailable', 'incompatible')
  const safe = boundedCanonicalJson(ref.value, limits)
  require(safe.ok &&
    safe.value.bytes === ref.bytes &&
    canonicalJsonDigest(safe.value.json) === ref.digest, 'context_data_integrity')
  return safe.value.json
}
function inline(schema: W.SchemaRef, value: unknown): W.DataRef {
  const safe = boundedCanonicalJson(value, limits)
  require(safe.ok, 'context_output_limit', 'quota')
  return {
    kind: 'inline',
    schema,
    value: safe.value.json,
    digest: canonicalJsonDigest(safe.value.json),
    bytes: safe.value.bytes,
  }
}
function lockedCall(call: CallContext): CallContext {
  const { signal, ...wire } = call
  const safe = copy(wire)
  require(validateRuntime('CallContextWire', safe).ok, 'context_call_denied', 'denied')
  const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
  require(getter && typeof getter.call(signal) === 'boolean', 'context_signal_invalid')
  freeze(safe)
  return Object.freeze({ ...safe, signal })
}

/** Fixed inline text only. Hook preparation, refresh and authority transfer remain unavailable. */
export function createContextFactory(options: ContextFactoryOptions): ProviderFactory<ServiceProvider> {
  const descriptor = copy(options.descriptor)
  const parsed = validateRuntime('ProviderDescriptor', descriptor)
  require(parsed.ok, 'context_descriptor_invalid')
  const operation = descriptor.operations[0]
  require(parsed.ok &&
    descriptor.contract === 'agh.context' &&
    descriptor.major === 1 &&
    descriptor.scope === 'run' &&
    descriptor.recovery === 'R1' &&
    descriptor.stateCodecs.length === 0 &&
    descriptor.requires.length === 0 &&
    descriptor.capabilities.length === 0 &&
    descriptor.features.every((f) => f === 'fixed-text-view.v1') &&
    descriptor.isolation.length === 1 &&
    descriptor.isolation[0] === 'trusted-in-process' &&
    descriptor.operations.length === 1 &&
    operation?.method === 'view' &&
    operation.kind === 'query' &&
    operation.retrySafety === 'read-only' &&
    operation.requiredCapabilities.length === 0 &&
    same(operation.inputSchema, refs.input) &&
    same(operation.outputSchema, refs.output) &&
    same(descriptor.configSchema, options.configSchema.ref), 'context_descriptor_invalid')
  const format = options.format,
    text = validateOwnedAuthorSchemaSource(options.textSource),
    textSchema = copy(text.ref),
    codec = options.configSchema
  require(typeof format === 'string' && format.length > 0, 'context_format_invalid')
  const owner = options.deployment
  require(owner &&
    typeof owner.capture === 'function' &&
    typeof owner.checkCurrent === 'function' &&
    typeof owner.sourceCurrent === 'function', 'context_source_owner_required', 'incompatible')
  const capture = owner.capture.bind(owner),
    current = owner.checkCurrent.bind(owner),
    sourceCurrent = owner.sourceCurrent.bind(owner)
  freeze(descriptor)
  freeze(textSchema)
  return {
    descriptor,
    async create(config, _dependencies, factory) {
      const decoded = codec.parse(body(copy(config), descriptor.configSchema))
      require(decoded.ok && Object.keys(decoded.value).length === 0, 'context_configuration_invalid')
      const scope = copy(factory.scope),
        bindingId = factory.bindingId,
        factorySignal = factory.signal
      require(validateRuntime('ScopeRef', scope).ok &&
        scope.kind === 'run' &&
        typeof bindingId === 'string' &&
        bindingId.length > 0, 'context_factory_scope')
      require(!factorySignal.aborted, 'context_cancelled', 'cancelled')
      freeze(scope)
      const binding: W.BindingRef = {
        bindingId,
        contract: 'agh.context',
        providerId: descriptor.providerId,
        logicalName: descriptor.logicalName,
      }
      let phase: 'created' | 'ready' | 'draining' | 'closed' = 'created'
      const closed = () => phase === 'closed'
      function gate(call: CallContext, accepting = true): void {
        const { signal, ...wire } = call
        require(validateRuntime('CallContextWire', wire).ok &&
          same(call.scope, scope) &&
          call.bindingId === bindingId, 'context_call_denied', 'denied')
        require(!signal.aborted && !factorySignal.aborted, 'context_cancelled', 'cancelled')
        require(Date.parse(call.deadline) > Date.now(), 'context_deadline', 'timeout')
        require(!closed() && (!accepting || phase === 'ready'), 'context_provider_closed', 'denied')
        require(current(call) === true, 'context_current_denied', 'denied')
        require(!signal.aborted && !factorySignal.aborted, 'context_cancelled', 'cancelled')
        require(Date.parse(call.deadline) > Date.now(), 'context_deadline', 'timeout')
        require(!closed() && (!accepting || phase === 'ready'), 'context_provider_closed', 'denied')
      }
      function refusal(error: unknown): Outcome<never> {
        const safe = validateRuntime('RuntimeError', error)
        return { ok: false, error: safe.ok ? safe.value : fault('context_source_failed', 'internal') }
      }
      return {
        async ready(call) {
          try {
            call = lockedCall(call)
            require(phase === 'created' || phase === 'ready', 'context_provider_closed', 'denied')
            gate(call, false)
            phase = 'ready'
            return { ok: true, value: undefined }
          } catch (error) {
            return refusal(error)
          }
        },
        async health(call) {
          try {
            call = lockedCall(call)
            gate(call, false)
            return {
              ok: true,
              value: { status: phase === 'ready' ? 'ready' : 'degraded', diagnosticIds: [] },
            }
          } catch (error) {
            return refusal(error)
          }
        },
        async drain(deadline, call) {
          try {
            call = lockedCall(call)
            require(validateRuntime('Timestamp', deadline).ok, 'context_drain_deadline')
            gate(call, false)
            phase = 'draining'
            return {
              ok: true,
              value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
            }
          } catch (error) {
            return refusal(error)
          }
        },
        async close() {
          phase = 'closed'
        },
        async query(supplied, call) {
          try {
            call = lockedCall(call)
            const query = copy(supplied)
            freeze(query)
            gate(call)
            require(validateRuntime('ServiceQuery', query).ok &&
              same(query.target, binding) &&
              query.method === 'view', 'context_operation_denied', 'denied')
            require(query.page === undefined, 'context_pagination_unavailable', 'incompatible')
            const input = validateRuntime('ContextViewRequest', body(query.input, refs.input))
            require(input.ok && query.input.kind === 'inline', 'context_input_schema')
            const request = input.value
            require(request.sessionRef.sessionId === scope.sessionId, 'context_session_denied', 'denied')
            require(request.target.format === format, 'context_format_unavailable', 'incompatible')
            require(request.resourceRefs.length === 0, 'context_resources_unavailable', 'incompatible')
            const contributions = request.contributions
            const { digest: contributionDigest, ...contributionContent } = contributions
            require(canonicalJsonDigest(contributionContent) ===
              contributionDigest, 'context_contributions_integrity')
            require(contributions.sections.length === 0 &&
              contributions.runtimeContext.length === 0 &&
              contributions.candidateTools.length === 0 &&
              contributions.conflictDiagnostics.length ===
                0, 'context_contributions_unavailable', 'incompatible')
            require(request.hookResults === null, 'context_hook_results_unavailable', 'incompatible')
            const received = capture(copy(request), query.snapshot, call)
            if (!received.ok) throw received.error
            const capturedSource = copy(received.value)
            gate(call)
            const source = copy(capturedSource)
            require(validateRuntime('SessionRef', source.session).ok &&
              same(source.session, request.sessionRef) &&
              source.revision === request.atRevision &&
              source.inputDigest === query.input.digest &&
              validateRuntime('Id', source.snapshot).ok &&
              (query.snapshot === undefined ||
                query.snapshot === source.snapshot), 'context_stale_snapshot', 'conflict')
            require(validateRuntime('EffectiveHookSnapshot', source.hooks).ok &&
              source.hooks.workspaceId === scope.workspaceId &&
              source.hooks.event === 'context', 'context_hooks_source_missing', 'denied')
            const { digest: hookDigest, ...hookContent } = source.hooks
            require(canonicalJsonDigest(hookContent) === hookDigest, 'context_hooks_integrity')
            require(source.hooks.registrations.length ===
              0, 'context_hook_preparation_unavailable', 'incompatible')
            require(sourceCurrent(copy(capturedSource), call) === true, 'context_source_denied', 'denied')
            require(Array.isArray(source.items) &&
              source.items.length <= 64 &&
              source.protectedRefs.every(
                (ref) => validateRuntime('PublicRef', ref).ok,
              ), 'context_source_invalid')
            const ids = new Set<string>(),
              pairs = new Map<string, Set<string>>()
            let estimate = 0
            for (const suppliedItem of source.items) {
              const item: W.ContextItem = suppliedItem
              require(validateRuntime('ContextItem', item).ok && !ids.has(item.id), 'context_item_invalid')
              ids.add(item.id)
              require(['message', 'tool-call', 'tool-result'].includes(item.kind) &&
                item.sourceRefs.length > 0 &&
                item.provenance.sourceRefs.length > 0, 'context_item_source_unavailable', 'incompatible')
              require(item.sourceRefs.every(
                (ref) => ref.kind === 'session' && same(ref.value, source.session),
              ), 'context_item_source_unavailable', 'incompatible')
              require(item.sourceRanges.every(
                (range) => same(range.session, source.session) && range.fromSeq <= range.toSeq,
              ), 'context_source_range_invalid')
              const value = body(item.body, textSchema)
              require(typeof value === 'string' && text.validate(value).ok, 'context_text_required')
              const textBytes = boundedCanonicalJson(value, limits)
              require(textBytes.ok, 'context_text_limit', 'quota')
              item.tokenEstimate = Math.max(item.tokenEstimate, textBytes.value.bytes)
              estimate += item.tokenEstimate
              require(Number.isSafeInteger(estimate) &&
                estimate <= request.target.tokenLimit, 'context_token_limit', 'quota')
              if (item.kind === 'tool-call' || item.kind === 'tool-result') {
                require(item.toolPairRef !== null, 'context_tool_pair_missing')
                const pair = pairs.get(item.toolPairRef) ?? new Set<string>()
                require(!pair.has(item.kind), 'context_tool_pair_duplicate')
                pair.add(item.kind)
                pairs.set(item.toolPairRef, pair)
              } else require(item.toolPairRef === null, 'context_tool_pair_invalid')
              if (item.protected)
                require(item.sourceRefs.every((ref) =>
                  source.protectedRefs.some((p) => same(p, ref)),
                ), 'context_protection_missing')
            }
            require([...pairs.values()].every(
              (pair) => pair.size === 2,
            ), 'context_tool_pair_incomplete', 'incompatible')
            const content = {
              viewId: `context:${canonicalJsonDigest({ binding, snapshot: source.snapshot, inputDigest: source.inputDigest })}`,
              format,
              schema: textSchema,
              baseRevision: source.revision,
              items: source.items,
              tokenEstimate: estimate,
              protectedRefs: source.protectedRefs,
              runtimeInstructionRefs: [],
              inputDigest: source.inputDigest,
            }
            const view = { ...content, digest: canonicalJsonDigest(content as unknown as W.JsonValue) }
            require(validateRuntime('ContextView', view).ok, 'context_output_schema')
            const output = inline(refs.output, view)
            require(sourceCurrent(copy(capturedSource), call) === true, 'context_source_denied', 'denied')
            gate(call)
            return { ok: true, value: { kind: 'value', output, snapshot: source.snapshot } }
          } catch (error) {
            let reason = error
            try {
              gate(call)
            } catch (currentError) {
              reason = currentError
            }
            return refusal(reason)
          }
        },
        async maintenance() {
          return { ok: false, error: fault('context_authority_transfer_unavailable', 'incompatible') }
        },
      }
    },
  }
}
