import type { ActionContext, ActionProviderFactory, CallContext } from '@agnes/extension-api/runtime'
import {
  type ActionFrame,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type EffectResult,
  type JsonValue,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { type PureHookStage, PureHookStageFailure, runPureHookStage } from '../hooks/stages.js'

/** Host-only installation boundary. Historical values alone cannot implement current checks. */
export interface HookActionOwner {
  capture(frame: ActionFrame, context: ActionContext): Promise<PureHookStage>
  check(stage: PureHookStage, frame: ActionFrame, context: ActionContext): Promise<void>
}
const method = RuntimeMethodSchemaRefs['agh.effects'].runHooks
const same = (a: unknown, b: unknown) =>
  canonicalJsonDigest(a as JsonValue) === canonicalJsonDigest(b as JsonValue)
function failure(code: 'denied' | 'cancelled' | 'invalid_input', detail: string): EffectResult {
  return {
    outcome: code === 'cancelled' ? 'cancelled' : 'failed',
    error: new PureHookStageFailure(code, detail).error,
    externalRequests: [],
    usage: [],
    references: [],
  }
}
function fixedFrame(frame: ActionFrame): ActionFrame {
  const encoded = boundedCanonicalJson(frame, { maxBytes: 1048576, maxDepth: 64, maxMembers: 10000 })
  if (!encoded.ok || !validateRuntime('ActionFrame', encoded.value.json).ok)
    throw new TypeError('Invalid hook action frame')
  return JSON.parse(encoded.value.canonical) as ActionFrame
}
export function createInstalledHookActions(
  owner: HookActionOwner,
  parent?: {
    check(context: CallContext): void
    signal: AbortSignal
    track(pending: Promise<EffectResult>, invocationId: string): void
  },
): ActionProviderFactory {
  const capture = Object.getOwnPropertyDescriptor(owner, 'capture')?.value
  const check = Object.getOwnPropertyDescriptor(owner, 'check')?.value
  if (typeof capture !== 'function' || typeof check !== 'function')
    throw new TypeError('Hook owner requires original methods')
  return {
    kind: 'leaf',
    recovery: 'R0',
    stateCodec: null,
    async create(scope) {
      const stop = new AbortController()
      let pending: Promise<EffectResult> | undefined
      let fingerprint: string | undefined
      let captured: PureHookStage | undefined
      let activeInvocation: string | undefined
      const current = (context: CallContext) => {
        parent?.check(context)
        if (stop.signal.aborted || scope.signal.aborted || context.signal.aborted || parent?.signal.aborted)
          throw new PureHookStageFailure('cancelled', 'effects_hooks_cancelled')
        if (
          Object.getOwnPropertyDescriptor(owner, 'capture')?.value !== capture ||
          Object.getOwnPropertyDescriptor(owner, 'check')?.value !== check
        )
          throw new PureHookStageFailure('denied', 'effects_hooks_owner_changed')
      }
      return {
        kind: 'leaf',
        effectSemantics: 'idempotent',
        async ready(context) {
          try {
            current(context)
            return { ok: true, value: undefined }
          } catch (error) {
            return {
              ok: false,
              error:
                error instanceof PureHookStageFailure
                  ? error.error
                  : new PureHookStageFailure('denied', 'effects_hooks_source').error,
            }
          }
        },
        async health() {
          return { ok: true, value: { status: stop.signal.aborted ? 'failed' : 'ready', diagnosticIds: [] } }
        },
        async drain() {
          stop.abort()
          return {
            ok: true,
            value: {
              state: activeInvocation ? 'blocked' : 'drained',
              activeInvocationIds: activeInvocation ? [activeInvocation] : [],
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        async close() {
          stop.abort()
        },
        async reconcile() {
          throw new PureHookStageFailure('incompatible', 'effects_hooks_reconcile_unavailable')
        },
        async execute(input, context) {
          let frame: ActionFrame
          try {
            current(context.call)
            frame = fixedFrame(input)
            const { signal: _signal, ...wireCall } = context.call
            if (
              !same(frame.context, wireCall) ||
              frame.method !== 'runHooks' ||
              frame.actionId !== scope.actionId ||
              frame.runId !== scope.runId ||
              frame.bindingId !== scope.bindingId ||
              context.call.bindingId !== scope.bindingId ||
              context.call.invocationId !== frame.invocationId ||
              !same(context.call.scope, scope.scope) ||
              !same(frame.context.scope, scope.scope) ||
              !same(frame.input.schema, method.input) ||
              frame.input.kind !== 'inline' ||
              frame.inputDigest !== canonicalJsonDigest(frame.input)
            )
              return failure('invalid_input', 'effects_hooks_frame')
            const body = boundedCanonicalJson(frame.input.value, {
              maxBytes: 1048576,
              maxDepth: 64,
              maxMembers: 10000,
            })
            if (
              !body.ok ||
              body.value.bytes !== frame.input.bytes ||
              canonicalJsonDigest(body.value.json) !== frame.input.digest
            )
              return failure('invalid_input', 'effects_hooks_input')
            const digest = canonicalJsonDigest(frame as unknown as JsonValue)
            if (fingerprint !== undefined) {
              if (fingerprint !== digest || !pending) return failure('denied', 'effects_hooks_replay')
              const result = await pending
              if (!captured) return failure('denied', 'effects_hooks_replay')
              await check.call(owner, captured, frame, context)
              current(context.call)
              return result
            }
            fingerprint = digest
          } catch (error) {
            return failure(
              error instanceof PureHookStageFailure && error.error.code === 'cancelled'
                ? 'cancelled'
                : 'denied',
              'effects_hooks_source',
            )
          }
          const signal = AbortSignal.any([
            stop.signal,
            scope.signal,
            context.call.signal,
            ...(parent ? [parent.signal] : []),
          ])
          activeInvocation = frame.invocationId
          pending = (async (): Promise<EffectResult> => {
            try {
              const stage = (await capture.call(owner, frame, context)) as PureHookStage
              captured = stage
              const verify = async () => {
                current(context.call)
                await check.call(owner, stage, frame, context)
                current(context.call)
              }
              await verify()
              if (
                stage.sourceActionId !== frame.actionId ||
                stage.request.owner.runId !== frame.runId ||
                frame.input.kind !== 'inline' ||
                !same(stage.request, frame.input.value)
              )
                return failure('denied', 'effects_hooks_stage')
              const evaluated = await runPureHookStage({ ...stage, signal }, verify)
              await verify()
              const output = boundedCanonicalJson(evaluated.result, {
                maxBytes: 1048576,
                maxDepth: 64,
                maxMembers: 10000,
              })
              if (!output.ok) return failure('invalid_input', 'effects_hooks_output')
              const result: EffectResult = {
                outcome: 'succeeded',
                result: {
                  kind: 'inline',
                  schema: method.output,
                  value: output.value.json,
                  bytes: output.value.bytes,
                  digest: canonicalJsonDigest(output.value.json),
                },
                externalRequests: [],
                usage: [],
                references: [],
              }
              return validateRuntime('EffectResult', result).ok
                ? result
                : failure('invalid_input', 'effects_hooks_output')
            } catch (error) {
              return failure(
                signal.aborted || (error instanceof PureHookStageFailure && error.error.code === 'cancelled')
                  ? 'cancelled'
                  : 'denied',
                'effects_hooks_source',
              )
            }
          })().finally(() => {
            activeInvocation = undefined
          })
          parent?.track(pending, frame.invocationId)
          return pending
        },
      }
    },
  }
}
