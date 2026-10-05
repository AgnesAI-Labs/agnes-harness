import type {
  AuthorSchema,
  CallContext,
  EffectPorts,
  EffectResult,
  EmptyAuthorConfig,
  FactoryContext,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type EffectsDispatchRequest,
  type EffectsDispatchResult,
  type EffectsReconcileRequest,
  type ExternalRequestRef,
  type ProviderDescriptor,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { AdmittedEffectAttempt, EffectsAuthority } from '../src/runtime/effects/authority.js'
import { createDefaultEffectsFactory } from '../src/runtime/providers/effects.js'

const hash = (v: unknown) => canonicalJsonDigest(v as never)
const methods = RuntimeMethodSchemaRefs['agh.effects']
/** Independent coordinator; installed authority owns State and current capabilities. */
export function createReferenceEffectsDispatchFactory(
  owner: EffectsAuthority,
  descriptor: ProviderDescriptor,
  configCodec: AuthorSchema<EmptyAuthorConfig>,
): ProviderFactory<ServiceProvider> {
  const base = createDefaultEffectsFactory(descriptor, configCodec)
  const selectedDescriptor = base.descriptor
  if (
    !owner ||
    selectedDescriptor.contract !== 'agh.effects' ||
    !['dispatch', 'reconcile', 'runHooks'].every((method) =>
      selectedDescriptor.operations.some(
        (operation) =>
          operation.method === method && operation.kind === (method === 'runHooks' ? 'action' : 'control'),
      ),
    )
  )
    throw Error('Missing Effects owner')
  return {
    descriptor: selectedDescriptor,
    async create(config, _dependencies, factory: FactoryContext) {
      await base.create(config, _dependencies, factory)
      let state: 'created' | 'ready' | 'closing' | 'closed' = 'created'
      const descriptorBody = hash(selectedDescriptor),
        configBody = hash(config)
      const relation = hash({
        bindingId: factory.bindingId,
        scope: factory.scope,
        instanceId: factory.instanceId,
      })
      const signal = factory.signal
      const callbacks = [
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
      function capture<K extends keyof EffectsAuthority>(key: K): EffectsAuthority[K] {
        const property = Object.getOwnPropertyDescriptor(owner, key)
        if (!property || !('value' in property) || typeof property.value !== 'function')
          throw Error('Reference owner requires own data callbacks')
        return property.value
      }
      const originals = callbacks.map((key) => [key, capture(key)] as const)
      const clock = capture('now')
      const active = new Map<Promise<unknown>, string>()
      const fence = (call: CallContext, tail = false) => {
        const deadline = Date.parse(call.deadline)
        const now = tail ? deadline : Date.parse(clock.call(owner))
        if (
          hash(selectedDescriptor) !== descriptorBody ||
          hash(config) !== configBody ||
          state !== 'ready' ||
          signal !== factory.signal ||
          signal.aborted ||
          call.signal.aborted ||
          call.bindingId !== factory.bindingId ||
          hash(call.scope) !== hash(factory.scope) ||
          hash({ bindingId: factory.bindingId, scope: factory.scope, instanceId: factory.instanceId }) !==
            relation ||
          originals.some(([key, fn]) => {
            const property = Object.getOwnPropertyDescriptor(owner, key)
            return !property || !('value' in property) || property.value !== fn
          }) ||
          !Number.isFinite(deadline) ||
          !Number.isFinite(now) ||
          (!tail && deadline <= now)
        )
          throw Error('Reference Effects closed')
      }
      async function execute(
        request: EffectsDispatchRequest,
        call: CallContext,
        gate: (tail?: boolean) => void,
      ): Promise<EffectsDispatchResult> {
        gate()
        await owner.checkCurrent(call)
        gate()
        const action = await owner.readCommitted(request, call)
        gate()
        const body = hash(action)
        const ticket = await owner.admit(action, request, call)
        gate()
        owner.assertOriginal(ticket, call)
        gate()
        if (ticket.original !== action || hash(action) !== body) throw Error('Original action changed')
        if (ticket.state.status === 'unknown' || ticket.state.status === 'settled') return ticket.state
        if (ticket.state.status === 'running') {
          try {
            return await owner.unknown(ticket, ticket.externalRequests)
          } catch {
            throw new ReferenceUncertain(ticket)
          }
        }
        const leaf = ticket.leaf,
          ports = ticket.context.effects,
          frame = hash(ticket.frame),
          identity = hash(ticket.requestIdentity)
        const invocationProperty = Object.getOwnPropertyDescriptor(ports, 'invoke')
        if (
          !invocationProperty ||
          !('value' in invocationProperty) ||
          typeof invocationProperty.value !== 'function'
        )
          throw Error('Reference primitive needs a data callback')
        const originalInvoke: EffectPorts['invoke'] = invocationProperty.value
        const evidence: ExternalRequestRef[] = []
        const work = new Set<Promise<unknown>>()
        let sent = false,
          taken = false,
          closed = false,
          failed = false
        const selected = (tail = false) => {
          gate(tail)
          if (
            closed ||
            ticket.leaf !== leaf ||
            ticket.context.effects !== ports ||
            Object.getOwnPropertyDescriptor(ports, 'invoke')?.value !== originalInvoke ||
            !('value' in (Object.getOwnPropertyDescriptor(ports, 'invoke') ?? {})) ||
            hash(ticket.frame) !== frame ||
            hash(ticket.requestIdentity) !== identity
          )
            throw Error('Leaf source changed')
        }
        const limited: EffectPorts = {
          async invoke(input, context) {
            selected()
            owner.assertOriginal(ticket, call)
            selected()
            if (taken || context !== ticket.context.call) throw Error('Primitive effect already taken')
            taken = true
            const originalInput = hash(input),
              ref = owner.external(ticket, input),
              originalRef = hash(ref)
            const pending = (async () => {
              await owner.markRunning(ticket, ref)
              selected()
              owner.assertOriginal(ticket, call)
              selected()
              owner.assertSend(ticket, input, context)
              selected(true)
              if (hash(input) !== originalInput || hash(ref) !== originalRef)
                throw Error('Physical request changed')
              sent = true
              evidence.push(ref)
              return originalInvoke.call(ports, input, context)
            })()
            work.add(pending)
            active.set(pending, call.invocationId)
            void pending.then(
              () => active.delete(pending),
              () => active.delete(pending),
            )
            try {
              return await pending
            } catch (cause) {
              failed = true
              throw cause
            } finally {
              work.delete(pending)
            }
          },
          async stream() {
            throw Error('Stream unavailable')
          },
          async upload() {
            throw Error('Upload unavailable')
          },
        }
        let completed: EffectResult | undefined
        const unknown = async () => {
          try {
            return await owner.unknown(ticket, evidence, completed)
          } catch {
            throw new ReferenceUncertain(ticket)
          }
        }
        try {
          selected()
          const result = await leaf.execute(ticket.frame, { ...ticket.context, effects: limited })
          completed = result
          closed = true
          if (result.outcome === 'unknown_effect' || (sent && failed)) return unknown()
          await Promise.allSettled([...work])
          if (sent && failed) return unknown()
          try {
            return await owner.intake(ticket, result)
          } catch (cause) {
            if (!sent) throw cause
            return unknown()
          }
        } catch (cause) {
          closed = true
          if (sent) return unknown()
          await Promise.allSettled([...work])
          throw cause
        }
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
                  return {
                    ok: false,
                    error: {
                      ...refusal(false).error,
                      code: 'incompatible',
                      detailCode: 'reference_hooks_not_installed',
                    },
                  }
                },
                async health() {
                  return {
                    ok: true,
                    value: { status: 'failed', diagnosticIds: ['reference_hooks_not_installed'] },
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
                    error: {
                      ...refusal(false).error,
                      code: 'incompatible',
                      detailCode: 'reference_hooks_not_installed',
                    },
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

        async ready(call) {
          try {
            if (state !== 'created') throw Error('Not new')
            const ready = await owner.open(config, factory)
            if (!ready.ok) return ready
            await owner.checkCurrent(call)
            if (state !== 'created') throw Error('Closed during open')
            state = 'ready'
            fence(call)
            return { ok: true, value: undefined }
          } catch {
            return refusal(false)
          }
        },
        async control(operation, call) {
          let durable = false
          let committedResult: EffectsDispatchResult | undefined
          const task = (async () => {
            try {
              fence(call)
              const method = operation.method
              if (method !== 'dispatch' && method !== 'reconcile') throw Error('Unsupported control')
              if (
                !validateRuntime('ServiceOperation', operation).ok ||
                operation.target.bindingId !== factory.bindingId ||
                operation.target.contract !== selectedDescriptor.contract ||
                operation.target.providerId !== selectedDescriptor.providerId
              )
                throw Error('Wrong target')
              const ref = operation.input,
                schema = methods[method].input
              const body =
                ref.kind === 'inline'
                  ? boundedCanonicalJson(ref.value, { maxBytes: 65536, maxDepth: 64, maxMembers: 10000 })
                  : undefined
              if (
                !validateRuntime('DataRef', ref).ok ||
                ref.kind !== 'inline' ||
                !body?.ok ||
                hash(ref.schema) !== hash(schema) ||
                ref.digest !== hash(body.value.json) ||
                ref.bytes !== body.value.bytes
              )
                throw Error('Invalid input')
              const parsed = validateRuntime(
                method === 'dispatch' ? 'EffectsDispatchRequest' : 'EffectsReconcileRequest',
                body.value.json,
              )
              if (!parsed.ok) throw Error('Invalid request')
              const { signal: _signal, ...wire } = call,
                callBody = hash(wire),
                opBody = hash(operation)
              const gate = (tail = false) => {
                fence(call, tail)
                const { signal: _s, ...next } = call
                if (hash(next) !== callBody || hash(operation) !== opBody) throw Error('Call changed')
              }
              let result: EffectsDispatchResult
              if (method === 'dispatch')
                result = await execute(parsed.value as EffectsDispatchRequest, call, gate)
              else {
                gate()
                await owner.checkCurrent(call)
                gate()
                result = await owner.reconcile(parsed.value as EffectsReconcileRequest, call)
                gate()
              }
              durable = true
              committedResult = result
              const expected = hash(result)
              const output = await owner.publish(method, result, call)
              gate()
              if (
                !validateRuntime('DataRef', output).ok ||
                output.kind !== 'inline' ||
                hash(output.schema) !== hash(methods[method].output) ||
                output.digest !== expected ||
                hash(output.value) !== expected
              )
                throw Error('Output changed')
              return { ok: true as const, value: output }
            } catch (cause) {
              const refused = refusal(durable || cause instanceof ReferenceUncertain)
              const attempt =
                committedResult?.attemptRef ??
                (cause instanceof ReferenceUncertain ? cause.original.attempt : undefined)
              return attempt
                ? {
                    ok: false as const,
                    error: {
                      ...refused.error,
                      safeDetail: { attemptRef: attempt, receiptRef: committedResult?.receiptRef ?? null },
                    },
                  }
                : refused
            }
          })()
          active.set(task, call.invocationId)
          try {
            return await task
          } finally {
            active.delete(task)
          }
        },
        async health(call) {
          fence(call)
          return owner.health(call)
        },
        async drain() {
          if (state !== 'closed') state = 'closing'
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
          state = 'closed'
          await owner.close(reason)
        },
      }
      return provider
    },
  }
}
class ReferenceUncertain extends Error {
  constructor(readonly original: AdmittedEffectAttempt) {
    super('Original effect outcome unresolved')
  }
}
function refusal(unknown: boolean) {
  return {
    ok: false as const,
    error: {
      code: unknown ? ('unknown_effect' as const) : ('internal' as const),
      detailCode: 'reference_effects_refused',
      message: 'Reference Effects operation refused',
      retryAdvice: { kind: 'never' as const },
      diagnosticId: 'reference-effects',
    },
  }
}
