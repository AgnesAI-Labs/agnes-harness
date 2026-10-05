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

export interface ReferenceContextSource {
  session: W.SessionRef
  revision: W.Revision
  snapshot: W.Id
  inputDigest: W.Digest
  items: readonly W.ContextItem[]
  protectedRefs: readonly W.PublicRef[]
  hooks: W.EffectiveHookSnapshot
}
export interface ReferenceContextOptions {
  descriptor: W.ProviderDescriptor
  configSchema: AuthorSchema<EmptyAuthorConfig>
  format: string
  textSource: W.GeneratedAuthorSchemaSource
  deployment: {
    capture(
      input: W.ContextViewRequest,
      snapshot: W.Id | undefined,
      call: CallContext,
    ): Outcome<ReferenceContextSource>
    checkCurrent(call: CallContext): boolean
    sourceCurrent(source: ReferenceContextSource, call: CallContext): boolean
  }
}
const schemas = RuntimeMethodSchemaRefs['agh.context'].view
const budget = { maxBytes: 16_384, maxDepth: 32, maxMembers: 4096 }
function failure(detailCode: string, code: W.RuntimeError['code'] = 'invalid_input'): W.RuntimeError {
  return {
    code,
    detailCode,
    message: 'Reference Context refused',
    diagnosticId: 'reference-context',
    retryAdvice: { kind: 'never' },
  }
}
function demand(
  value: unknown,
  detail: string,
  code: W.RuntimeError['code'] = 'invalid_input',
): asserts value {
  if (!value) throw failure(detail, code)
}
function canonical(value: unknown) {
  const parsed = boundedCanonicalJson(value, budget)
  demand(parsed.ok, 'context_payload_limit', 'quota')
  return parsed.value
}
function duplicate<T>(value: T): T {
  return canonical(value).json as T
}
function identical(a: unknown, b: unknown) {
  return canonicalJsonDigest(canonical(a).json) === canonicalJsonDigest(canonical(b).json)
}
function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return
  Object.values(value).forEach(frozen)
  Object.freeze(value)
}
function decode(ref: W.DataRef, schema: W.SchemaRef): W.JsonValue {
  demand(validateRuntime('DataRef', ref).ok && identical(ref.schema, schema), 'context_schema_mismatch')
  demand(ref.kind === 'inline', 'context_blob_unavailable', 'incompatible')
  const value = canonical(ref.value)
  demand(
    value.bytes === ref.bytes && canonicalJsonDigest(value.json) === ref.digest,
    'context_data_integrity',
  )
  return value.json
}
function refused(error: unknown): Outcome<never> {
  const parsed = validateRuntime('RuntimeError', error)
  return { ok: false, error: parsed.ok ? parsed.value : failure('context_source_failed', 'internal') }
}
function fixedCall(call: CallContext): CallContext {
  const { signal, ...wire } = call
  const safe = duplicate(wire)
  demand(validateRuntime('CallContextWire', safe).ok, 'context_call_denied', 'denied')
  const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
  demand(getter && typeof Reflect.apply(getter, signal, []) === 'boolean', 'context_signal_invalid')
  frozen(safe)
  return Object.freeze({ ...safe, signal })
}

