import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ActionContext,
  CallContext,
  EffectPorts,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { createReferenceBillingFactory } from '../../../../examples/runtime-reference/src/providers/billing.js'
import { createReferenceTraceFactory } from '../../../../examples/runtime-reference/src/providers/trace.js'
import type { BillingAccountingPorts } from '../../src/runtime/billing/accounting.js'
import { createBillingFactory } from '../../src/runtime/providers/billing.js'
import { createNetworkService } from '../../src/runtime/providers/network.js'
import { createTraceFactory } from '../../src/runtime/providers/trace.js'
import { inline, refused } from '../../src/runtime/trace/provider-support.js'
import { createAccountingChainFixture } from './billing-accounting-fixture.js'

export type BillingTraceFixtureOptions = {
  directory: string
  kind: 'default' | 'reference'
  service: 'billing' | 'trace'
  port: number
  path?: string
  level?: W.TelemetryConsent['level']
  capacity?: number
  crashAfterSend?: boolean
  accountingChain?: boolean
  crashBoundary?: 'usage' | 'budget' | 'intent' | 'callback'
  accounting?: BillingAccountingPorts | null
}
export function billingTraceProviderDigest(
  kind: 'default' | 'reference',
  service: 'billing' | 'trace',
): string {
  const directory =
    kind === 'default' ? 'packages/host/src/runtime/' : 'examples/runtime-reference/src/providers/'
  const names =
    kind === 'default'
      ? [
          `providers/${service}.ts`,
          'trace/provider-support.ts',
          service === 'trace' ? 'trace/export-queue.ts' : 'billing/settlement-outbox.ts',
          ...(service === 'billing' ? ['billing/accounting.ts'] : []),
        ]
      : [`${service}.ts`, 'billing-trace-runtime.ts']
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const hash = createHash('sha256')
  for (const name of names) {
    hash.update(name)
    hash.update(readFileSync(join(root, directory, name)))
  }
  return hash.digest('hex')
}
export const fixtureScope: W.ScopeRef = {
  kind: 'workspace',
  installationId: 'synthetic-install',
  runtimeId: 'synthetic-runtime',
  workspaceId: 'synthetic-workspace',
}
export const configSchema: W.SchemaRef = {
  typeId: 'synthetic/empty@1',
  revision: 1,
  digest: canonicalJsonDigest({ type: 'object', additionalProperties: false, properties: {} }),
}
export const attributesSchema: W.SchemaRef = {
  typeId: 'synthetic/trace-attributes@1',
  revision: 1,
  digest: canonicalJsonDigest({ type: 'object', properties: { label: { type: 'string' } } }),
}
export function syntheticConsent(level: W.TelemetryConsent['level'] = 'ANON'): W.TelemetryConsent {
  return {
    sessionId: 'synthetic-session',
    profileId: 'synthetic-profile',
    level,
    sourceDigest: canonicalJsonDigest({ level, source: 'synthetic-explicit-command' }),
    recordedAt: '2026-10-03T00:00:00.000Z',
    explicitFull: level === 'FULL',
    evidence: 'explicit-command',
  } as W.TelemetryConsent
}
export const traceInput: W.TraceRecordRequest = {
  batchId: 'synthetic-batch',
  spans: [
    {
      traceId: 'synthetic-trace',
      spanId: 'synthetic-span',
      parentSpanId: null,
      name: 'content alice@example.test',
      startedAt: '2026-10-03T00:00:00.000Z',
      endedAt: '2026-10-03T00:00:00.010Z',
      outcome: 'ok',
      attributes: inline(attributesSchema, { label: 'private business content' }),
    },
  ],
}
export function exportInput(level: W.TelemetryConsent['level'] = 'ANON'): W.TelemetryExportRequest {
  return {
    batchId: traceInput.batchId,
    kind: 'trace',
    body: inline(RuntimeMethodSchemaRefs['agh.trace'].record.input, traceInput),
    consent: syntheticConsent(level),
    targetRef: 'synthetic-endpoint',
    policyRef: {
      authorityId: 'synthetic-policy',
      recordId: 'synthetic-egress',
      recordRevision: 1,
      schema: configSchema,
      digest: canonicalJsonDigest({ approved: true }),
    },
  }
}
export const syntheticUsage: W.UsageFact = {
  usageId: 'synthetic-leaf',
  actionId: 'synthetic-action',
  attemptId: 'synthetic-attempt',
  originKey: canonicalJsonDigest({
    authorityId: 'synthetic-usage',
    actionId: 'synthetic-action',
    attemptId: 'synthetic-attempt',
    externalRequest: {
      system: 'synthetic-model',
      requestId: 'synthetic-receipt',
      requestDigest: canonicalJsonDigest({ input: 'synthetic' }),
    },
  }),
  source: {
    contract: 'agh.model',
    bindingId: 'synthetic-model-binding',
    logicalName: 'model',
    providerId: 'synthetic-model',
  },
  dimensions: inline(
    {
      typeId: 'synthetic/measurement@1',
      revision: 1,
      digest: canonicalJsonDigest({ source: 'synthetic-counter' }),
    },
    {
      kind: 'reported',
      quantities: [{ unit: 'request', value: '1' }],
      actualModel: 'synthetic-model',
      source: 'adapter-counter',
      sourceReceipt: null,
      replacesFactIds: [],
    },
  ),
  externalRequest: {
    system: 'synthetic-model',
    requestId: 'synthetic-receipt',
    requestDigest: canonicalJsonDigest({ input: 'synthetic' }),
  },
  observedAt: '2026-10-04T00:00:00.000Z',
  certainty: 'measured',
}
export const billingInput: W.BillingPostRequest = {
  chargeKey: 'synthetic-charge',
  accountRef: {
    authorityId: 'synthetic-account',
    id: 'synthetic-account',
    typeId: 'synthetic/account@1',
    revision: 1,
  },
  usageRefs: [
    {
      authorityId: 'synthetic-usage',
      usageId: 'synthetic-leaf',
      digest: canonicalJsonDigest(syntheticUsage),
    },
  ],
  quoteRef: inline(RuntimeMethodSchemaRefs['agh.pricing'].quote.output, {
    quoteId: 'synthetic-quote',
    priceVersion: 'synthetic-price-v1',
    inputDigest: canonicalJsonDigest({ usage: 'synthetic-leaf' }),
    lineItems: [
      {
        unit: 'request',
        quantity: '1',
        unitPrice: { currency: 'USD', scale: 6, units: '100' },
        amount: { currency: 'USD', scale: 6, units: '100' },
        ruleId: 'synthetic-rule',
      },
    ],
    amount: { currency: 'USD', scale: 6, units: '100' },
    rounding: 'half-even',
  }),
}
export function refundInput(id: string): W.BillingRefundRequest {
  return {
    chargeRef: { authorityId: 'synthetic-billing', typeId: 'agh.billing/entry@1', id, revision: 1 },
    amount: { currency: 'USD', scale: 6, units: '40' },
    reason: 'synthetic refund',
    refundKey: 'synthetic-refund',
  }
}
export async function createBillingTraceConsumer(
  options: BillingTraceFixtureOptions & { createEffects(handle: EffectPorts['invoke']): EffectPorts },
) {
  const crash = (boundary: string) => {
    const marker = join(options.directory, 'crashed-' + boundary)
    if (options.crashBoundary === boundary && !existsSync(marker)) {
      writeFileSync(marker, 'synthetic-crash', { mode: 0o600 })
      process.kill(process.pid, 'SIGKILL')
    }
  }
  const chain =
    options.accountingChain && options.service === 'billing'
      ? await createAccountingChainFixture(options.directory, fixtureScope, billingInput, crash)
      : undefined
  const fallbackAccounting: BillingAccountingPorts = {
    async readUsage(ref) {
      return ref.authorityId === 'synthetic-usage' && ref.usageId === syntheticUsage.usageId
        ? { ok: true, value: structuredClone(syntheticUsage) }
        : refused('denied', 'fixture_usage_absent')
    },
    async reservation() {
      return {
        ok: true,
        value: {
          authorityId: 'synthetic-budget',
          typeId: 'agh.budget/reservation@1',
          id: 'synthetic-reservation',
          revision: 1,
        },
      }
    },
    async settle(input) {
      if (billingInput.quoteRef.kind !== 'inline') throw new Error('Synthetic quote missing')
      const quote = billingInput.quoteRef.value as unknown as W.PriceQuote
      return {
        ok: true,
        value: {
          reservation: {
            ref: input.reservationRef,
            actionId: syntheticUsage.actionId,
            attemptId: syntheticUsage.attemptId,
            accountRef: billingInput.accountRef,
            parentReservationRef: null,
            scopeIds: ['synthetic-scope'],
            unitsByKind: [{ unit: 'request', value: '1' }],
            held: quote.amount,
            priceVersion: quote.priceVersion,
            status: 'settled',
            revision: 2,
            expiresAt: '2099-01-01T00:00:00.000Z',
            settledAmount: quote.amount,
            usageRefs: input.usageRefs,
          },
          balance: null,
        },
      }
    },
  }
  const accounting =
    options.accounting === null ? undefined : (options.accounting ?? chain?.ports ?? fallbackAccounting)
  const revocation = join(options.directory, 'synthetic-revoked')
  let revoked = existsSync(revocation),
    stopped = false,
    consent = syntheticConsent(options.level)
  const lifetime = new AbortController(),
    inflight = new Map<string, AbortController>(),
    issued = new WeakSet<object>()
  mkdirSync(join(options.directory, 'content'), { recursive: true, mode: 0o700 })
  const retain = async (bytes: Uint8Array): Promise<W.BytesRef> => {
    if (options.service === 'billing') {
      const json = JSON.parse(new TextDecoder().decode(bytes))
      if (validateRuntime('BillingEntry', json).ok) crash('intent')
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(join(options.directory, 'content', digest), bytes, { mode: 0o600 })
    return {
      authorityId: 'restricted-effects-fixture',
      blobId: digest,
      digest,
      bytes: bytes.length,
      mediaType: 'application/json',
      pinId: 'synthetic-fixture-pin',
    }
  }
  const contentRead = async (ref: W.BytesRef) =>
    new Uint8Array(readFileSync(join(options.directory, 'content', ref.blobId)))
  const target: W.NetworkTarget = {
    targetId: 'synthetic-endpoint',
    scheme: 'http',
    host: '127.0.0.1',
    port: options.port,
    path: options.path ?? (options.service === 'trace' ? '/v1/traces' : '/billing'),
  }
  const network = createNetworkService({
    directory: join(options.directory, 'network'),
    tenantId: 'synthetic-tenant',
    rules: [
      {
        targetId: target.targetId,
        scheme: 'http',
        host: target.host,
        port: target.port,
        effect: 'allow',
        addresses: ['127.0.0.1'],
      },
    ],
    content: { read: contentRead, retain },
    identity: {
      async resolve(request, call) {
        return issued.has(call) && !revoked
          ? {
              ok: true,
              value: {
                principalRef: request.principalRef,
                tenantRef: 'synthetic-tenant',
                claims: inline(configSchema, {}),
                authRevision: 1,
                expiresAt: new Date(Date.now() + 60000).toISOString(),
                authKind: 'local',
                credentialKind: 'local',
                ownerClass: 'local-owner',
              },
            }
          : refused('denied', 'permission_absent')
      },
    },
    authorize: (_target, call) => issued.has(call) && !revoked,
  })
  const authorize = async (call: CallContext) =>
    !revoked &&
    !stopped &&
    call.authorizationRef === 'synthetic-auth' &&
    call.principalRef === 'synthetic-principal' &&
    canonicalJsonDigest(call.scope) === canonicalJsonDigest(fixtureScope)
  const effects = options.createEffects(async (request, call) => {
    issued.add(call)
    const networkRequest =
      request.input.kind === 'inline' ? validateRuntime('NetworkRequest', request.input.value) : null
    if (!networkRequest?.ok) return refused('invalid_input', 'input_schema')
    const trustedCall = {
      ...call,
      invocationId: canonicalJsonDigest({ request: networkRequest.value, principal: call.principalRef }),
    }
    issued.add(trustedCall)
    const response = await network.request(networkRequest.value, trustedCall)
    if (options.crashAfterSend && response.ok) process.kill(process.pid, 'SIGKILL')
    return response.ok
      ? { ok: true, value: inline(RuntimeMethodSchemaRefs['agh.network'].request.output, response.value) }
      : response
  })
  const common = {
    path: join(options.directory, `${options.service}.sqlite`),
    packageDigest: billingTraceProviderDigest(options.kind, options.service),
    configSchema,
    authorize,
    outbound: { target, retain },
  }
  const factory: ProviderFactory<ServiceProvider> =
    options.service === 'trace'
      ? (options.kind === 'default' ? createTraceFactory : createReferenceTraceFactory)({
          ...common,
          capacity: options.capacity ?? 256,
          consent: async () => ({ ok: true, value: consent }),
          trajectory: {
            schema: RuntimeSchemaRefs.StandardToolOutput,
            validate: (value: W.JsonValue) => validateRuntime('StandardToolOutput', value).ok,
            anonymize: () => ({ content: [], structured: { records: 1 } }),
          },
          attributeSchema: attributesSchema,
          validateAttributes: (value) =>
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.entries(value).every(([key, v]) => key === 'label' && typeof v === 'string'),
          lookup: async () => ({ ok: true, value: null }),
        })
      : (options.kind === 'default' ? createBillingFactory : createReferenceBillingFactory)({
          ...common,
          authorityId: 'synthetic-billing',
          priceVersions: existsSync(join(options.directory, 'retired-price')) ? [] : ['synthetic-price-v1'],
          ...(accounting ? { accounting } : {}),
          readResponse: contentRead,
          async verifyEvidence(ref) {
            if (
              ref.kind !== 'inline' ||
              ref.digest !== canonicalJsonDigest(ref.value) ||
              ref.schema.digest !== RuntimeMethodSchemaRefs['agh.billing'].post.output.digest
            )
              return refused('denied', 'callback_unverified')
            const checked = validateRuntime('BillingEntry', ref.value)
            return checked.ok
              ? { ok: true, value: checked.value }
              : refused('invalid_input', 'callback_invalid')
          },
        })
  const bindingId = `synthetic-${options.service}-binding`,
    factoryContext = {
      instanceId: 'synthetic-instance',
      bindingId,
      scope:
        options.service === 'trace'
          ? {
              kind: 'runtime' as const,
              installationId: fixtureScope.installationId,
              runtimeId: 'synthetic-runtime',
            }
          : fixtureScope,
      signal: lifetime.signal,
    }
  const dependencies: ScopedDependencies = {
    get: () => refused('incompatible', 'operation_not_supported'),
    openScope: async () => refused('incompatible', 'operation_not_supported'),
    close: async () => {},
  }
  const provider = await factory.create(inline(configSchema, {}), dependencies, factoryContext)
  const call = (mode?: string): CallContext => {
    const cancel = new AbortController(),
      id = randomUUID()
    if (mode === 'cancel') cancel.abort()
    inflight.set(id, cancel)
    return {
      principalRef: 'synthetic-principal',
      scope: fixtureScope,
      bindingId,
      invocationId: id,
      authorizationRef: mode === 'deny' ? 'untrusted' : 'synthetic-auth',
      traceRef: 'synthetic-local-trace',
      deadline: new Date(Date.now() + 5000).toISOString(),
      signal: cancel.signal,
    }
  }
  async function action(method: string, input: unknown, mode?: string): Promise<W.EffectResult> {
    const c = call(mode),
      refs = RuntimeMethodSchemaRefs[options.service === 'trace' ? 'agh.trace' : 'agh.billing'],
      schema = (refs as Record<string, { input: W.SchemaRef }>)[method]?.input
    if (!schema) throw new Error('unexpected method')
    const encoded = inline(schema, input),
      { signal: _signal, ...wire } = c,
      page = { items: [], snapshot: 'synthetic-snapshot', nextCursor: null, complete: true }
    const frame: W.ActionFrame = {
      actionId: canonicalJsonDigest({ method, inputDigest: encoded.kind === 'inline' ? encoded.digest : '' }),
      parentActionId: null,
      runId: 'synthetic-run',
      bindingId,
      method,
      input: encoded,
      inputDigest: encoded.kind === 'inline' ? encoded.digest : '',
      attemptId: 'synthetic-attempt',
      attemptNumber: 1,
      invocationId: c.invocationId,
      requestIdentity: null,
      providerRevision: 1,
      continuation: null,
      signals: page,
      receipts: page,
      signalHighWater: 0,
      snapshot: 'synthetic-snapshot',
      observedAt: new Date().toISOString(),
      context: wire,
      actionTimebox: { defaultTimeoutMs: 5000, maxDeadline: c.deadline },
    }
    const leaf = await provider.actions?.[method]?.create({
      instanceId: factoryContext.instanceId,
      actionId: frame.actionId,
      runId: frame.runId,
      bindingId,
      scope: fixtureScope,
      signal: lifetime.signal,
    })
    if (leaf?.kind !== 'leaf') throw new Error('selected action absent')
    const ctx: ActionContext = {
      call: c,
      effects,
      progress: async () => refused('incompatible', 'operation_not_supported'),
    }
    try {
      const result = await leaf.execute(frame, ctx)
      if (options.service === 'billing' && result.outcome === 'succeeded') crash('callback')
      return result
    } finally {
      inflight.delete(c.invocationId)
      if (mode === 'drain') await leaf.drain(c.deadline, c)
      await leaf.close('completed')
    }
  }
  return {
    factory,
    provider,
    async prepareAccounting() {
      if (!chain) throw new Error('Accounting chain absent')
      const ctx = call()
      try {
        return await chain.prepare(ctx)
      } finally {
        inflight.delete(ctx.invocationId)
      }
    },
    accountingStats: () => chain?.stats(),
    retirePrice: () =>
      writeFileSync(join(options.directory, 'retired-price'), 'synthetic-retired', { mode: 0o600 }),
    action,
    descriptor: factory.descriptor,
    async record(input: unknown, mode?: string) {
      const c = call(mode)
      try {
        return await provider.observe?.(
          {
            method: 'record',
            target: {
              bindingId,
              contract: 'agh.trace',
              logicalName: factory.descriptor.logicalName,
              providerId: factory.descriptor.providerId,
            },
            input: inline(RuntimeMethodSchemaRefs['agh.trace'].record.input, input),
          },
          c,
        )
      } finally {
        inflight.delete(c.invocationId)
      }
    },
    cancel() {
      for (const controller of inflight.values()) controller.abort()
    },
    revoke() {
      revoked = true
      writeFileSync(revocation, 'revoked\n', { mode: 0o600 })
    },
    changeConsent(level: W.TelemetryConsent['level']) {
      consent = syntheticConsent(level)
    },
    async stop() {
      stopped = true
      await provider.close('shutdown')
    },
    async close() {
      stopped = true
      for (const controller of inflight.values()) controller.abort()
      await provider.close('shutdown')
      await network.close()
      await chain?.close()
    },
  }
}
