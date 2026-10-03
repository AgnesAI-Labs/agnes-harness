import type {
  ActionContext,
  ActionHandlerScope,
  CallContext,
  FactoryContext,
  Outcome,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'

export const refused = (code: W.RuntimeError['code'], detailCode: string): Outcome<never> => ({
  ok: false,
  error: {
    code,
    detailCode,
    message: 'Request refused',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'billing-trace',
  },
})
export function inline(schema: W.SchemaRef, value: unknown): W.DataRef {
  const parsed = boundedCanonicalJson(value, { maxBytes: 65536, maxDepth: 32, maxMembers: 10000 })
  if (!parsed.ok) throw new TypeError('bounded data required')
  return {
    kind: 'inline',
    schema,
    value: parsed.value.json,
    digest: canonicalJsonDigest(parsed.value.json),
    bytes: Buffer.byteLength(jcs(parsed.value.json)),
  }
}
export function read<T>(
  ref: W.DataRef,
  schema: W.SchemaRef,
  name: Parameters<typeof validateRuntime>[0],
): Outcome<T> {
  const safe = boundedCanonicalJson(ref, { maxBytes: 70000, maxDepth: 40, maxMembers: 12000 })
  if (
    !safe.ok ||
    !validateRuntime('DataRef', ref).ok ||
    ref.kind !== 'inline' ||
    jcs(ref.schema) !== jcs(schema) ||
    ref.digest !== canonicalJsonDigest(ref.value) ||
    ref.bytes !== Buffer.byteLength(jcs(ref.value))
  )
    return refused('invalid_input', 'input_schema')
  const parsed = validateRuntime(name, ref.value)
  return parsed.ok ? { ok: true, value: parsed.value as T } : refused('invalid_input', 'input_schema')
}
export function wait<T>(promise: Promise<T>, call: CallContext): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('cancelled'))
    call.signal.addEventListener('abort', abort, { once: true })
    if (call.signal.aborted) abort()
    promise
      .then((value) => {
        if (call.signal.aborted) abort()
        else resolve(value)
      }, reject)
      .finally(() => call.signal.removeEventListener('abort', abort))
  })
}
export type ManagedOutbound = {
  target: W.NetworkTarget
  retain(bytes: Uint8Array, context: CallContext): Promise<W.BytesRef>
}
/** Uses only the invocation's restricted port. It has no ambient HTTP client. */
export async function send(
  outbound: ManagedOutbound,
  value: unknown,
  context: ActionContext,
): Promise<Outcome<W.NetworkRequestResult>> {
  const bytes = Buffer.from(jcs(value))
  const bodyRef = await wait(outbound.retain(bytes, context.call), context.call)
  const request: W.NetworkRequest = {
    target: outbound.target,
    method: 'POST',
    bodyRef,
    headers: inline(RuntimeSchemaRefs.ControlledHttpHeaders, { 'content-type': 'application/json' }),
    redirect: { mode: 'deny', maxHops: 0 },
    maxBytes: 65536,
  }
  const result = await wait(
    context.effects.invoke(
      {
        operation: 'agh.network.request',
        input: inline(RuntimeMethodSchemaRefs['agh.network'].request.input, request),
      },
      context.call,
    ),
    context.call,
  )
  return result.ok
    ? read<W.NetworkRequestResult>(
        result.value,
        RuntimeMethodSchemaRefs['agh.network'].request.output,
        'NetworkRequestResult',
      )
    : result
}
export function effect(result: Outcome<W.DataRef>): W.EffectResult {
  return result.ok
    ? { outcome: 'succeeded', result: result.value, externalRequests: [], usage: [], references: [] }
    : {
        outcome:
          result.error.code === 'unknown_effect'
            ? 'unknown_effect'
            : result.error.code === 'cancelled'
              ? 'cancelled'
              : 'failed',
        error: result.error,
        externalRequests: [],
        usage: [],
        references: [],
      }
}
export type ProviderBackend = {
  observe?(input: W.ServiceOperation, context: CallContext): Promise<Outcome<W.DataRef>>
  execute(frame: W.ActionFrame, context: ActionContext, lookupOnly: boolean): Promise<Outcome<W.DataRef>>
  pending(): readonly string[]
  close(): void
}
/** Transport/lifecycle validation shared by these two Host-owned implementations. */
export function providerFactory(
  contract: 'agh.trace' | 'agh.billing',
  digest: string,
  configSchema: W.SchemaRef,
  open: () => ProviderBackend,
): ProviderFactory<ServiceProvider> {
  const schemas = RuntimeMethodSchemaRefs[contract]
  const descriptor: W.ProviderDescriptor = {
    providerId: `agh.default/${contract.slice(4)}`,
    contract,
    major: 1,
    logicalName: 'default',
    packageVersion: '0.0.0',
    packageDigest: digest,
    features: [],
    scope: contract === 'agh.trace' ? 'runtime' : 'workspace',
    configSchema,
    requires: [],
    capabilities: [],
    recovery: 'R2',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: Object.entries(schemas)
      .filter(([method]) =>
        contract === 'agh.trace'
          ? ['record', 'export'].includes(method)
          : ['post', 'refund', 'reconcile'].includes(method),
      )
      .map(([method, refs]) => ({
        method,
        kind: method === 'record' ? 'observe' : 'action',
        inputSchema: refs.input,
        outputSchema: refs.output,
        requiredCapabilities: [],
        retrySafety: method === 'record' ? 'idempotent' : 'reconcile-first',
      })),
  }
  return {
    descriptor,
    async create(config, _dependencies, factory) {
      if (
        config.kind !== 'inline' ||
        jcs(config.schema) !== jcs(configSchema) ||
        config.digest !== canonicalJsonDigest(config.value) ||
        config.bytes !== Buffer.byteLength(jcs(config.value)) ||
        jcs(config.value) !== '{}'
      )
        throw new TypeError('invalid configuration')
      return wrap(open(), factory, descriptor)
    },
  }
}
function wrap(
  backend: ProviderBackend,
  factory: FactoryContext,
  descriptor: W.ProviderDescriptor,
): ServiceProvider {
  const lifetime = new AbortController()
  const observe = backend.observe
  const active = new Map<string, Promise<unknown>>()
  let draining = false,
    closed = false
  const allowed = (call: CallContext): Outcome<void> => {
    if (closed || draining) return refused('denied', 'blocked')
    if (call.signal.aborted || factory.signal.aborted) return refused('cancelled', 'cancelled')
    if (
      call.bindingId !== factory.bindingId ||
      !Object.entries(factory.scope).every(
        ([k, v]) => k === 'kind' || (call.scope as unknown as Record<string, unknown>)[k] === v,
      )
    )
      return refused('denied', 'permission_absent')
    if (!Number.isFinite(Date.parse(call.deadline)) || Date.parse(call.deadline) <= Date.now())
      return refused('timeout', 'deadline')
    return { ok: true, value: undefined }
  }
  async function tracked<T>(
    call: CallContext,
    run: (context: CallContext) => Promise<Outcome<T>>,
  ): Promise<Outcome<T>> {
    const check = allowed(call)
    if (!check.ok) return check
    if (active.has(call.invocationId)) return refused('conflict', 'invocation_busy')
    const timeout = new AbortController()
    const timer = setTimeout(
      () => timeout.abort(),
      Math.min(2147483647, Date.parse(call.deadline) - Date.now()),
    )
    const signal = AbortSignal.any([call.signal, factory.signal, lifetime.signal, timeout.signal])
    const pending = run({ ...call, signal })
    active.set(call.invocationId, pending)
    try {
      return await pending
    } catch {
      return refused('internal', 'storage_failure')
    } finally {
      clearTimeout(timer)
      active.delete(call.invocationId)
    }
  }
  const lifecycle = {
    async ready(call: CallContext) {
      return allowed(call)
    },
    async health(call: CallContext): Promise<Outcome<W.Health>> {
      const p = allowed(call)
      return p.ok ? { ok: true, value: { status: 'ready', diagnosticIds: [] } } : p
    },
    async drain(_deadline: string, _call: CallContext): Promise<Outcome<W.DrainResult>> {
      draining = true
      return {
        ok: true,
        value: {
          state: active.size || backend.pending().length ? 'blocked' : 'drained',
          activeInvocationIds: [...active.keys()],
          durableOwnerRefs: backend.pending().map((id) => ({ kind: 'reconciliation' as const, id })),
          diagnosticIds: [],
        },
      }
    },
    async close() {
      if (closed) return
      closed = true
      lifetime.abort()
      await Promise.allSettled([...active.values()])
      backend.close()
    },
  }
  return {
    ...lifecycle,
    ...(observe
      ? {
          observe: async (request: W.ServiceOperation, call: CallContext) => {
            if (
              request.method !== 'record' ||
              request.target.bindingId !== factory.bindingId ||
              request.target.contract !== descriptor.contract ||
              request.target.providerId !== descriptor.providerId ||
              request.target.logicalName !== descriptor.logicalName
            )
              return refused('denied', 'permission_absent')
            return tracked(call, (c) => observe(request, c))
          },
        }
      : {}),
    actions: Object.fromEntries(
      descriptor.operations
        .filter((o) => o.kind === 'action')
        .map((operation) => [
          operation.method,
          {
            kind: 'leaf' as const,
            recovery: 'R2' as const,
            stateCodec: null,
            async create(scope: ActionHandlerScope) {
              let stopped = false
              const lifetime = new AbortController()
              const tasks = new Map<string, Promise<unknown>>()
              async function execute(frame: W.ActionFrame, context: ActionContext, lookupOnly: boolean) {
                const { signal: _signal, ...wire } = context.call
                if (stopped || scope.signal.aborted) return effect(refused('denied', 'blocked'))
                if (
                  !validateRuntime('ActionFrame', frame).ok ||
                  frame.method !== operation.method ||
                  frame.actionId !== scope.actionId ||
                  frame.runId !== scope.runId ||
                  frame.bindingId !== factory.bindingId ||
                  scope.bindingId !== factory.bindingId ||
                  frame.invocationId !== context.call.invocationId ||
                  jcs(frame.context) !== jcs(wire) ||
                  frame.input.kind !== 'inline' ||
                  frame.inputDigest !== frame.input.digest ||
                  jcs(scope.scope) !== jcs(context.call.scope)
                )
                  return effect(refused('invalid_input', 'input_schema'))
                const pending = tracked(
                  {
                    ...context.call,
                    signal: AbortSignal.any([context.call.signal, scope.signal, lifetime.signal]),
                  },
                  (call) => backend.execute(frame, { ...context, call }, lookupOnly),
                )
                tasks.set(context.call.invocationId, pending)
                try {
                  return effect(await pending)
                } finally {
                  tasks.delete(context.call.invocationId)
                }
              }
              return {
                ...lifecycle,
                ready: async (call: CallContext) =>
                  stopped ? refused('denied', 'blocked') : lifecycle.ready(call),
                health: async (call: CallContext) =>
                  stopped ? refused('denied', 'blocked') : lifecycle.health(call),
                async drain(): Promise<Outcome<W.DrainResult>> {
                  stopped = true
                  return {
                    ok: true,
                    value: {
                      state: tasks.size ? 'blocked' : 'drained',
                      activeInvocationIds: [...tasks.keys()],
                      durableOwnerRefs: [],
                      diagnosticIds: [],
                    },
                  }
                },
                kind: 'leaf' as const,
                effectSemantics: 'receipt-query' as const,
                executionUnit: 'single-effect' as const,
                close: async () => {
                  stopped = true
                  lifetime.abort()
                  await Promise.allSettled([...tasks.values()])
                },
                execute: (f: W.ActionFrame, c: ActionContext) => execute(f, c, false),
                reconcile: async (
                  f: W.ActionFrame,
                  _e: readonly W.DataRef[],
                  c: ActionContext,
                ): Promise<W.ReconcileResult> => {
                  const r = await execute(f, c, true)
                  return r.outcome === 'succeeded' && r.result
                    ? { kind: 'resolved', evidence: r.result, result: r }
                    : {
                        kind: 'unknown',
                        reason: 'Reconciliation remains unconfirmed',
                        evidence: inline(RuntimeSchemaRefs.StandardToolOutput, {
                          content: [],
                          structured: { outcome: r.outcome, detailCode: r.error?.detailCode ?? null },
                        }),
                      }
                },
              }
            },
          },
        ]),
    ),
  }
}
