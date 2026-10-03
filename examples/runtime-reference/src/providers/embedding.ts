import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ActionContext,
  BlobReadPort,
  CallContext,
  MethodHandler,
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

type Fixture = {
  kind: 'restricted-effects'
  inputDigest: string
  request: W.NetworkRequest
  measurement: W.UsageMeasurement
}
type Options = {
  path: string
  packageDigest: string
  configSchema: W.SchemaRef
  run: W.RunRef
  authorize(call: CallContext): Promise<boolean>
  blobRead?: BlobReadPort
  usage?: { binding: W.BindingRef; control: MethodHandler }
  fixture?: Fixture
}
type LogRecord = {
  fingerprint: string
  response?: W.NetworkRequestResult
  usageRequest?: W.UsageRecordRequest
  terminal?: W.EffectResult
}
function pack(schema: W.SchemaRef, payload: unknown): W.DataRef {
  const bounded = boundedCanonicalJson(payload, { maxDepth: 32, maxMembers: 10000, maxBytes: 65536 })
  if (!bounded.ok) throw Error('Reference data limit')
  const value = bounded.value.json
  return {
    schema,
    kind: 'inline',
    value,
    bytes: Buffer.byteLength(jcs(value)),
    digest: canonicalJsonDigest(value),
  }
}
function reject(
  code: W.RuntimeError['code'],
  detailCode: string,
): W.EffectResult & { error: W.RuntimeError } {
  return {
    externalRequests: [],
    usage: [],
    references: [],
    error: {
      message: 'Embedding request refused',
      code,
      detailCode,
      diagnosticId: 'embedding',
      retryAdvice: { kind: 'never' },
    },
    outcome:
      ({ unknown_effect: 'unknown_effect', cancelled: 'cancelled' } as const)[
        code as 'unknown_effect' | 'cancelled'
      ] ?? 'failed',
  }
}
async function boundedWait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: (() => void) | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, fail) => {
        listener = () => fail(Error('Reference invocation interrupted'))
        signal.addEventListener('abort', listener, { once: true })
        if (signal.aborted) listener()
      }),
    ])
  } finally {
    if (listener) signal.removeEventListener('abort', listener)
  }
}
async function unpack(
  options: Options,
  ref: W.DataRef,
  expected: W.SchemaRef,
  call: CallContext,
): Promise<W.JsonValue> {
  if (
    !validateRuntime('DataRef', ref).ok ||
    canonicalJsonDigest(ref.schema) !== canonicalJsonDigest(expected)
  )
    throw Error('Reference schema mismatch')
  if (ref.kind === 'inline') {
    const parsed = boundedCanonicalJson(ref.value, { maxDepth: 32, maxMembers: 10000, maxBytes: 65536 })
    if (
      !parsed.ok ||
      canonicalJsonDigest(parsed.value.json) !== ref.digest ||
      Buffer.byteLength(jcs(parsed.value.json)) !== ref.bytes
    )
      throw Error('Reference inline digest mismatch')
    return parsed.value.json
  }
  const size = ref.blob.bytes
  if (!options.blobRead || size === 0 || size > 1048576) throw Error('Reference blob limit')
  const bytes = await boundedWait(
    options.blobRead.readRange({ length: size, offset: 0, ref: ref.blob }, call),
    call.signal,
  )
  if (!bytes.ok) throw Error('Reference blob denied')
  if (
    bytes.value.totalBytes !== size ||
    bytes.value.offset !== 0 ||
    bytes.value.bytes.byteLength !== size ||
    bytes.value.digest !== ref.blob.digest ||
    createHash('sha256').update(bytes.value.bytes).digest('hex') !== ref.blob.digest
  )
    throw Error('Reference blob digest mismatch')
  const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.value.bytes))
  const parsed = boundedCanonicalJson(decoded, { maxDepth: 32, maxMembers: 1000000, maxBytes: 1048576 })
  if (!parsed.ok) throw Error('Reference decoded blob limit')
  return parsed.value.json
}
/** Independent append-log implementation. Synthetic fixtures never qualify a live model deployment. */
export function createReferenceEmbeddingFactory(options: Options): ProviderFactory<ServiceProvider> {
  const opts = {
    ...options,
    run: structuredClone(options.run),
    configSchema: structuredClone(options.configSchema),
    ...(options.fixture ? { fixture: structuredClone(options.fixture) } : {}),
  }
  const method = RuntimeMethodSchemaRefs['agh.embedding'].encode
  const descriptor: W.ProviderDescriptor = {
    contract: 'agh.embedding',
    providerId: 'agh.reference/embedding',
    packageVersion: '0.0.0',
    logicalName: 'default',
    major: 1,
    scope: 'workspace',
    packageDigest: opts.packageDigest,
    configSchema: opts.configSchema,
    capabilities: [],
    requires: [],
    features: [],
    stateCodecs: [],
    recovery: 'R2',
    activationMode: 'eager',
    isolation: ['trusted-in-process'],
    operations: [
      {
        kind: 'action',
        method: 'encode',
        retrySafety: 'reconcile-first',
        requiredCapabilities: [],
        outputSchema: method.output,
        inputSchema: method.input,
      },
    ],
  }
  return {
    descriptor,
    async create(config, _deps, root) {
      if (
        config.kind !== 'inline' ||
        !validateRuntime('DataRef', config).ok ||
        jcs(config.schema) !== jcs(opts.configSchema) ||
        jcs(config.value) !== '{}' ||
        config.digest !== canonicalJsonDigest({}) ||
        config.bytes !== 2
      )
        throw Error('Reference configuration')
      mkdirSync(opts.path, { mode: 0o700, recursive: true })
      const stopping = new AbortController(),
        work = new Map<string, Promise<W.EffectResult>>(),
        owners = new Set<string>()
      let phase: 'open' | 'draining' | 'closed' = 'open'
      async function permit(ctx: CallContext): Promise<Outcome<void>> {
        const error = (code: W.RuntimeError['code'], detail: string): Outcome<never> => ({
          ok: false,
          error: reject(code, detail).error,
        })
        if (phase !== 'open') return error('denied', 'blocked')
        if (ctx.signal.aborted || root.signal.aborted) return error('cancelled', 'cancelled')
        if (
          ctx.bindingId !== root.bindingId ||
          canonicalJsonDigest(ctx.scope) !== canonicalJsonDigest(root.scope)
        )
          return error('denied', 'permission_absent')
        if (!(await boundedWait(opts.authorize(ctx), ctx.signal))) return error('denied', 'permission_absent')
        if (!(Date.parse(ctx.deadline) > Date.now())) return error('timeout', 'deadline')
        return { ok: true, value: undefined }
      }
      const recoverRecord = (folder: string): LogRecord | null => {
        if (!existsSync(folder)) return null
        const file = join(folder, 'delivery.jsonl')
        if (!existsSync(file)) throw Error('Incomplete reference claim')
        const lines = readFileSync(file, 'utf8').split('\n')
        if (lines.pop() !== '' || !lines.length) throw Error('Incomplete reference log')
        let state: LogRecord | null = null
        for (const line of lines) {
          const next = JSON.parse(line) as LogRecord
          if (
            !/^[a-f0-9]{64}$/u.test(next.fingerprint) ||
            (next.response && !validateRuntime('NetworkRequestResult', next.response).ok) ||
            (next.usageRequest && !validateRuntime('UsageRecordRequest', next.usageRequest).ok) ||
            (next.terminal && !validateRuntime('EffectResult', next.terminal).ok)
          )
            throw Error('Invalid reference log')
          if (state && state.fingerprint !== next.fingerprint) throw Error('Corrupt reference history')
          state = next
        }
        return state
      }
      const append = (folder: string, record: LogRecord) =>
        appendFileSync(join(folder, 'delivery.jsonl'), `${JSON.stringify(record)}\n`, {
          mode: 0o600,
          flush: true,
        })
      const pendingOwners = (): string[] => {
        return readdirSync(opts.path).filter((name) => {
          if (!/^[a-f0-9]{64}$/u.test(name)) return false
          try {
            return !recoverRecord(join(opts.path, name))?.terminal
          } catch {
            return true
          }
        })
      }
      async function finish(
        frame: W.ActionFrame,
        invocation: ActionContext,
        scope: import('@agnes/extension-api/runtime').ActionHandlerScope,
        recover: boolean,
      ): Promise<W.EffectResult> {
        const ctx = invocation.call
        let owns = false,
          key = '',
          dispatched = false
        try {
          frame = structuredClone(frame)
          const authorization = await permit(ctx)
          if (!authorization.ok) return reject(authorization.error.code, authorization.error.detailCode)
          const { signal: _abort, ...wireCall } = ctx
          const structural = validateRuntime('ActionFrame', frame)
          if (
            !structural.ok ||
            frame.method !== 'encode' ||
            frame.actionId !== scope.actionId ||
            frame.runId !== opts.run.runId ||
            frame.runId !== scope.runId ||
            scope.instanceId !== root.instanceId ||
            frame.bindingId !== root.bindingId ||
            scope.bindingId !== root.bindingId ||
            canonicalJsonDigest(scope.scope) !== canonicalJsonDigest(root.scope) ||
            ctx.invocationId !== frame.invocationId ||
            jcs(wireCall) !== jcs(frame.context) ||
            frame.input.kind !== 'inline' ||
            frame.input.digest !== frame.inputDigest
          )
            return reject('invalid_input', 'input_schema')
          const decoded = await unpack(opts, frame.input, method.input, ctx)
          const schema = validateRuntime('EmbeddingEncodeRequest', decoded)
          if (!schema.ok || schema.value.dimensions === 0 || schema.value.dimensions > 10000)
            return reject('invalid_input', 'embedding_dimensions')
          if (frame.requestIdentity && frame.requestIdentity.requestDigest !== frame.inputDigest)
            return reject('invalid_input', 'request_identity')
          const attempt: W.AttemptRef = {
            actionId: frame.actionId,
            attemptId: frame.attemptId,
            run: opts.run,
          }
          key = canonicalJsonDigest({
            owner: { scope: ctx.scope },
            attemptRef: attempt,
          })
          const fingerprint = canonicalJsonDigest({
              input: schema.value,
              principal: ctx.principalRef,
              requestIdentity: frame.requestIdentity,
            }),
            folder = join(opts.path, key)
          const old = recoverRecord(folder)
          if (old && old.fingerprint !== fingerprint) return reject('conflict', 'idempotency_conflict')
          if (owners.has(key)) return reject('unknown_effect', 'effect_unknown')
          if (old?.terminal) {
            if (old.terminal.outcome !== 'succeeded' || old.terminal.result?.kind !== 'inline')
              return old.terminal
            const output = validateRuntime('EmbeddingEncodeResult', old.terminal.result.value)
            try {
              if (!output.ok) throw Error('Reference cached result')
              const recovered = await unpack(
                opts,
                output.value.vectorsRef,
                RuntimeSchemaRefs.EmbeddingVectors,
                ctx,
              )
              const vectors = validateRuntime('EmbeddingVectors', recovered)
              if (
                !vectors.ok ||
                vectors.value.length !== schema.value.inputRefs.length ||
                vectors.value.some(
                  (row) =>
                    row.length !== schema.value.dimensions ||
                    Array.from(row).some((n) => !Number.isFinite(n)) ||
                    (schema.value.normalize && Math.abs(Math.hypot(...row) - 1) > 1e-6),
                )
              )
                throw Error('Reference cached vectors')
              if (ctx.signal.aborted) return reject('cancelled', 'cancelled')
              if (!(await boundedWait(opts.authorize(ctx), ctx.signal)))
                return reject('denied', 'permission_absent')
              return old.terminal
            } catch {
              const invalid = reject('invalid_input', 'embedding_vectors')
              invalid.error.safeDetail = old.terminal.result
              return invalid
            }
          }
          if (old && !old.response) return reject('unknown_effect', 'effect_unknown')
          if (opts.usage?.binding.contract !== 'agh.usage')
            return reject(
              old ? 'unknown_effect' : 'incompatible',
              old ? 'usage_unconfirmed' : 'usage_port_unavailable',
            )
          const fixture = opts.fixture
          if (
            fixture?.kind !== 'restricted-effects' ||
            fixture.inputDigest !== frame.inputDigest ||
            schema.value.modelRoute.credentialBinding !== null ||
            !schema.value.modelRoute.model.startsWith('synthetic-') ||
            schema.value.modelRoute.credentialAudience !== 'synthetic-fixture' ||
            fixture.request.target.host !== '127.0.0.1' ||
            fixture.request.target.scheme !== 'http' ||
            fixture.request.target.targetId !== schema.value.modelRoute.endpointRef
          )
            return reject('incompatible', 'model_gateway_unavailable')
          if (
            !validateRuntime('NetworkRequest', fixture.request).ok ||
            !validateRuntime('UsageMeasurement', fixture.measurement).ok
          )
            return reject('invalid_input', 'fixture_schema')
          owners.add(key)
          owns = true
          let state = old
          if (!state?.response || !state.usageRequest) {
            if (state || recover) return reject('unknown_effect', 'effect_unknown')
            try {
              mkdirSync(folder, { mode: 0o700 })
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === 'EEXIST')
                return reject('unknown_effect', 'effect_unknown')
              throw e
            }
            state = { fingerprint }
            append(folder, state)
            dispatched = true
            const effect = await boundedWait(
              invocation.effects.invoke(
                {
                  input: pack(RuntimeMethodSchemaRefs['agh.network'].request.input, fixture.request),
                  operation: 'agh.network.request',
                },
                ctx,
              ),
              ctx.signal,
            )
            if (!effect.ok) return reject('unknown_effect', 'effect_unknown')
            const payload = await unpack(
              opts,
              effect.value,
              RuntimeMethodSchemaRefs['agh.network'].request.output,
              ctx,
            )
            const response = validateRuntime('NetworkRequestResult', payload)
            if (!response.ok || !(response.value.status >= 200 && response.value.status < 300))
              return reject('unknown_effect', 'effect_unknown')
            const source = response.value.receipt ?? effect.value
            state = {
              fingerprint,
              response: response.value,
              usageRequest: {
                attemptRef: attempt,
                externalReceiptRef: source,
                measurement: { ...fixture.measurement, sourceReceipt: source },
              },
            }
            append(folder, state)
          }
          dispatched = true
          if (!state.usageRequest || !state.response) return reject('unknown_effect', 'effect_unknown')
          const responseUsage = await boundedWait(
            opts.usage.control(
              {
                method: 'record',
                target: opts.usage.binding,
                input: pack(RuntimeMethodSchemaRefs['agh.usage'].record.input, state.usageRequest),
              },
              ctx,
            ),
            ctx.signal,
          )
          const parsedUsage = responseUsage.ok
            ? validateRuntime(
                'UsageRecordResult',
                await unpack(
                  opts,
                  responseUsage.value,
                  RuntimeMethodSchemaRefs['agh.usage'].record.output,
                  ctx,
                ),
              )
            : undefined
          const recorded: Outcome<W.UsageRecordResult> = !responseUsage.ok
            ? responseUsage
            : parsedUsage?.ok
              ? { ok: true, value: parsedUsage.value }
              : { ok: false, error: reject('unknown_effect', 'usage_unconfirmed').error }
          if (!recorded.ok && recorded.error.code === 'conflict')
            return reject('conflict', 'idempotency_conflict')
          if (
            !recorded.ok ||
            !validateRuntime('UsageRecordResult', recorded.value).ok ||
            !recorded.value.factRefs.length
          )
            return reject('unknown_effect', 'usage_unconfirmed')
          const vectorsRef: W.DataRef = {
            schema: RuntimeSchemaRefs.EmbeddingVectors,
            kind: 'blob',
            blob: state.response?.bodyRef,
          }
          let valid = false
          try {
            const candidate = await unpack(opts, vectorsRef, RuntimeSchemaRefs.EmbeddingVectors, ctx)
            const matrix = validateRuntime('EmbeddingVectors', candidate)
            valid = matrix.ok && matrix.value.length === schema.value.inputRefs.length
            if (matrix.ok)
              for (const row of matrix.value) {
                if (row.length !== schema.value.dimensions) valid = false
                let maximum = 0
                for (let i = 0; i < row.length; i++) {
                  const component = row[i]
                  if (typeof component !== 'number' || !Number.isFinite(component)) valid = false
                  else maximum = Math.max(maximum, Math.abs(component))
                }
                if (schema.value.normalize) {
                  const norm =
                    maximum === 0
                      ? 0
                      : maximum * Math.sqrt(row.reduce((sum, n) => sum + (n / maximum) ** 2, 0))
                  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-6) valid = false
                }
              }
          } catch {
            valid = false
          }
          if (ctx.signal.aborted) return reject('unknown_effect', 'effect_unknown')
          if (!(await boundedWait(opts.authorize(ctx), ctx.signal))) {
            const refused = reject('denied', 'permission_absent')
            refused.error.safeDetail = pack(
              RuntimeMethodSchemaRefs['agh.usage'].record.output,
              recorded.value,
            )
            return refused
          }
          const terminal: W.EffectResult = valid
            ? {
                outcome: 'succeeded' as const,
                result: pack(method.output, {
                  inputDigest: frame.inputDigest,
                  dimensions: schema.value.dimensions,
                  vectorsRef,
                  usageRefs: recorded.value.factRefs,
                }),
                references: [],
                usage: [],
                externalRequests: [],
              }
            : reject('invalid_input', 'embedding_vectors')
          if (!valid && terminal.error)
            terminal.error.safeDetail = pack(
              RuntimeMethodSchemaRefs['agh.usage'].record.output,
              recorded.value,
            )
          const blob = vectorsRef.blob
          terminal.references.push({
            kind: 'blob',
            authorityId: blob.authorityId,
            resourceId: blob.blobId,
            version: '1',
            pinId: blob.pinId,
            digest: blob.digest,
          })
          const source = state.usageRequest?.externalReceiptRef
          if (source?.kind === 'blob')
            terminal.references.push({
              kind: 'blob',
              authorityId: source.blob.authorityId,
              resourceId: source.blob.blobId,
              version: '1',
              pinId: source.blob.pinId,
              digest: source.blob.digest,
            })
          append(folder, { ...state, terminal })
          return terminal
        } catch {
          return reject(
            dispatched ? 'unknown_effect' : ctx.signal.aborted ? 'cancelled' : 'invalid_input',
            dispatched ? 'effect_unknown' : 'input_schema',
          )
        } finally {
          if (owns) owners.delete(key)
        }
      }
      const lifecycle = {
        ready: permit,
        async health(call: CallContext): Promise<Outcome<W.Health>> {
          const p = await permit(call)
          return p.ok ? { ok: true, value: { status: 'ready', diagnosticIds: [] } } : p
        },
        async drain(): Promise<Outcome<W.DrainResult>> {
          phase = 'draining'
          return {
            ok: true,
            value: {
              activeInvocationIds: [...work.keys()],
              state: work.size || pendingOwners().length ? 'blocked' : 'drained',
              diagnosticIds: [],
              durableOwnerRefs: pendingOwners().map((id) => ({ kind: 'reconciliation' as const, id })),
            },
          }
        },
        async close() {
          phase = 'closed'
          stopping.abort()
          await Promise.allSettled([...work.values()])
        },
      }
      const service: ServiceProvider = {
        ...lifecycle,
        actions: {
          encode: {
            recovery: 'R2',
            kind: 'leaf',
            stateCodec: null,
            async create(scope) {
              const halted = new AbortController()
              const tasks = new Map<string, Promise<W.EffectResult>>()
              let available = true
              async function execute(
                frame: W.ActionFrame,
                invocation: ActionContext,
                recover: boolean,
              ): Promise<W.EffectResult> {
                if (!available || scope.signal.aborted) return reject('denied', 'blocked')
                if (work.has(invocation.call.invocationId)) return reject('conflict', 'invocation_busy')
                const expiry = new AbortController(),
                  timer = setTimeout(
                    () => expiry.abort(),
                    Math.max(0, Math.min(Date.parse(invocation.call.deadline) - Date.now(), 2147483647)),
                  )
                const signal = AbortSignal.any([
                  invocation.call.signal,
                  root.signal,
                  scope.signal,
                  stopping.signal,
                  halted.signal,
                  expiry.signal,
                ])
                const task = finish(
                  frame,
                  { ...invocation, call: { ...invocation.call, signal } },
                  scope,
                  recover,
                )
                work.set(invocation.call.invocationId, task)
                tasks.set(invocation.call.invocationId, task)
                try {
                  return await task
                } finally {
                  clearTimeout(timer)
                  work.delete(invocation.call.invocationId)
                  tasks.delete(invocation.call.invocationId)
                }
              }
              return {
                ...lifecycle,
                ready: async (call) =>
                  !available || scope.signal.aborted
                    ? { ok: false, error: reject('denied', 'blocked').error }
                    : permit(call),
                health: async (call) =>
                  !available || scope.signal.aborted
                    ? { ok: false, error: reject('denied', 'blocked').error }
                    : lifecycle.health(call),
                kind: 'leaf',
                executionUnit: 'single-effect',
                effectSemantics: 'receipt-query',
                async close() {
                  available = false
                  halted.abort()
                  await Promise.allSettled([...tasks.values()])
                },
                async drain(): Promise<Outcome<W.DrainResult>> {
                  available = false
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
                execute: (f, c) => execute(f, c, false),
                async reconcile(f, _proofs, c): Promise<W.ReconcileResult> {
                  const r = await execute(f, c, true)
                  const evidence =
                    r.result ??
                    pack(RuntimeSchemaRefs.StandardToolOutput, {
                      content: [],
                      structured: { outcome: r.outcome },
                    })
                  return r.outcome === 'succeeded'
                    ? { evidence, kind: 'resolved', result: r }
                    : { evidence, kind: 'unknown', reason: 'Embedding effect remains unconfirmed' }
                },
              }
            },
          },
        },
      }
      return service
    },
  }
}
