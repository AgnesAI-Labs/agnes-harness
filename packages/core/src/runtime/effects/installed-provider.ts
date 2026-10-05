import type {
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  FactoryContext,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type EffectsDispatchRequest,
  type EffectsReconcileRequest,
  type ProviderDescriptor,
  type RuntimeError,
  RuntimeMethodSchemaRefs,
  type ServiceOperation,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { createDefaultEffectsFactory } from '../providers/effects.js'
import type { EffectsAuthority } from './authority.js'
import { dispatchCommittedEffect, EffectUncertain } from './dispatch.js'
import { createInstalledHookActions, type HookActionOwner } from './hook-actions.js'
import { reconcileCommittedEffect } from './reconciliation.js'

const wire = (context: CallContext) => {
  const { signal: _signal, ...value } = context
  return value
}
const methods = RuntimeMethodSchemaRefs['agh.effects']
const error = (code: RuntimeError['code'], detailCode: string): RuntimeError => ({
  code,
  detailCode,
  message: 'Effects operation refused',
  retryAdvice: { kind: 'never' },
  diagnosticId: 'effects-provider',
})
const same = (a: unknown, b: unknown) => canonicalJsonDigest(a as never) === canonicalJsonDigest(b as never)
function decode(request: ServiceOperation): EffectsDispatchRequest | EffectsReconcileRequest {
  const method = request.method
  if (method !== 'dispatch' && method !== 'reconcile') throw new Error('Unsupported effects method')
  const ref = request.input
  const body =
    ref.kind === 'inline'
      ? boundedCanonicalJson(ref.value, { maxBytes: 65536, maxDepth: 64, maxMembers: 10000 })
      : undefined
  if (
    !validateRuntime('DataRef', ref).ok ||
    ref.kind !== 'inline' ||
    !body?.ok ||
    !same(ref.schema, methods[method].input) ||
    ref.bytes !== body.value.bytes ||
    ref.digest !== canonicalJsonDigest(body.value.json)
  )
    throw new Error('Invalid effects input')
  const parsed = validateRuntime(
    method === 'dispatch' ? 'EffectsDispatchRequest' : 'EffectsReconcileRequest',
    body.value.json,
  )
  if (!parsed.ok) throw new Error('Invalid effects request')
  return parsed.value as EffectsDispatchRequest | EffectsReconcileRequest
}
/** Control belongs to the installed Host dispatch path. */
export function createInstalledEffectsFactory(
  authority: EffectsAuthority,
  descriptor: ProviderDescriptor,
  configCodec: AuthorSchema<EmptyAuthorConfig>,
  hookOwner?: HookActionOwner,
): ProviderFactory<ServiceProvider> {
  const base = createDefaultEffectsFactory(descriptor, configCodec)
  const selectedDescriptor = base.descriptor
  if (
    !authority ||
    selectedDescriptor.contract !== 'agh.effects' ||
    !['dispatch', 'reconcile', 'runHooks'].every((method) =>
      selectedDescriptor.operations.some(
        (operation) =>
          operation.method === method && operation.kind === (method === 'runHooks' ? 'action' : 'control'),
      ),
    )
  )
    throw new Error('Effects owner is required')
  return {
    descriptor: selectedDescriptor,
    async create(config: DataRef, _dependencies, factory: FactoryContext) {
      await base.create(config, _dependencies, factory)
      const descriptorRelation = canonicalJsonDigest(selectedDescriptor as never)
      const configRelation = canonicalJsonDigest(config as never)
      const factoryRelation = canonicalJsonDigest({
        bindingId: factory.bindingId,
        scope: factory.scope,
        instanceId: factory.instanceId,
      })
      const signal = factory.signal
      const names = [
        'now',
        'open',
        'checkCurrent',
        'assertSend',
        'readCommitted',
        'admit',
        'assertOriginal',
        'external',
        'markRunning',
        'intake',
        'unknown',
        'reconcile',
        'publish',
        'health',
        'close',
      ] as const
      const capture = <K extends keyof EffectsAuthority>(key: K): EffectsAuthority[K] => {
        const property = Object.getOwnPropertyDescriptor(authority, key)
        if (!property || !('value' in property) || typeof property.value !== 'function')
          throw new Error('Effects owner requires own data methods')
        return property.value
      }
      const original = names.map((key) => [key, capture(key)] as const)
      const clock = capture('now')
      let phase: 'created' | 'ready' | 'draining' | 'closed' = 'created'
      const active = new Map<Promise<unknown>, string>()
      const hookStop = new AbortController()
      const source = () => {
        if (
          canonicalJsonDigest(selectedDescriptor as never) !== descriptorRelation ||
          canonicalJsonDigest(config as never) !== configRelation ||
          factory.signal !== signal ||
          signal.aborted ||
          canonicalJsonDigest({
            bindingId: factory.bindingId,
            scope: factory.scope,
            instanceId: factory.instanceId,
          }) !== factoryRelation ||
          original.some(([key, value]) => {
            const property = Object.getOwnPropertyDescriptor(authority, key)
            return !property || !('value' in property) || property.value !== value
          })
        )
          throw new Error('Effects source changed')
      }
      const current = (context: CallContext, staticOnly = false) => {
        source()
        const deadline = Date.parse(context.deadline)
        const now = staticOnly ? deadline : Date.parse(clock.call(authority))
        source()
        if (
          !Number.isFinite(deadline) ||
          !Number.isFinite(now) ||
          phase !== 'ready' ||
          context.signal.aborted ||
          context.bindingId !== factory.bindingId ||
          !same(context.scope, factory.scope) ||
          (!staticOnly && deadline <= now)
        )
          throw new Error('Effects invocation is not current')
      }
      const provider: ServiceProvider = {
        actions: {
          runHooks: {
            kind: 'leaf',
            recovery: 'R0',
            stateCodec: null,
            async create() {
              return {
                kind: 'leaf',
                effectSemantics: 'non-idempotent',
                async ready() {
                  return { ok: false, error: error('incompatible', 'effects_hooks_not_installed') }
                },
                async health() {
                  return {
                    ok: true,
                    value: { status: 'failed', diagnosticIds: ['effects_hooks_not_installed'] },
                  }
                },
                async drain() {
                  return {
                    ok: true,
                    value: {
                      state: 'drained',
                      activeInvocationIds: [],
                      durableOwnerRefs: [],
                      diagnosticIds: [],
                    },
                  }
                },
                async close() {},
                async execute() {
                  return {
                    outcome: 'failed',
                    error: error('incompatible', 'effects_hooks_not_installed'),
                    externalRequests: [],
                    usage: [],
                    references: [],
                  }
                },
                async reconcile() {
                  throw Error('Hooks are not installed')
                },
              }
            },
          },
        },

        async ready(context) {
          try {
            source()
            if (phase !== 'created') throw new Error('Effects already opened')
            const result = await authority.open(config, factory)
            source()
            if (!result.ok) return result
            await authority.checkCurrent(context)
            source()
            if (phase !== 'created') throw new Error('Effects closed during ready')
            phase = 'ready'
            current(context)
            return { ok: true, value: undefined }
          } catch {
            return { ok: false, error: error('internal', 'effects_owner_unavailable') }
          }
        },
        async control(request, context) {
          const method = request.method
          if (method !== 'dispatch' && method !== 'reconcile')
            return { ok: false, error: error('incompatible', 'effects_method_not_installed') }
          let committed = false
          let durable: import('@agnes/protocol/runtime').EffectsDispatchResult | undefined
          const task = (async () => {
            try {
              current(context)
              const relation = canonicalJsonDigest(wire(context))
              if (
                !validateRuntime('ServiceOperation', request).ok ||
                request.target.bindingId !== factory.bindingId ||
                request.target.contract !== selectedDescriptor.contract ||
                request.target.providerId !== selectedDescriptor.providerId
              )
                throw new Error('Effects target is not selected')
              const input = decode(request)
              const requestDigest = canonicalJsonDigest(request as never)
              const gate = (staticOnly = false) => {
                current(context, staticOnly)
                if (
                  canonicalJsonDigest(wire(context)) !== relation ||
                  canonicalJsonDigest(request as never) !== requestDigest
                )
                  throw new Error('Effects call changed')
              }
              const result =
                method === 'dispatch'
                  ? await dispatchCommittedEffect(
                      authority,
                      input as EffectsDispatchRequest,
                      context,
                      gate,
                      (pending) => {
                        active.set(pending, context.invocationId)
                        void pending.then(
                          () => active.delete(pending),
                          () => active.delete(pending),
                        )
                      },
                    )
                  : await reconcileCommittedEffect(authority, input as EffectsReconcileRequest, context, gate)
              committed = true
              durable = result
              const resultDigest = canonicalJsonDigest(result as never)
              const output = await authority.publish(method, result, context)
              gate()
              if (
                !validateRuntime('DataRef', output).ok ||
                !same(output.schema, methods[method].output) ||
                output.kind !== 'inline' ||
                output.digest !== resultDigest ||
                canonicalJsonDigest(output.value) !== resultDigest
              )
                throw new Error('Effects result codec changed')
              return { ok: true as const, value: output }
            } catch (cause) {
              const fault = error(
                committed || cause instanceof EffectUncertain ? 'unknown_effect' : 'internal',
                committed ? 'effects_durable_result_unpublished' : 'effects_dispatch_refused',
              )
              const attempt =
                durable?.attemptRef ?? (cause instanceof EffectUncertain ? cause.attempt : undefined)
              if (attempt) fault.safeDetail = { attemptRef: attempt, receiptRef: durable?.receiptRef ?? null }
              return { ok: false as const, error: fault }
            }
          })()
          active.set(task, context.invocationId)
          try {
            return await task
          } finally {
            active.delete(task)
          }
        },
        async health(context) {
          source()
          return authority.health(context)
        },
        async drain(_deadline, _context) {
          if (phase !== 'closed') phase = 'draining'
          hookStop.abort()
          return {
            ok: true,
            value: {
              state: active.size ? 'blocked' : 'drained',
              activeInvocationIds: [...new Set(active.values())],
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        async close(reason) {
          phase = 'closed'
          hookStop.abort()
          await authority.close(reason)
        },
      }
      return hookOwner
        ? {
            ...provider,
            actions: {
              ...provider.actions,
              runHooks: createInstalledHookActions(hookOwner, {
                check: current,
                signal: hookStop.signal,
                track(pending, invocationId) {
                  active.set(pending, invocationId)
                  void pending.then(
                    () => active.delete(pending),
                    () => active.delete(pending),
                  )
                },
              }),
            },
          }
        : provider
    },
  }
}