/** Independently assembles a read-only view; no Core/default provider or storage import. */
export function createReferenceContextFactory(
  options: ReferenceContextOptions,
): ProviderFactory<ServiceProvider> {
  const descriptor = duplicate(options.descriptor),
    configCodec = options.configSchema
  demand(validateRuntime('ProviderDescriptor', descriptor).ok, 'context_descriptor_invalid')
  const entry = descriptor.operations[0]
  demand(
    descriptor.contract === 'agh.context' &&
      descriptor.major === 1 &&
      descriptor.scope === 'run' &&
      descriptor.recovery === 'R1' &&
      descriptor.features.every((feature) => feature === 'fixed-text-view.v1') &&
      descriptor.requires.length === 0 &&
      descriptor.capabilities.length === 0 &&
      descriptor.stateCodecs.length === 0 &&
      descriptor.isolation.length === 1 &&
      descriptor.isolation[0] === 'trusted-in-process' &&
      descriptor.operations.length === 1 &&
      entry?.method === 'view' &&
      entry.kind === 'query' &&
      entry.retrySafety === 'read-only' &&
      entry.requiredCapabilities.length === 0 &&
      identical(entry.inputSchema, schemas.input) &&
      identical(entry.outputSchema, schemas.output) &&
      identical(descriptor.configSchema, configCodec.ref),
    'context_descriptor_invalid',
  )
  const format = options.format,
    textCodec = validateOwnedAuthorSchemaSource(options.textSource),
    textSchema = duplicate(textCodec.ref),
    owner = options.deployment
  demand(
    typeof format === 'string' && format.length > 0 && validateRuntime('SchemaRef', textSchema).ok,
    'context_format_invalid',
  )
  demand(
    owner &&
      typeof owner.capture === 'function' &&
      typeof owner.checkCurrent === 'function' &&
      typeof owner.sourceCurrent === 'function',
    'context_source_owner_required',
    'incompatible',
  )
  const read = owner.capture.bind(owner),
    allowed = owner.checkCurrent.bind(owner),
    readable = owner.sourceCurrent.bind(owner)
  frozen(descriptor)
  frozen(textSchema)
  return {
    descriptor,
    async create(config, _dependencies, factory) {
      const settings = configCodec.parse(decode(duplicate(config), descriptor.configSchema))
      demand(settings.ok && Object.keys(settings.value).length === 0, 'context_configuration_invalid')
      const scope = duplicate(factory.scope),
        bindingId = factory.bindingId,
        lifetime = factory.signal
      demand(
        validateRuntime('ScopeRef', scope).ok &&
          scope.kind === 'run' &&
          typeof bindingId === 'string' &&
          bindingId.length > 0,
        'context_factory_scope',
      )
      demand(!lifetime.aborted, 'context_cancelled', 'cancelled')
      frozen(scope)
      const binding = {
        contract: 'agh.context',
        logicalName: descriptor.logicalName,
        providerId: descriptor.providerId,
        bindingId,
      }
      let state: 'new' | 'active' | 'drained' | 'closed' = 'new'
      const verify = (call: CallContext, query = true) => {
        const { signal, ...wire } = call
        demand(
          validateRuntime('CallContextWire', wire).ok &&
            identical(scope, call.scope) &&
            call.bindingId === bindingId,
          'context_call_denied',
          'denied',
        )
        const live = () => {
          demand(!signal.aborted && !lifetime.aborted, 'context_cancelled', 'cancelled')
          demand(Date.parse(call.deadline) > Date.now(), 'context_deadline', 'timeout')
          demand(state !== 'closed' && (!query || state === 'active'), 'context_provider_closed', 'denied')
        }
        live()
        demand(allowed(call) === true, 'context_current_denied', 'denied')
        live()
      }
      const provider: ServiceProvider = {
        async ready(call) {
          try {
            call = fixedCall(call)
            demand(state === 'new' || state === 'active', 'context_provider_closed', 'denied')
            verify(call, false)
            state = 'active'
            return { ok: true, value: undefined }
          } catch (error) {
            return refused(error)
          }
        },
        async health(call) {
          try {
            call = fixedCall(call)
            verify(call, false)
            return {
              ok: true,
              value: { status: state === 'active' ? 'ready' : 'degraded', diagnosticIds: [] },
            }
          } catch (error) {
            return refused(error)
          }
        },
        async drain(deadline, call) {
          try {
            call = fixedCall(call)
            demand(validateRuntime('Timestamp', deadline).ok, 'context_drain_deadline')
            verify(call, false)
            state = 'drained'
            return {
              ok: true,
              value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
            }
          } catch (error) {
            return refused(error)
          }
        },
        async close() {
          state = 'closed'
        },
        async query(supplied, call) {
          try {
            call = fixedCall(call)
            const query = duplicate(supplied)
            frozen(query)
            verify(call)
            demand(
              validateRuntime('ServiceQuery', query).ok &&
                identical(query.target, binding) &&
                query.method === 'view',
              'context_operation_denied',
              'denied',
            )
            demand(query.page === undefined, 'context_pagination_unavailable', 'incompatible')
            const parsed = validateRuntime('ContextViewRequest', decode(query.input, schemas.input))
            demand(parsed.ok && query.input.kind === 'inline', 'context_input_schema')
            const input = parsed.value,
              contribution = input.contributions
            const { digest: contributionDigest, ...contributionContent } = contribution
            demand(
              canonicalJsonDigest(contributionContent) === contributionDigest,
              'context_contributions_integrity',
            )
            demand(input.sessionRef.sessionId === scope.sessionId, 'context_session_denied', 'denied')
            demand(input.target.format === format, 'context_format_unavailable', 'incompatible')
            demand(input.resourceRefs.length === 0, 'context_resources_unavailable', 'incompatible')
            demand(
              contribution.sections.length === 0 &&
                contribution.runtimeContext.length === 0 &&
                contribution.candidateTools.length === 0 &&
                contribution.conflictDiagnostics.length === 0,
              'context_contributions_unavailable',
              'incompatible',
            )
            demand(input.hookResults === null, 'context_hook_results_unavailable', 'incompatible')
            const reply = read(duplicate(input), query.snapshot, call)
            if (!reply.ok) throw reply.error
            const original = duplicate(reply.value)
            verify(call)
            demand(
              validateRuntime('SessionRef', original.session).ok &&
                identical(input.sessionRef, original.session) &&
                original.revision === input.atRevision &&
                original.inputDigest === query.input.digest &&
                validateRuntime('Id', original.snapshot).ok &&
                (query.snapshot === undefined || query.snapshot === original.snapshot),
              'context_stale_snapshot',
              'conflict',
            )
            demand(
              validateRuntime('EffectiveHookSnapshot', original.hooks).ok &&
                original.hooks.event === 'context' &&
                original.hooks.workspaceId === scope.workspaceId,
              'context_hooks_source_missing',
              'denied',
            )
            const { digest, ...hookBody } = original.hooks
            demand(canonicalJsonDigest(hookBody) === digest, 'context_hooks_integrity')
            demand(
              original.hooks.registrations.length === 0,
              'context_hook_preparation_unavailable',
              'incompatible',
            )
            demand(readable(duplicate(original), call) === true, 'context_source_denied', 'denied')
            demand(
              Array.isArray(original.items) &&
                original.items.length <= 64 &&
                original.protectedRefs.every((ref) => validateRuntime('PublicRef', ref).ok),
              'context_source_invalid',
            )
            const items = original.items.map((item: W.ContextItem) => {
              demand(validateRuntime('ContextItem', item).ok, 'context_item_invalid')
              demand(
                ['message', 'tool-call', 'tool-result'].includes(item.kind) &&
                  item.sourceRefs.length > 0 &&
                  item.provenance.sourceRefs.length > 0,
                'context_item_source_unavailable',
                'incompatible',
              )
              demand(
                item.sourceRefs.every(
                  (ref) => ref.kind === 'session' && identical(ref.value, original.session),
                ),
                'context_item_source_unavailable',
                'incompatible',
              )
              demand(
                item.sourceRanges.every(
                  (range) => identical(range.session, original.session) && range.fromSeq <= range.toSeq,
                ),
                'context_source_range_invalid',
              )
              const text = decode(item.body, textSchema)
              demand(typeof text === 'string' && textCodec.validate(text).ok, 'context_text_required')
              return { ...item, tokenEstimate: Math.max(item.tokenEstimate, canonical(text).bytes) }
            })
            demand(new Set(items.map((item) => item.id)).size === items.length, 'context_item_invalid')
            for (const item of items) {
              if (item.kind === 'message') demand(item.toolPairRef === null, 'context_tool_pair_invalid')
              else {
                demand(item.toolPairRef !== null, 'context_tool_pair_missing')
                const partners = items.filter((other) => other.toolPairRef === item.toolPairRef)
                demand(
                  partners.length === 2 &&
                    partners.filter((other) => other.kind === 'tool-call').length === 1 &&
                    partners.filter((other) => other.kind === 'tool-result').length === 1,
                  'context_tool_pair_incomplete',
                  'incompatible',
                )
              }
              if (item.protected)
                demand(
                  item.sourceRefs.every((ref) =>
                    original.protectedRefs.some((candidate) => identical(ref, candidate)),
                  ),
                  'context_protection_missing',
                )
            }
            const tokens = items.reduce((count, item) => count + item.tokenEstimate, 0)
            demand(
              Number.isSafeInteger(tokens) && tokens <= input.target.tokenLimit,
              'context_token_limit',
              'quota',
            )
            const view = {
              viewId: `reference-context:${canonicalJsonDigest({ binding, snapshot: original.snapshot, inputDigest: original.inputDigest })}`,
              format,
              schema: textSchema,
              baseRevision: original.revision,
              items,
              tokenEstimate: tokens,
              protectedRefs: original.protectedRefs,
              runtimeInstructionRefs: [],
              inputDigest: original.inputDigest,
            }
            const output = { ...view, digest: canonicalJsonDigest(canonical(view).json) }
            demand(validateRuntime('ContextView', output).ok, 'context_output_schema')
            const encoded = canonical(output)
            demand(readable(duplicate(original), call) === true, 'context_source_denied', 'denied')
            verify(call)
            return {
              ok: true,
              value: {
                kind: 'value',
                snapshot: original.snapshot,
                output: {
                  kind: 'inline',
                  schema: schemas.output,
                  value: encoded.json,
                  digest: canonicalJsonDigest(encoded.json),
                  bytes: encoded.bytes,
                },
              },
            }
          } catch (error) {
            let reason = error
            try {
              verify(call)
            } catch (currentError) {
              reason = currentError
            }
            return refused(reason)
          }
        },
        async maintenance() {
          return refused(failure('context_authority_transfer_unavailable', 'incompatible'))
        },
      }
      return provider
    },
  }
}
