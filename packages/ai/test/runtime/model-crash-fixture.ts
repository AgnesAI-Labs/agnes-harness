import { existsSync, readFileSync } from 'node:fs'
import type { ActionContext, CallContext, Outcome } from '@agnes/extension-api/runtime'
import { defineGeneratedAuthorSchema, runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import {
  type ActionFrame,
  canonicalJsonDigest,
  type DataRef,
  type EffectResult,
  type JsonValue,
  type PreparedModelRequest,
  RuntimeMethodSchemaRefs,
  type UsageMeasurement,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { ModelAdapterDeployment, ModelWireSource } from '../../src/runtime/model-adapter/ports.js'
import { createModelAdapterFactory } from '../../src/runtime/providers/model-adapter.js'
import { fakeModel, fakeRequest } from '../../testkit/index.js'
import { persistModelCrashFacts } from './fixtures/model-crash-storage.js'

const string = (maxLength = 256) => ({ type: 'string', minLength: 0, maxLength })
const integer = (maximum = 9007199254740991) => ({ type: 'integer', minimum: 0, maximum })
const array = (items: JsonValue, maxItems = 64) => ({ type: 'array', minItems: 0, maxItems, items })
const object = (properties: Record<string, JsonValue>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  minProperties: 0,
  maxProperties: Object.keys(properties).length,
})
const config = defineGeneratedAuthorSchema<Record<string, never>>({
  ownerPackageId: '@fixture/model',
  name: 'Empty',
  typeId: '@fixture/model/empty@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/Empty',
    $defs: { Empty: object({}) },
  },
})
const evidence = object(
  {
    status: integer(599),
    id: string(128),
    model: string(256),
    headers: object({ 'x-request-id': string(256) }, []),
    headerNames: array(string(128)),
  },
  [],
)
const receipt = object({
  kind: { const: 'inline' },
  schema: object({
    typeId: { const: runtimeAuthorSchemas.ProviderResponseEvidence.ref.typeId },
    revision: { const: runtimeAuthorSchemas.ProviderResponseEvidence.ref.revision },
    digest: { const: runtimeAuthorSchemas.ProviderResponseEvidence.ref.digest },
  }),
  value: evidence,
  digest: { type: 'string', minLength: 64, maxLength: 64 },
  bytes: integer(262144),
})
const usage = defineGeneratedAuthorSchema<UsageMeasurement>({
  ownerPackageId: '@fixture/model',
  name: 'Measurement',
  typeId: '@fixture/model/measurement@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/Measurement',
    $defs: {
      Measurement: object(
        {
          kind: { enum: ['reported', 'estimated', 'corrected', 'unknown'] },
          quantities: array(object({ unit: string(128), value: string(32) }), 16),
          actualModel: { anyOf: [string(8192), { type: 'null' }] },
          source: { enum: ['provider-receipt', 'adapter-counter', 'reported-target', 'estimator'] },
          sourceReceipt: { anyOf: [receipt, { type: 'null' }] },
          replacesFactIds: array(string(256), 16),
          billing: object({
            usdMicros: integer(),
            source: { enum: ['gateway', 'estimated'] },
            subscription: { type: 'boolean' },
          }),
          credits: { type: 'number', minimum: 0 },
          creditSource: { enum: ['gateway', 'estimated'] },
        },
        ['kind', 'quantities', 'actualModel', 'source', 'sourceReceipt', 'replacesFactIds'],
      ),
    },
  },
})
const preparedLocator = defineGeneratedAuthorSchema<{ preparedDigest: string; inputDigest: string }>({
  ownerPackageId: '@fixture/model',
  name: 'PreparedLocator',
  typeId: '@fixture/model/prepared-locator@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/PreparedLocator',
    $defs: { PreparedLocator: object({ preparedDigest: string(64), inputDigest: string(64) }) },
  },
})
const value = <T>(outcome: Outcome<T>): T => {
  if (!outcome.ok) throw new Error(outcome.error.detailCode)
  return outcome.value
}
function ref(schema: DataRef['schema'], value: JsonValue): DataRef {
  const body = JSON.stringify(value)
  return { kind: 'inline', schema, value, digest: canonicalJsonDigest(value), bytes: Buffer.byteLength(body) }
}

