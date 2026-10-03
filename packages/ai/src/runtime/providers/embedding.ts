import type {
  ActionContext,
  ActionHandlerScope,
  BlobReadPort,
  CallContext,
  FactoryContext,
  MethodHandler,
  Outcome,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  embeddingData,
  embeddingFailure,
  embeddingRef,
  interruptible,
  readEmbeddingVectors,
} from '../embedding/data.js'
import { EmbeddingConflict, openEmbeddingJournal } from '../embedding/journal.js'

/** Only a synthetic, explicitly bounded network fixture is supported until the model gateway is delivered. */
export type EmbeddingDeployment = {
  path: string
  packageDigest: string
  configSchema: W.SchemaRef
  run: W.RunRef
  authorize(call: CallContext): Promise<boolean>
  blobRead?: BlobReadPort
  usage?: { binding: W.BindingRef; control: MethodHandler }
  fixture?: {
    kind: 'restricted-effects'
    inputDigest: string
    request: W.NetworkRequest
    measurement: W.UsageMeasurement
  }
}
export function createEmbeddingFactory(deployment: EmbeddingDeployment): ProviderFactory<ServiceProvider> {
  const d = {
    ...deployment,
    run: structuredClone(deployment.run),
    configSchema: structuredClone(deployment.configSchema),
    ...(deployment.fixture ? { fixture: structuredClone(deployment.fixture) } : {}),
  }
  const schemas = RuntimeMethodSchemaRefs['agh.embedding'].encode
  const descriptor: W.ProviderDescriptor = {
    providerId: 'agh.default/embedding',
    contract: 'agh.embedding',
    major: 1,
    logicalName: 'default',
    packageVersion: '0.0.0',
    packageDigest: d.packageDigest,
    features: [],
    scope: 'workspace',
    configSchema: d.configSchema,
    requires: [],
    capabilities: [],
    recovery: 'R2',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: [
      {
        method: 'encode',
        kind: 'action',
        inputSchema: schemas.input,
        outputSchema: schemas.output,
        requiredCapabilities: [],
        retrySafety: 'reconcile-first',
      },
    ],
  }
  return {
    descriptor,
    async create(config, _dependencies, factory) {
      if (
        jcs(
          await embeddingData(config, d.configSchema, {
            ...factory,
            principalRef: 'configuration',
            invocationId: 'configuration',
            authorizationRef: 'configuration',
            traceRef: 'configuration',
            deadline: '2030-01-01T00:00:00Z',
          }),
        ) !== '{}'
      )
        throw new TypeError('Invalid embedding configuration')
      return openProvider(d, factory)
    },
  }
}
function openProvider(d: EmbeddingDeployment, factory: FactoryContext): ServiceProvider {
  const journal = openEmbeddingJournal(d.path),
    lifetime = new AbortController()
  const active = new Map<string, Promise<W.EffectResult>>(),
    busy = new Set<string>()
  let closed = false,
    draining = false
  async function admitted(call: CallContext): Promise<Outcome<void>> {
    if (closed || draining) return { ok: false, error: embeddingFailure('denied', 'blocked').error }
    if (call.signal.aborted || factory.signal.aborted)
      return { ok: false, error: embeddingFailure('cancelled', 'cancelled').error }
    if (
      call.bindingId !== factory.bindingId ||
      jcs(call.scope) !== jcs(factory.scope) ||
      !(await interruptible(d.authorize(call), call.signal))
    )
      return { ok: false, error: embeddingFailure('denied', 'permission_absent').error }
    if (!Number.isFinite(Date.parse(call.deadline)) || Date.parse(call.deadline) <= Date.now())
      return { ok: false, error: embeddingFailure('timeout', 'deadline').error }
    return { ok: true, value: undefined }
  }
  const lifecycle = {
    ready: admitted,
    async health(call: CallContext): Promise<Outcome<W.Health>> {
      const check = await admitted(call)
      return check.ok ? { ok: true, value: { status: 'ready', diagnosticIds: [] } } : check
    },
    async drain(): Promise<Outcome<W.DrainResult>> {
      draining = true
      return {
        ok: true,
        value: {
          state: active.size || journal.pending().length ? 'blocked' : 'drained',
          activeInvocationIds: [...active.keys()],
          durableOwnerRefs: journal.pending().map((id) => ({ kind: 'reconciliation' as const, id })),
          diagnosticIds: [],
        },
      }
    },
    async close() {
      if (closed) return
      closed = true
      lifetime.abort()
      await Promise.allSettled([...active.values()])
      journal.close()
    },
  }
  async function run(
    frame: W.ActionFrame,
    context: ActionContext,
    scope: ActionHandlerScope,
    lookupOnly: boolean,
  ): Promise<W.EffectResult> {
    let identity = '',
      entered = false,
      ownsBusy = false
    try {
      frame = structuredClone(frame)
      const check = await admitted(context.call)
      if (!check.ok) return embeddingFailure(check.error.code, check.error.detailCode)
      const { signal: _signal, ...wire } = context.call
      if (
        !validateRuntime('ActionFrame', frame).ok ||
        frame.method !== 'encode' ||
        frame.bindingId !== factory.bindingId ||
        scope.bindingId !== factory.bindingId ||
        scope.instanceId !== factory.instanceId ||
        frame.actionId !== scope.actionId ||
        frame.runId !== scope.runId ||
        frame.runId !== d.run.runId ||
        jcs(scope.scope) !== jcs(factory.scope) ||
        frame.invocationId !== context.call.invocationId ||
        jcs(frame.context) !== jcs(wire) ||
        frame.input.kind !== 'inline' ||
        frame.inputDigest !== frame.input.digest
      )
        return embeddingFailure('invalid_input', 'input_schema')
      const decoded = await embeddingData(
        frame.input,
        RuntimeMethodSchemaRefs['agh.embedding'].encode.input,
        context.call,
        d.blobRead,
      )
      const request = validateRuntime('EmbeddingEncodeRequest', decoded)
      if (!request.ok || request.value.dimensions < 1 || request.value.dimensions > 10000)
        return embeddingFailure('invalid_input', 'embedding_dimensions')
      const owner = { scope: context.call.scope }
      const attemptRef: W.AttemptRef = { run: d.run, actionId: frame.actionId, attemptId: frame.attemptId }
      identity = canonicalJsonDigest({ owner, attemptRef })
      const fingerprint = canonicalJsonDigest({
        input: request.value,
        principal: context.call.principalRef,
        requestIdentity: frame.requestIdentity,
      })
      if (frame.requestIdentity && frame.requestIdentity.requestDigest !== frame.inputDigest)
        return embeddingFailure('invalid_input', 'request_identity')
      const prior = journal.inspect(identity, fingerprint)
      if (busy.has(identity)) return embeddingFailure('unknown_effect', 'effect_unknown')
      if (prior?.result) {
        if (prior.result.outcome !== 'succeeded' || prior.result.result?.kind !== 'inline')
          return prior.result
        const cached = validateRuntime('EmbeddingEncodeResult', prior.result.result.value)
        if (
          cached.ok &&
          (await readEmbeddingVectors(cached.value.vectorsRef, request.value, context.call, d.blobRead)).ok
        ) {
          if (context.call.signal.aborted) return embeddingFailure('cancelled', 'cancelled')
          if (!(await interruptible(d.authorize(context.call), context.call.signal)))
            return embeddingFailure('denied', 'permission_absent')
          return prior.result
        }
        const rejected = embeddingFailure('invalid_input', 'embedding_vectors')
        rejected.error.safeDetail = prior.result.result
        return rejected
      }
      if (prior && !prior.delivery) return embeddingFailure('unknown_effect', 'effect_unknown')
      if (d.usage?.binding.contract !== 'agh.usage')
        return embeddingFailure(
          prior ? 'unknown_effect' : 'incompatible',
          prior ? 'usage_unconfirmed' : 'usage_port_unavailable',
        )
      if (
        d.fixture?.kind !== 'restricted-effects' ||
        d.fixture.inputDigest !== frame.inputDigest ||
        request.value.modelRoute.credentialBinding !== null ||
        !request.value.modelRoute.model.startsWith('synthetic-') ||
        request.value.modelRoute.credentialAudience !== 'synthetic-fixture' ||
        d.fixture.request.target.host !== '127.0.0.1' ||
        d.fixture.request.target.scheme !== 'http' ||
        d.fixture.request.target.targetId !== request.value.modelRoute.endpointRef
      )
        return embeddingFailure('incompatible', 'model_gateway_unavailable')
      if (
        !validateRuntime('NetworkRequest', d.fixture.request).ok ||
        !validateRuntime('UsageMeasurement', d.fixture.measurement).ok
      )
        return embeddingFailure('invalid_input', 'fixture_schema')
      busy.add(identity)
      ownsBusy = true
      let delivery = prior?.delivery
      if (!delivery) {
        if (prior || lookupOnly) return embeddingFailure('unknown_effect', 'effect_unknown')
        if (!journal.claim(identity, fingerprint)) {
          journal.inspect(identity, fingerprint)
          return embeddingFailure('unknown_effect', 'effect_unknown')
        }
        entered = true
        const response = await interruptible(
          context.effects.invoke(
            {
              operation: 'agh.network.request',
              input: embeddingRef(RuntimeMethodSchemaRefs['agh.network'].request.input, d.fixture.request),
            },
            context.call,
          ),
          context.call.signal,
        )
        if (!response.ok) return embeddingFailure('unknown_effect', 'effect_unknown')
        const raw = await embeddingData(
          response.value,
          RuntimeMethodSchemaRefs['agh.network'].request.output,
          context.call,
          d.blobRead,
        )
        const network = validateRuntime('NetworkRequestResult', raw)
        if (!network.ok || network.value.status < 200 || network.value.status >= 300)
          return embeddingFailure('unknown_effect', 'effect_unknown')
        const receipt = network.value.receipt ?? response.value
        delivery = {
          vectorsRef: {
            kind: 'blob',
            schema: RuntimeSchemaRefs.EmbeddingVectors,
            blob: network.value.bodyRef,
          },
          usage: {
            attemptRef,
            externalReceiptRef: receipt,
            measurement: { ...d.fixture.measurement, sourceReceipt: receipt },
          },
        }
        journal.delivered(identity, delivery)
      }
      entered = true
      const recorded = await interruptible(
        d.usage.control(
          {
            target: d.usage.binding,
            method: 'record',
            input: embeddingRef(RuntimeMethodSchemaRefs['agh.usage'].record.input, delivery.usage),
          },
          context.call,
        ),
        context.call.signal,
      )
      const rawUsage = recorded.ok
        ? await embeddingData(
            recorded.value,
            RuntimeMethodSchemaRefs['agh.usage'].record.output,
            context.call,
            d.blobRead,
          )
        : undefined
      const parsedUsage = validateRuntime('UsageRecordResult', rawUsage)
      const usage: Outcome<W.UsageRecordResult> = !recorded.ok
        ? recorded
        : parsedUsage.ok
          ? { ok: true, value: parsedUsage.value }
          : { ok: false, error: embeddingFailure('unknown_effect', 'usage_unconfirmed').error }
      if (!usage.ok && usage.error.code === 'conflict')
        return embeddingFailure('conflict', 'idempotency_conflict')
      if (
        !usage.ok ||
        !validateRuntime('UsageRecordResult', usage.value).ok ||
        usage.value.factRefs.length === 0
      )
        return embeddingFailure('unknown_effect', 'usage_unconfirmed')
      const vectors = await readEmbeddingVectors(delivery.vectorsRef, request.value, context.call, d.blobRead)
      if (context.call.signal.aborted) return embeddingFailure('unknown_effect', 'effect_unknown')
      if (!(await interruptible(d.authorize(context.call), context.call.signal))) {
        const denied = embeddingFailure('denied', 'permission_absent')
        denied.error.safeDetail = embeddingRef(
          RuntimeMethodSchemaRefs['agh.usage'].record.output,
          usage.value,
        )
        return denied
      }
      let result: W.EffectResult
      if (!vectors.ok) {
        const invalid = embeddingFailure('invalid_input', 'embedding_vectors')
        invalid.error.safeDetail = embeddingRef(
          RuntimeMethodSchemaRefs['agh.usage'].record.output,
          usage.value,
        )
        result = invalid
      } else {
        result = {
          outcome: 'succeeded',
          result: embeddingRef(RuntimeMethodSchemaRefs['agh.embedding'].encode.output, {
            vectorsRef: delivery.vectorsRef,
            dimensions: request.value.dimensions,
            inputDigest: frame.inputDigest,
            usageRefs: usage.value.factRefs,
          } satisfies W.EmbeddingEncodeResult),
          externalRequests: [],
          usage: [],
          references: [],
        }
      }
      const blob = delivery.vectorsRef.kind === 'blob' ? delivery.vectorsRef.blob : null
      if (blob)
        result.references.push({
          kind: 'blob',
          authorityId: blob.authorityId,
          resourceId: blob.blobId,
          version: '1',
          digest: blob.digest,
          pinId: blob.pinId,
        })
      if (delivery.usage.externalReceiptRef?.kind === 'blob') {
        const r = delivery.usage.externalReceiptRef.blob
        result.references.push({
          kind: 'blob',
          authorityId: r.authorityId,
          resourceId: r.blobId,
          version: '1',
          digest: r.digest,
          pinId: r.pinId,
        })
      }
      journal.complete(identity, result)
      return result
    } catch (error) {
      return embeddingFailure(
        error instanceof EmbeddingConflict
          ? 'conflict'
          : entered
            ? 'unknown_effect'
            : context.call.signal.aborted
              ? 'cancelled'
              : 'invalid_input',
        error instanceof EmbeddingConflict
          ? 'idempotency_conflict'
          : entered
            ? 'effect_unknown'
            : 'input_schema',
      )
    } finally {
      if (ownsBusy) busy.delete(identity)
    }
  }
  return {
    ...lifecycle,
    actions: {
      encode: {
        kind: 'leaf',
        recovery: 'R2',
        stateCodec: null,
        async create(scope) {
          const handlerLifetime = new AbortController()
          let stopped = false
          const tasks = new Map<string, Promise<W.EffectResult>>()
          async function execute(frame: W.ActionFrame, ctx: ActionContext, lookupOnly: boolean) {
            if (stopped || scope.signal.aborted) return embeddingFailure('denied', 'blocked')
            if (active.has(ctx.call.invocationId)) return embeddingFailure('conflict', 'invocation_busy')
            const timer = new AbortController()
            const timeout = setTimeout(
              () => timer.abort(),
              Math.max(0, Math.min(2147483647, Date.parse(ctx.call.deadline) - Date.now())),
            )
            const call = {
              ...ctx.call,
              signal: AbortSignal.any([
                ctx.call.signal,
                scope.signal,
                factory.signal,
                lifetime.signal,
                handlerLifetime.signal,
                timer.signal,
              ]),
            }
            const task = run(frame, { ...ctx, call }, scope, lookupOnly)
            active.set(ctx.call.invocationId, task)
            tasks.set(ctx.call.invocationId, task)
            try {
              return await task
            } finally {
              clearTimeout(timeout)
              active.delete(ctx.call.invocationId)
              tasks.delete(ctx.call.invocationId)
            }
          }
          return {
            ...lifecycle,
            ready: async (call) =>
              stopped || scope.signal.aborted
                ? { ok: false, error: embeddingFailure('denied', 'blocked').error }
                : admitted(call),
            health: async (call) =>
              stopped || scope.signal.aborted
                ? { ok: false, error: embeddingFailure('denied', 'blocked').error }
                : lifecycle.health(call),
            kind: 'leaf',
            effectSemantics: 'receipt-query',
            executionUnit: 'single-effect',
            async close() {
              stopped = true
              handlerLifetime.abort()
              await Promise.allSettled([...tasks.values()])
            },
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
            execute: (frame, ctx) => execute(frame, ctx, false),
            async reconcile(frame, _evidence, ctx): Promise<W.ReconcileResult> {
              const result = await execute(frame, ctx, true)
              const evidence =
                result.result ??
                embeddingRef(RuntimeSchemaRefs.StandardToolOutput, {
                  content: [],
                  structured: { outcome: result.outcome },
                })
              return result.outcome === 'succeeded'
                ? { kind: 'resolved', result, evidence }
                : { kind: 'unknown', evidence, reason: 'Embedding effect remains unconfirmed' }
            },
          }
        },
      },
    },
  }
}
