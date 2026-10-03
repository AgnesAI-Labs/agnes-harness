import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ActionContext,
  BlobReadPort,
  CallContext,
  LeafActionProvider,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { createRestrictedEffectsFixture } from '@agnes/extension-api/testkit'
import { jcs } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, RuntimeSchemaRefs } from '@agnes/protocol/runtime'
import { embeddingFailure, embeddingRef } from '../../src/runtime/embedding/data.js'
import { createEmbeddingFactory, type EmbeddingDeployment } from '../../src/runtime/providers/embedding.js'
import { createEmbeddingUsage, embeddingUsageBinding } from './embedding-usage.js'

export const embeddingScope: W.ScopeRef = {
  kind: 'workspace',
  installationId: 'synthetic-install',
  runtimeId: 'synthetic-runtime',
  workspaceId: 'synthetic-workspace',
}
export const embeddingRun: W.RunRef = {
  runId: 'synthetic-run',
  session: {
    sessionId: 'synthetic-session',
    authority: { authorityId: 'synthetic-state', tenantId: 'synthetic-tenant', authorityEpoch: 1 },
  },
}
export const embeddingConfig: W.SchemaRef = {
  typeId: 'synthetic/embedding-config@1',
  revision: 1,
  digest: canonicalJsonDigest({}),
}
export const embeddingInput: W.EmbeddingEncodeRequest = {
  dimensions: 2,
  normalize: true,
  inputRefs: [
    embeddingRef(embeddingConfig, { text: 'synthetic-first' }),
    embeddingRef(embeddingConfig, { text: 'synthetic-second' }),
  ],
  modelRoute: {
    routeId: 'synthetic-route',
    routeRevision: 1,
    model: 'synthetic-embedding',
    endpointRef: 'synthetic-endpoint',
    catalogRevision: 1,
    priceVersion: 'synthetic-price',
    credentialAudience: 'synthetic-fixture',
    credentialBinding: null,
    adapter: {
      contract: 'agh.model-adapter',
      logicalName: 'synthetic',
      bindingId: 'synthetic-adapter',
      providerId: 'synthetic/adapter',
    },
    features: { input: ['text'], output: [], tools: false, streaming: false, structuredOutput: false },
  },
}
export type EmbeddingFixtureOptions = {
  directory: string
  kind: 'default' | 'reference'
  matrix?: unknown
  input?: W.EmbeddingEncodeRequest
  production?: boolean
  noUsage?: boolean
  hang?: boolean
  usageFail?: boolean
  crashAfterUsage?: boolean
  corruptBlob?: boolean
  allowOtherPrincipal?: boolean
}
export function embeddingProviderDigest(kind: 'default' | 'reference'): string {
  const paths =
    kind === 'default'
      ? [
          new URL('../../src/runtime/providers/embedding.ts', import.meta.url),
          new URL('../../src/runtime/embedding/data.ts', import.meta.url),
          new URL('../../src/runtime/embedding/journal.ts', import.meta.url),
        ]
      : [new URL('../../../../examples/runtime-reference/src/providers/embedding.ts', import.meta.url)]
  const hash = createHash('sha256')
  for (const path of paths) hash.update(readFileSync(path))
  return hash.digest('hex')
}
export async function createEmbeddingConsumer(opts: EmbeddingFixtureOptions) {
  mkdirSync(opts.directory, { recursive: true, mode: 0o700 })
  let revoked = false
  const input = opts.input ?? embeddingInput,
    bindingId = 'synthetic-embedding-binding',
    lifetime = new AbortController()
  const effects = createRestrictedEffectsFixture(),
    calls = new Map<string, AbortController>()
  const content = join(opts.directory, 'content'),
    deliveriesFile = join(opts.directory, 'deliveries.jsonl')
  mkdirSync(content, { recursive: true, mode: 0o700 })
  if (!existsSync(deliveriesFile)) writeFileSync(deliveriesFile, '', { mode: 0o600 })
  const attempts = new Map<string, W.AttemptRef>()
  const usageOwner = await createEmbeddingUsage(
    opts.directory,
    embeddingScope,
    (call) =>
      !revoked &&
      call.authorizationRef === 'synthetic-auth' &&
      (call.principalRef === 'synthetic-principal' ||
        (opts.allowOtherPrincipal === true && call.principalRef === 'synthetic-other-principal')),
  )
  const retain = (bytes: Uint8Array): W.BytesRef => {
    const digest = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(join(content, digest), bytes, { mode: 0o600 })
    return {
      authorityId: 'synthetic-blob',
      blobId: digest,
      digest,
      bytes: bytes.byteLength,
      mediaType: 'application/json',
      pinId: 'synthetic-pin',
    }
  }
  const blobRead: BlobReadPort = {
    async readRange(request) {
      const bytes = new Uint8Array(readFileSync(join(content, request.ref.blobId)))
      if (opts.corruptBlob) bytes[0] = 0
      return {
        ok: true,
        value: { bytes, offset: 0, totalBytes: bytes.byteLength, digest: request.ref.digest },
      }
    },
    async openRead() {
      return { ok: false, error: embeddingFailure('incompatible', 'fixture_range_only').error }
    },
  }
  const syntheticTarget: W.NetworkTarget = {
    targetId: 'synthetic-endpoint',
    scheme: 'http',
    host: '127.0.0.1',
    port: 1,
    path: '/synthetic-embedding',
  }
  const request: W.NetworkRequest = {
    target: syntheticTarget,
    method: 'POST',
    bodyRef: retain(Buffer.from(jcs(input))),
    headers: embeddingRef(RuntimeSchemaRefs.ControlledHttpHeaders, {}),
    maxBytes: 1048576,
    redirect: { mode: 'deny', maxHops: 0 },
  }
  effects.allow({
    port: 'invoke',
    operation: 'agh.network.request',
    async handle(operation, call) {
      if (operation.input.kind !== 'inline' || jcs(operation.input.value) !== jcs(request))
        return { ok: false, error: embeddingFailure('denied', 'fixture_request').error }
      appendFileSync(deliveriesFile, `${JSON.stringify({ digest: canonicalJsonDigest(input) })}\n`, {
        flush: true,
      })
      if (opts.hang) {
        await new Promise<void>((_, reject) => {
          const abort = () => reject(Error('fixture cancellation'))
          call.signal.addEventListener('abort', abort, { once: true })
          if (call.signal.aborted) abort()
        })
      }
      const bodyRef = retain(
        Buffer.from(
          JSON.stringify(
            opts.matrix ?? [
              [1, 0],
              [0, 1],
            ],
          ),
        ),
      )
      const response: W.NetworkRequestResult = {
        bodyRef,
        headersRef: embeddingRef(RuntimeSchemaRefs.ControlledHttpHeaders, {}),
        receipt: embeddingRef(RuntimeSchemaRefs.StandardToolOutput, {
          content: [],
          structured: { receipt: 'synthetic-receipt', inputDigest: canonicalJsonDigest(input) },
        }),
        status: 200,
        finalTarget: syntheticTarget,
      }
      const attempt = attempts.get(call.invocationId)
      if (!attempt) throw Error('Trusted attempt absent')
      usageOwner.observe({
        request: {
          attemptRef: attempt,
          externalReceiptRef: response.receipt,
          measurement: {
            kind: 'reported',
            source: 'provider-receipt',
            actualModel: 'synthetic-embedding',
            sourceReceipt: response.receipt,
            replacesFactIds: [],
            quantities: [{ unit: 'synthetic-request', value: '1' }],
          },
        },
        externalRequest: {
          system: 'synthetic-network',
          requestId: canonicalJsonDigest({ attempt, receipt: response.receipt }),
          requestDigest: canonicalJsonDigest(request),
        },
        scope: call.scope,
      })
      return {
        ok: true,
        value: embeddingRef(RuntimeMethodSchemaRefs['agh.network'].request.output, response),
      }
    },
  })
  const records = <T>(path: string): T[] =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((s) => JSON.parse(s) as T)
  const usage: NonNullable<EmbeddingDeployment['usage']> = {
    binding: embeddingUsageBinding,
    async control(operation, call) {
      if (opts.usageFail)
        return { ok: false, error: embeddingFailure('incompatible', 'synthetic_usage_unavailable').error }
      const result = await usageOwner.provider.control(operation, {
        ...call,
        bindingId: embeddingUsageBinding.bindingId,
      })
      if (result.ok && opts.crashAfterUsage) process.kill(process.pid, 'SIGKILL')
      return result
    },
  }
  const deployment: EmbeddingDeployment = {
    path: join(opts.directory, opts.kind === 'default' ? 'journal.sqlite' : 'reference-journal'),
    packageDigest: embeddingProviderDigest(opts.kind),
    configSchema: embeddingConfig,
    run: embeddingRun,
    blobRead,
    async authorize(call) {
      return (
        !revoked &&
        call.authorizationRef === 'synthetic-auth' &&
        (call.principalRef === 'synthetic-principal' ||
          (opts.allowOtherPrincipal === true && call.principalRef === 'synthetic-other-principal'))
      )
    },
    ...(opts.noUsage ? {} : { usage }),
    ...(opts.production
      ? {}
      : {
          fixture: {
            kind: 'restricted-effects' as const,
            inputDigest: canonicalJsonDigest(input),
            request,
            measurement: {
              kind: 'reported' as const,
              source: 'provider-receipt' as const,
              actualModel: 'synthetic-embedding',
              sourceReceipt: null,
              replacesFactIds: [],
              quantities: [{ unit: 'synthetic-request', value: '1' }],
            },
          },
        }),
  }
  let factory: ProviderFactory<ServiceProvider>
  if (opts.kind === 'default') factory = createEmbeddingFactory(deployment)
  else {
    const file = new URL('../../../../examples/runtime-reference/src/providers/embedding.ts', import.meta.url)
      .href
    const module = (await import(file)) as { createReferenceEmbeddingFactory: typeof createEmbeddingFactory }
    factory = module.createReferenceEmbeddingFactory(deployment)
  }
  const dependencies = {
    get: () => ({ ok: false as const, error: embeddingFailure('incompatible', 'fixture_dependency').error }),
    openScope: async () => ({
      ok: false as const,
      error: embeddingFailure('incompatible', 'fixture_dependency').error,
    }),
    close: async () => {},
  }
  const provider = await factory.create(embeddingRef(embeddingConfig, {}), dependencies, {
    instanceId: 'synthetic-instance',
    bindingId,
    scope: embeddingScope,
    signal: lifetime.signal,
  })
  const leafs = new Set<LeafActionProvider>()
  function call(mode?: string): CallContext {
    const controller = new AbortController(),
      invocationId = randomUUID()
    if (mode === 'cancel') controller.abort()
    calls.set(invocationId, controller)
    return {
      bindingId,
      invocationId,
      scope: embeddingScope,
      principalRef: mode === 'other-principal' ? 'synthetic-other-principal' : 'synthetic-principal',
      authorizationRef: mode === 'deny' || revoked ? 'untrusted' : 'synthetic-auth',
      traceRef: 'synthetic-trace',
      deadline: new Date(Date.now() + 10000).toISOString(),
      signal: controller.signal,
    }
  }
  async function encode(
    value: W.EmbeddingEncodeRequest = input,
    mode?: string,
    overrides: Partial<W.ActionFrame> = {},
    reconcile = false,
  ): Promise<W.EffectResult | W.ReconcileResult> {
    const ctx = call(mode),
      { signal: _signal, ...wire } = ctx
    const encoded = embeddingRef(RuntimeMethodSchemaRefs['agh.embedding'].encode.input, value)
    if (encoded.kind !== 'inline') throw Error('fixture inline input')
    const page = { items: [], snapshot: 'synthetic-snapshot', nextCursor: null, complete: true }
    const frame: W.ActionFrame = {
      actionId: 'synthetic-action',
      parentActionId: null,
      runId: embeddingRun.runId,
      bindingId,
      method: 'encode',
      input: encoded,
      inputDigest: encoded.digest,
      attemptId: 'synthetic-attempt',
      attemptNumber: 1,
      invocationId: ctx.invocationId,
      requestIdentity: null,
      providerRevision: 1,
      continuation: null,
      signals: page,
      receipts: page,
      signalHighWater: 0,
      snapshot: 'synthetic-snapshot',
      observedAt: '2026-10-04T00:00:00Z',
      context: wire,
      actionTimebox: { defaultTimeoutMs: 10000, maxDeadline: ctx.deadline },
      ...overrides,
    }
    attempts.set(ctx.invocationId, {
      run: embeddingRun,
      actionId: frame.actionId,
      attemptId: frame.attemptId,
    })
    const leaf = await provider.actions?.encode?.create({
      instanceId: 'synthetic-instance',
      actionId: frame.actionId,
      runId: frame.runId,
      bindingId,
      scope: embeddingScope,
      signal: lifetime.signal,
    })
    if (leaf?.kind !== 'leaf') throw Error('fixture leaf absent')
    leafs.add(leaf)
    const actionContext: ActionContext = {
      call: ctx,
      effects: effects.ports,
      progress: async () => ({
        ok: false,
        error: embeddingFailure('incompatible', 'fixture_progress').error,
      }),
    }
    try {
      return reconcile
        ? await leaf.reconcile(frame, [], actionContext)
        : await leaf.execute(frame, actionContext)
    } finally {
      calls.delete(ctx.invocationId)
      attempts.delete(ctx.invocationId)
      await leaf.close('completed')
      leafs.delete(leaf)
    }
  }
  return {
    provider,
    descriptor: factory.descriptor,
    blobRead,
    effects,
    encode,
    deliveries: () => records(deliveriesFile).length,
    usages: () => usageOwner.records(),
    cancel() {
      for (const c of calls.values()) c.abort()
    },
    revoke() {
      revoked = true
    },
    async stop() {
      await provider.close('shutdown')
    },
    async close() {
      lifetime.abort()
      for (const l of leafs) await l.close('shutdown')
      await provider.close('shutdown')
      await usageOwner.provider.close('shutdown')
    },
  }
}