/** A durable owner supplied by the caller in place of the fixture's own journal. */
export type ModelCrashOwner = Readonly<{
  save: ModelAdapterDeployment['save']
  lookup: ModelAdapterDeployment['lookup']
  /** Runs last in `beforeSend`; false refuses the send. */
  beforeSend?: (frame: ActionFrame, bodyDigest: string) => boolean
  /** Call deadline for a first run; a later run reads the one saved with the issued operation. */
  deadline?: string
}>

/** Original object capability + real source codecs; restricted fixture, never a production identity. */
export async function modelCrashFixture(
  api: 'openai-completions' | 'anthropic-messages',
  baseUrl: string,
  journal: string,
  operation: string,
  cutAfterReceipt: boolean,
  owner?: ModelCrashOwner,
) {
  type SavedOperation = {
    source: ModelWireSource
    frame: ActionFrame
    sourceDigest: string
    frameDigest: string
  }
  const saved: SavedOperation | undefined = existsSync(operation)
    ? JSON.parse(readFileSync(operation, 'utf8'))
    : undefined
  if (
    saved &&
    (!validateRuntime('ActionFrame', saved.frame).ok ||
      !validateRuntime('PreparedModelRequest', saved.source.prepared).ok ||
      canonicalJsonDigest(saved.source as never) !== saved.sourceDigest ||
      canonicalJsonDigest(saved.frame as never) !== saved.frameDigest)
  )
    throw Error('Original issued operation differs')
  const scope = {
    kind: 'runtime' as const,
    installationId: 'fixture-installation',
    runtimeId: 'fixture-runtime',
  }
  const context: CallContext = {
    principalRef: 'fixture-model-user',
    scope,
    bindingId: 'fixture-adapter',
    invocationId: 'fixture-invocation',
    deadline: saved?.frame.context.deadline ?? owner?.deadline ?? new Date(Date.now() + 20000).toISOString(),
    traceRef: 'fixture-trace',
    authorizationRef: 'fixture-authority',
    signal: new AbortController().signal,
  }
  const model = fakeModel({ id: 'fixture-model', route: 'fixed-route', api, baseUrl })
  const prepared: PreparedModelRequest = {
    preparedId: 'prepared',
    ownerBinding: {
      bindingId: 'model-gateway',
      providerId: 'gateway',
      contract: 'agh.model',
      logicalName: 'default',
    },
    target: {
      routeId: 'fixed-route',
      routeRevision: 1,
      adapter: {
        bindingId: context.bindingId,
        providerId: 'agh.default/model-adapter',
        contract: 'agh.model-adapter',
        logicalName: 'default',
      },
      model: model.id,
      endpointRef: 'fixture-endpoint',
      catalogRevision: 1,
      features: { input: ['text'], output: ['text'], tools: false, structuredOutput: false, streaming: true },
      priceVersion: 'fixture-price-1',
      credentialAudience: 'fixture-endpoint',
      credentialBinding: {
        consumer: 'model',
        secretId: 'fixture-secret',
        accountRef: null,
        serverRef: 'fixture-endpoint',
        audience: 'fixture-endpoint',
        purpose: 'model-inference',
      },
    },
    view: {
      viewId: 'view',
      format: 'fixture-text',
      schema: runtimeAuthorSchemas.StandardToolOutput.ref,
      baseRevision: 1,
      items: [],
      tokenEstimate: 1,
      protectedRefs: [],
      inputDigest: 'a'.repeat(64),
      digest: 'b'.repeat(64),
      runtimeInstructionRefs: [],
    },
    inputDigest: 'a'.repeat(64),
    outputSchema: null,
    toolCatalog: null,
    generation: { maxOutputTokens: 32, thinking: null },
    mediaPlans: [],
    estimatedUnits: [],
    hookResults: null,
    sessionParameterRef: {
      authorityId: 'fixture-config',
      recordId: 'parameters',
      recordRevision: 1,
      schema: config.ref,
      digest: canonicalJsonDigest({}),
    },
    legacyRequestOverrides: null,
    credentialRef: {
      handleId: 'fixture-handle',
      secretId: 'fixture-secret',
      version: 'fixed-v1',
      audience: 'fixture-endpoint',
      expiresAt: context.deadline,
    },
  }
  const source: ModelWireSource = {
    prepared,
    route: { route: 'fixed-route', api, baseUrl, models: [model] },
    model,
    request: fakeRequest({
      route: 'fixed-route',
      model: model.id,
      derivedHash: prepared.inputDigest,
      sampling: { maxTokens: 32 },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    }),
  }
  let revokeDuringLoad = false,
    saveFailure = false,
    mutateAtSend = false
  let live = true,
    rejectSend = false,
    sends = 0
  const originalContext = context,
    pinned = canonicalJsonDigest(source as never)
  const current = () => live && canonicalJsonDigest(source as never) === pinned
  const deployment: ModelAdapterDeployment = {
    config,
    usage,
    usageAuthorityId: 'fixture-usage',
    packageDigest: 'c'.repeat(64),
    units: {
      input: 'fixture.input-token',
      output: 'fixture.output-token',
      cacheRead: 'fixture.cache-read-token',
      cacheWrite: 'fixture.cache-write-token',
      reasoning: 'fixture.reasoning-token',
    },
    installed: (call) => call === originalContext && live,
    async load(reference, _frame, call) {
      const parsed =
        reference.kind === 'inline' &&
        canonicalJsonDigest(reference.schema) === canonicalJsonDigest(preparedLocator.ref)
          ? preparedLocator.parse(reference.value)
          : null
      if (
        !parsed?.ok ||
        parsed.value.preparedDigest !== canonicalJsonDigest(prepared as never) ||
        parsed.value.inputDigest !== prepared.inputDigest ||
        call.call !== originalContext
      )
        return {
          ok: false,
          error: {
            code: 'denied',
            detailCode: 'fixture_prepared_source',
            message: 'Fixture source refused',
            retryAdvice: { kind: 'never' },
            diagnosticId: 'fixture',
          },
        }
      await Promise.resolve()
      if (revokeDuringLoad) live = false
      return { ok: true, value: source }
    },
    current: (_source, _frame, call) => call === originalContext && current(),
    // A test stand-in for the host's restricted model egress, not the host port: it forwards through
    // the global fetch, and only to this fixture's own loopback endpoint.
    egress: () => (input, init) =>
      (input instanceof Request ? input.url : String(input)).startsWith(baseUrl)
        ? globalThis.fetch(input, init)
        : Promise.reject(new Error('Fixture egress target refused')),
    async withCredential(_source, _frame, _context, consume) {
      return { ok: true, value: await consume('fixture-wire') }
    },
    beforeSend(_source, frame, call, bodyDigest) {
      if (rejectSend || call.call !== originalContext || !current()) return false
      if (mutateAtSend) Reflect.set(context, 'authorizationRef', 'changed-authorization')
      if (owner?.beforeSend && !owner.beforeSend(frame, bodyDigest)) return false
      sends++
      return true
    },
    async save(frame, result, bodyDigest) {
      if (saveFailure) throw new Error('Fixture receipt store unavailable')
      if (!validateRuntime('EffectResult', result).ok || !validateRuntime('ActionFrame', frame).ok)
        throw Error('Actual adapter receipt is invalid')
      const stored = {
        frame,
        result,
        bodyDigest,
        sourceDigest: pinned,
        preparedPriceVersion: source.prepared.target.priceVersion,
        requestIdentity: frame.requestIdentity,
        usage: result.usage,
      }
      persistModelCrashFacts(journal, JSON.stringify(stored))
      if (cutAfterReceipt) {
        process.send?.({
          phase: 'durable',
          pid: process.pid,
          result,
          resultDigest: canonicalJsonDigest(result as never),
        })
        await new Promise<never>(() => {})
      }
    },
    async lookup(frame, _evidence, _context, target) {
      try {
        const saved = JSON.parse(readFileSync(journal, 'utf8')) as {
          frame: ActionFrame
          result: EffectResult
          bodyDigest: string | null
          sourceDigest: string
          preparedPriceVersion: string
          requestIdentity: ActionFrame['requestIdentity']
          usage: EffectResult['usage']
        }
        if (
          !validateRuntime('EffectResult', saved.result).ok ||
          !validateRuntime('ActionFrame', saved.frame).ok ||
          saved.sourceDigest !== pinned ||
          saved.preparedPriceVersion !== prepared.target.priceVersion ||
          canonicalJsonDigest(saved.requestIdentity as never) !==
            canonicalJsonDigest(frame.requestIdentity as never) ||
          canonicalJsonDigest(saved.usage as never) !== canonicalJsonDigest(saved.result.usage as never)
        )
          throw Error('Original durable source/usage relation differs')
        if (
          (target?.attemptId ?? frame.attemptId) !== saved.frame.attemptId ||
          (target?.actionId ?? frame.actionId) !== saved.frame.actionId ||
          (target?.run.runId ?? frame.runId) !== saved.frame.runId
        )
          throw new Error('Fixture attempt mismatch')
        return {
          kind: 'resolved',
          evidence: value(
            runtimeAuthorSchemas.StandardToolOutput.encode({ content: [], structured: { persisted: true } }),
          ),
          result: saved.result,
        }
      } catch {
        return {
          kind: 'unknown',
          evidence: value(
            runtimeAuthorSchemas.StandardToolOutput.encode({ content: [], structured: { persisted: false } }),
          ),
          reason: 'No durable fixture receipt',
        }
      }
    },
  }
  const container = createTestServiceContainer(),
    factory = createModelAdapterFactory(
      owner ? { ...deployment, save: owner.save, lookup: owner.lookup } : deployment,
    )
  const provider = await factory.create(value(config.encode({})), container.dependencies, {
    instanceId: 'fixture-instance',
    scope,
    bindingId: context.bindingId,
    signal: new AbortController().signal,
  })
  value(await provider.ready(context))
  const preparedRef = value(
    preparedLocator.encode({
      preparedDigest: canonicalJsonDigest(prepared as never),
      inputDigest: prepared.inputDigest,
    }),
  )
  const request = ref(RuntimeMethodSchemaRefs['agh.model-adapter'].invoke.input, {
    preparedCallRef: preparedRef as unknown as JsonValue,
    externalIdempotencyKey: 'fixed-external-key',
  })
  const { signal: _signal, ...wireContext } = context
  const frame: ActionFrame = {
    actionId: 'action',
    parentActionId: null,
    runId: 'run',
    bindingId: context.bindingId,
    method: 'invoke',
    input: request,
    inputDigest: canonicalJsonDigest(request.kind === 'inline' ? request.value : null),
    attemptId: 'attempt',
    attemptNumber: 1,
    invocationId: context.invocationId,
    requestIdentity: {
      system: 'fixture-model',
      aghRequestId: 'fixture-request',
      idempotencyKey: 'fixed-external-key',
      requestDigest: prepared.inputDigest,
    },
    providerRevision: 1,
    continuation: null,
    signals: { items: [], snapshot: 'snapshot', nextCursor: null, complete: true },
    receipts: { items: [], snapshot: 'snapshot', nextCursor: null, complete: true },
    signalHighWater: 0,
    snapshot: 'snapshot',
    observedAt: saved?.frame.observedAt ?? new Date().toISOString(),
    context: wireContext,
    actionTimebox: { defaultTimeoutMs: 20000, maxDeadline: context.deadline },
  }
  const issued = { source, frame, sourceDigest: pinned, frameDigest: canonicalJsonDigest(frame as never) }
  if (saved) {
    if (canonicalJsonDigest(issued as never) !== canonicalJsonDigest(saved as never))
      throw Error('Fresh owner cannot change original operation')
  } else persistModelCrashFacts(operation, JSON.stringify(issued))
  const actionFactory = provider.actions?.invoke
  if (!actionFactory) throw new Error('Missing invoke factory')
  const action = await actionFactory.create({
    instanceId: 'leaf',
    actionId: frame.actionId,
    runId: frame.runId,
    bindingId: context.bindingId,
    scope: {
      ...scope,
      kind: 'action',
      workspaceId: 'workspace',
      sessionId: 'session',
      runId: 'run',
      actionId: 'action',
    },
    signal: new AbortController().signal,
  })
  if (action.kind !== 'leaf') throw new Error('Unexpected composite')
  value(await action.ready(context))
  const call: ActionContext = {
    call: context,
    effects: {
      invoke: async () => {
        throw new Error('Undeclared effect')
      },
      stream: async () => {
        throw new Error('Undeclared stream')
      },
      upload: async () => {
        throw new Error('Undeclared upload')
      },
    },
    progress: async () => ({ ok: true, value: undefined }),
  }
  return {
    source,
    context,
    frame,
    action,
    provider,
    call,
    deployment,
    sends: () => sends,
    revoke: () => {
      live = false
    },
    revokeDuringLoad: () => {
      revokeDuringLoad = true
    },
    mutateAtSend: () => {
      mutateAtSend = true
    },
    failSave: () => {
      saveFailure = true
    },
    reject: () => {
      rejectSend = true
    },
  }
}
