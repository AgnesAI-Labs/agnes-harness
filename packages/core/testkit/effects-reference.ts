import type {
  ActionContext,
  ActionHandlerScope,
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  FactoryContext,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  type ActionFrame,
  canonicalJsonDigest,
  type DataRef,
  type EffectResult,
  type JsonValue,
  type ProviderDescriptor,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { type PureHookStage, PureHookStageFailure, runPureHookStage } from '../src/runtime/hooks/stages.js'
import { createDefaultEffectsFactory } from '../src/runtime/providers/effects.js'

const method = RuntimeMethodSchemaRefs['agh.effects'].runHooks

function failed(code: 'incompatible' | 'cancelled' | 'invalid_input', detail: string): EffectResult {
  return {
    outcome: code === 'cancelled' ? 'cancelled' : 'failed',
    error: new PureHookStageFailure(code, detail).error,
    externalRequests: [],
    usage: [],
    references: [],
  }
}

function matches(
  frame: ActionFrame,
  stage: PureHookStage,
  scope: { actionId: string; runId: string; bindingId: string },
): boolean {
  if (!validateRuntime('ActionFrame', frame).ok || frame.input.kind !== 'inline') return false
  const request = validateRuntime('HookStageRequest', frame.input.value)
  return (
    request.ok &&
    frame.method === 'runHooks' &&
    frame.actionId === scope.actionId &&
    frame.actionId === stage.sourceActionId &&
    frame.runId === scope.runId &&
    frame.runId === stage.request.owner.runId &&
    frame.bindingId === scope.bindingId &&
    frame.input.schema.typeId === method.input.typeId &&
    frame.input.schema.revision === method.input.revision &&
    frame.input.schema.digest === method.input.digest &&
    frame.input.digest === canonicalJsonDigest(request.value) &&
    frame.input.bytes === Buffer.byteLength(jcs(request.value)) &&
    frame.inputDigest === canonicalJsonDigest(frame.input) &&
    canonicalJsonDigest(request.value) === canonicalJsonDigest(stage.request) &&
    stage.request.inputDigest === canonicalJsonDigest(stage.request.input) &&
    stage.request.registrationDigest === stage.effective.digest
  )
}

/** Reference value runner. It does not certify package selection or persist a State receipt. */
export function createReferenceEffectsFactory(
  descriptor: ProviderDescriptor,
  configCodec: AuthorSchema<EmptyAuthorConfig>,
  stage: PureHookStage,
): ProviderFactory<ServiceProvider> {
  const base = createDefaultEffectsFactory(descriptor, configCodec)
  return Object.freeze({
    descriptor: base.descriptor,
    async create(config: DataRef, dependencies: ScopedDependencies, factory: FactoryContext) {
      const provider = await base.create(config, dependencies, factory)
      const actionFactory = provider.actions?.runHooks
      if (!actionFactory) throw new TypeError('Official Effects action missing')
      let closed = false
      return Object.freeze({
        ...provider,
        ready: async (context: CallContext) =>
          closed || context.signal.aborted || factory.signal.aborted
            ? { ok: false as const, error: new PureHookStageFailure('cancelled', 'effects_cancelled').error }
            : { ok: true as const, value: undefined },
        health: async () => ({
          ok: true as const,
          value: {
            status: closed ? ('failed' as const) : ('ready' as const),
            diagnosticIds: [],
          },
        }),
        close: async (reason: Parameters<typeof provider.close>[0]) => {
          closed = true
          await provider.close(reason)
        },
        drain: async (deadline: string, context: CallContext) => {
          closed = true
          return provider.drain(deadline, context)
        },
        actions: Object.freeze({
          ...provider.actions,
          runHooks: Object.freeze({
            ...actionFactory,
            async create(scope: ActionHandlerScope) {
              const action = await actionFactory.create(scope)
              let actionClosed = false
              let fingerprint: string | undefined
              let pending: Promise<EffectResult> | undefined
              return Object.freeze({
                ...action,
                effectSemantics: 'non-idempotent' as const,
                ready: async (context: CallContext) =>
                  closed ||
                  actionClosed ||
                  context.signal.aborted ||
                  scope.signal.aborted ||
                  factory.signal.aborted
                    ? {
                        ok: false as const,
                        error: new PureHookStageFailure('cancelled', 'effects_cancelled').error,
                      }
                    : { ok: true as const, value: undefined },
                close: async (reason: Parameters<typeof action.close>[0]) => {
                  actionClosed = true
                  await action.close(reason)
                },
                drain: async (deadline: string, context: CallContext) => {
                  actionClosed = true
                  return action.drain(deadline, context)
                },
                async execute(frame: ActionFrame, context: ActionContext): Promise<EffectResult> {
                  if (
                    closed ||
                    actionClosed ||
                    context.call.signal.aborted ||
                    scope.signal.aborted ||
                    factory.signal.aborted
                  )
                    return failed('cancelled', 'effects_cancelled')
                  let digest: string
                  try {
                    if (
                      !matches(frame, stage, scope) ||
                      frame.bindingId !== factory.bindingId ||
                      context.call.bindingId !== factory.bindingId ||
                      context.call.invocationId !== frame.invocationId ||
                      canonicalJsonDigest(scope.scope) !== canonicalJsonDigest(factory.scope) ||
                      canonicalJsonDigest(frame.context.scope) !== canonicalJsonDigest(factory.scope) ||
                      frame.context.bindingId !== context.call.bindingId ||
                      frame.context.invocationId !== context.call.invocationId ||
                      canonicalJsonDigest(context.call.scope) !== canonicalJsonDigest(factory.scope)
                    )
                      return failed('invalid_input', 'effects_reference_frame')
                    digest = canonicalJsonDigest(frame as unknown as JsonValue)
                  } catch {
                    return failed('invalid_input', 'effects_reference_frame')
                  }
                  if (fingerprint !== undefined)
                    return fingerprint === digest && pending
                      ? pending
                      : failed('incompatible', 'effects_reference_frame_changed')
                  fingerprint = digest
                  pending = (async () => {
                    try {
                      const evaluated = await runPureHookStage({ ...stage, signal: context.call.signal })
                      if (!validateRuntime('HookResultSet', evaluated.result).ok)
                        return failed('invalid_input', 'effects_reference_result')
                      const result: DataRef = {
                        kind: 'inline',
                        schema: method.output,
                        value: evaluated.result,
                        digest: canonicalJsonDigest(evaluated.result),
                        bytes: Buffer.byteLength(jcs(evaluated.result)),
                      }
                      const output: EffectResult = {
                        outcome: 'succeeded',
                        result,
                        externalRequests: [],
                        usage: [],
                        references: [],
                      }
                      return validateRuntime('EffectResult', output).ok
                        ? output
                        : failed('invalid_input', 'effects_reference_result')
                    } catch (error) {
                      return error instanceof PureHookStageFailure
                        ? {
                            outcome: error.error.code === 'cancelled' ? 'cancelled' : 'failed',
                            error: error.error,
                            externalRequests: [],
                            usage: [],
                            references: [],
                          }
                        : failed('incompatible', 'effects_reference_execution')
                    }
                  })()
                  return pending
                },
              })
            },
          }),
        }),
      })
    },
  })
}
