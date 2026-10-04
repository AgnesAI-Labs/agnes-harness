import type {
  ActionContext,
  ActionHandlerScope,
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  FactoryContext,
  Outcome,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import {
  type ActionFrame,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type EffectResult,
  type ProviderDescriptor,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { type PureHookStage, PureHookStageFailure, runPureHookStage } from '../hooks/stages.js'
import { assertAuthorSchema } from './accounting.js'

const refs = RuntimeMethodSchemaRefs['agh.effects']
const methods = RuntimeServiceCatalog['agh.effects'].methods
function safe(value: unknown) {
  const limits = RuntimeAuthorCodecPolicy.payload
  const result = boundedCanonicalJson(value, {
    maxBytes: limits.maxCanonicalJsonBytes,
    maxDepth: limits.maxDepth,
    maxMembers: limits.maxMembers,
  })
  if (!result.ok) throw new TypeError('Invalid Effects payload')
  return result.value
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
}
const same = (a: unknown, b: unknown) =>
  canonicalJsonDigest(safe(a).json) === canonicalJsonDigest(safe(b).json)
function refusal(code: 'incompatible' | 'cancelled', detailCode: string): Outcome<never> {
  return { ok: false, error: new PureHookStageFailure(code, detailCode).error }
}
function noExecution(context: CallContext): EffectResult {
  const refused = refusal(
    context.signal.aborted ? 'cancelled' : 'incompatible',
    context.signal.aborted ? 'effects_cancelled' : 'effects_stage_source_unavailable',
  )
  if (refused.ok) throw new TypeError('Unreachable Effects refusal')
  return {
    outcome: context.signal.aborted ? 'cancelled' : 'failed',
    error: refused.error,
    externalRequests: [],
    usage: [],
    references: [],
  }
}
/** Supplied only by the selected Host installation; Core checks its captured stage, not its authority. */
export type EffectsStageSource = Readonly<{
  capture(frame: ActionFrame, scope: ActionHandlerScope, context: ActionContext): Promise<PureHookStage>
}>
function capturedSource(source: EffectsStageSource | undefined) {
  if (!source) return null
  const slot = Object.getOwnPropertyDescriptor(source, 'capture')
  if (!Object.isFrozen(source) || !slot || !Object.hasOwn(slot, 'value') || typeof slot.value !== 'function')
    throw new TypeError('Effects stage source must have an own capture function')
  const capture = slot.value as EffectsStageSource['capture']
  return () => {
    const current = Object.getOwnPropertyDescriptor(source, 'capture')
    if (!current || current.value !== capture || current.get || current.set)
      throw new PureHookStageFailure('denied', 'effects_stage_source_changed')
    return (frame: ActionFrame, scope: ActionHandlerScope, context: ActionContext) =>
      capture.call(source, frame, scope, context)
  }
}
function stageResult(result: Awaited<ReturnType<typeof runPureHookStage>>): EffectResult {
  const body = safe(result.result)
  if (body.bytes > RuntimeAuthorCodecPolicy.maxInlineBytes)
    throw new PureHookStageFailure('invalid_input', 'effects_stage_result_too_large')
  const value: DataRef = {
    kind: 'inline',
    schema: refs.runHooks.output,
    value: body.json,
    digest: canonicalJsonDigest(body.json),
    bytes: body.bytes,
  }
  if (!validateRuntime('DataRef', value).ok)
    throw new PureHookStageFailure('invalid_input', 'effects_stage_result_invalid')
  return {
    outcome: result.outcome === 'completed' ? 'succeeded' : 'failed',
    result: value,
    ...(result.outcome === 'denied'
      ? { error: new PureHookStageFailure('denied', 'effects_stage_denied').error }
      : {}),
    externalRequests: [],
    usage: [],
    references: [],
  }
}
/** Official ABI scaffold. Genuine installed stage capture is required before any execution is enabled. */
export function createDefaultEffectsFactory(
  descriptor: ProviderDescriptor,
  configCodec: AuthorSchema<EmptyAuthorConfig>,
  source?: EffectsStageSource,
): ProviderFactory<ServiceProvider> {
  assertAuthorSchema(configCodec)
  const sourceSlot = capturedSource(source)
  const checked = validateRuntime('ProviderDescriptor', safe(descriptor).json)
  if (
    !checked.ok ||
    checked.value.contract !== 'agh.effects' ||
    checked.value.major !== 1 ||
    !same(checked.value.configSchema, configCodec.ref)
  )
    throw new TypeError('Invalid official Effects descriptor')
  const fixed = checked.value
  if (fixed.operations.length !== Object.keys(methods).length)
    throw new TypeError('Effects requires the complete official method table')
  for (const [method, definition] of Object.entries(methods)) {
    const operation = fixed.operations.find((entry) => entry.method === method)
    const schema = refs[method as keyof typeof refs]
    if (
      !operation ||
      !schema ||
      operation.kind !== definition.kind ||
      !same(operation.inputSchema, schema.input) ||
      !same(operation.outputSchema, schema.output)
    )
      throw new TypeError('Effects operation differs from its official ABI')
  }
  freeze(fixed)
  return Object.freeze({
    descriptor: fixed,
    async create(config: DataRef, _dependencies: ScopedDependencies, factory: FactoryContext) {
      const parsed = validateRuntime('ScopeRef', safe(factory.scope).json)
      if (
        !parsed.ok ||
        !validateRuntime('Id', factory.instanceId).ok ||
        !validateRuntime('Id', factory.bindingId).ok ||
        factory.scope.kind !== fixed.scope ||
        factory.signal.aborted
      )
        throw new TypeError('Invalid Effects factory scope')
      const input = validateRuntime('DataRef', safe(config).json)
      if (!input.ok || input.value.kind !== 'inline' || !same(input.value.schema, fixed.configSchema))
        throw new TypeError('Effects requires the official inline empty configuration')
      const body = safe(input.value.value)
      if (
        !validateRuntime('RuntimeEmptyAuthorConfig', body.json).ok ||
        !configCodec.parse(body.json).ok ||
        body.bytes !== input.value.bytes ||
        canonicalJsonDigest(body.json) !== input.value.digest
      )
        throw new TypeError('Invalid Effects configuration proof')
      let closed = false
      const unsupported = (context: CallContext): Outcome<never> =>
        refusal(
          context.signal.aborted || factory.signal.aborted ? 'cancelled' : 'incompatible',
          closed ? 'effects_closed' : 'effects_stage_source_unavailable',
        )
      const lifecycle = () => ({
        ready: async (context: CallContext) => unsupported(context),
        health: async (_context: CallContext) => ({
          ok: true as const,
          value: {
            status: closed ? ('failed' as const) : ('degraded' as const),
            diagnosticIds: ['effects-stage-source-unavailable'],
          },
        }),
        drain: async (_deadline: string, _context: CallContext) => {
          closed = true
          return {
            ok: true as const,
            value: {
              state: 'drained' as const,
              activeInvocationIds: [],
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        close: async () => {
          closed = true
        },
      })
      const provider: ServiceProvider = {
        ...lifecycle(),
        actions: Object.freeze({
          runHooks: Object.freeze({
            kind: 'leaf' as const,
            recovery: 'R0' as const,
            stateCodec: null,
            async create(actionScope: ActionHandlerScope) {
              return {
                ...lifecycle(),
                kind: 'leaf' as const,
                effectSemantics: 'idempotent' as const,
                execute: async (frame: ActionFrame, context: ActionContext): Promise<EffectResult> => {
                  if (!sourceSlot || closed) return noExecution(context.call)
                  try {
                    const parsed = validateRuntime('ActionFrame', safe(frame).json)
                    const { signal: _signal, ...wireCall } = context.call
                    if (
                      !parsed.ok ||
                      frame.actionId !== actionScope.actionId ||
                      frame.runId !== actionScope.runId ||
                      frame.bindingId !== factory.bindingId ||
                      frame.bindingId !== actionScope.bindingId ||
                      frame.method !== 'runHooks' ||
                      frame.inputDigest !== canonicalJsonDigest(frame.input) ||
                      !same(actionScope.scope, factory.scope) ||
                      !same(context.call.scope, factory.scope) ||
                      !same(frame.context, wireCall) ||
                      context.call.bindingId !== factory.bindingId
                    )
                      throw new PureHookStageFailure('denied', 'effects_stage_frame_mismatch')
                    if (context.call.signal.aborted || factory.signal.aborted || actionScope.signal.aborted)
                      throw new PureHookStageFailure('cancelled', 'effects_cancelled')
                    const input = validateRuntime('DataRef', frame.input)
                    if (
                      !input.ok ||
                      input.value.kind !== 'inline' ||
                      !same(input.value.schema, refs.runHooks.input)
                    )
                      throw new PureHookStageFailure('invalid_input', 'effects_stage_input_invalid')
                    const body = safe(input.value.value)
                    if (
                      body.bytes !== input.value.bytes ||
                      canonicalJsonDigest(body.json) !== input.value.digest
                    )
                      throw new PureHookStageFailure('invalid_input', 'effects_stage_input_proof')
                    const captured = await sourceSlot()(frame, actionScope, context)
                    if (
                      captured.sourceActionId !== frame.actionId ||
                      !same(captured.request, input.value.value) ||
                      captured.request.owner.runId !== frame.runId ||
                      captured.request.inputDigest !== canonicalJsonDigest(captured.request.input)
                    )
                      throw new PureHookStageFailure('denied', 'effects_stage_capture_mismatch')
                    return stageResult(await runPureHookStage({ ...captured, signal: context.call.signal }))
                  } catch (error) {
                    const failure =
                      error instanceof PureHookStageFailure
                        ? error
                        : new PureHookStageFailure('invalid_input', 'effects_stage_capture_invalid')
                    return {
                      outcome: failure.error.code === 'cancelled' ? 'cancelled' : 'failed',
                      error: failure.error,
                      externalRequests: [],
                      usage: [],
                      references: [],
                    }
                  }
                },
                reconcile: async () => {
                  throw new PureHookStageFailure('incompatible', 'effects_reconciliation_unavailable')
                },
              }
            },
          }),
        }),
        control: async (_request, context) => unsupported(context),
      }
      return Object.freeze(provider)
    },
  })
}
