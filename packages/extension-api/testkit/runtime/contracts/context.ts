import type {
  CallContext,
  FactoryContext,
  Outcome,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { type BuildIdentity, SCENARIOS, type ScenarioName } from '../evidence.js'
import { type ConformanceHarness, createTestServiceContainer } from '../harness.js'

/** Synthetic fixed-input fixture. These DTOs do not constitute production permissions. */
export function contextFixtureData(providerId = 'fixture/context') {
  const configSchema = defineGeneratedAuthorSchema<Record<string, never>>({
    ownerPackageId: 'fixture.context',
    name: 'Empty',
    typeId: 'fixture.context/empty@1',
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Empty',
      $defs: { Empty: { type: 'object', properties: {}, required: [], additionalProperties: false } },
    },
  })
  const textSource: W.GeneratedAuthorSchemaSource = {
    ownerPackageId: 'fixture.context',
    name: 'Text',
    typeId: 'fixture.context/text@1',
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Text',
      $defs: { Text: { type: 'string', maxLength: 4096 } },
    },
  }
  const textCodec = defineGeneratedAuthorSchema<string>(textSource)
  const descriptor: W.ProviderDescriptor = {
    providerId,
    contract: 'agh.context',
    logicalName: 'default',
    major: 1,
    packageVersion: '1.0.0',
    packageDigest: canonicalJsonDigest({ providerId }),
    features: ['fixed-text-view.v1'],
    scope: 'run',
    configSchema: configSchema.ref,
    requires: [],
    capabilities: [],
    recovery: 'R1',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: [
      {
        method: 'view',
        kind: 'query',
        ...{
          inputSchema: RuntimeMethodSchemaRefs['agh.context'].view.input,
          outputSchema: RuntimeMethodSchemaRefs['agh.context'].view.output,
        },
        requiredCapabilities: [],
        retrySafety: 'read-only',
      },
    ],
  }
  const binding: W.BindingRef = {
    bindingId: 'context',
    providerId,
    contract: 'agh.context',
    logicalName: 'default',
  }
  const scope: W.ScopeRef = {
    kind: 'run',
    installationId: 'i',
    runtimeId: 'rt',
    workspaceId: 'w',
    sessionId: 's',
    runId: 'r',
  }
  const context: CallContext = {
    scope,
    bindingId: binding.bindingId,
    principalRef: 'fixture-principal',
    authorizationRef: 'fixture-authorization',
    invocationId: 'fixture-query',
    traceRef: 'fixture-trace',
    deadline: '2099-01-01T00:00:00Z',
    signal: new AbortController().signal,
  }
  const factoryContext: FactoryContext = {
    scope,
    bindingId: binding.bindingId,
    instanceId: 'fixture-instance',
    signal: new AbortController().signal,
  }
  const session: W.SessionRef = {
    sessionId: 's',
    authority: { tenantId: 'fixture-tenant', authorityId: 'fixture-authority', authorityEpoch: 1 },
  }
  const contribution = {
    registrationDigest: canonicalJsonDigest([]),
    sections: [],
    runtimeContext: [],
    candidateTools: [],
    conflictDiagnostics: [],
  }
  const input: W.ContextViewRequest = {
    sessionRef: session,
    atRevision: 1,
    target: { modelRoute: 'fixture-model', format: 'fixture-text', tokenLimit: 200 },
    resourceRefs: [],
    purpose: 'fixed short text',
    contributions: { ...contribution, digest: canonicalJsonDigest(contribution) },
    hookResults: null,
  }
  const request: W.ServiceQuery = {
    target: binding,
    method: 'view',
    snapshot: 'fixture-snapshot',
    input: contextInline(RuntimeMethodSchemaRefs['agh.context'].view.input, input),
  }
  const body = textCodec.encode('count this short text')
  const config = configSchema.encode({})
  if (!body.ok || !config.ok) throw new Error('Context fixture encoding failed')
  const hooks = { workspaceId: 'w', configRevision: 1, event: 'context' as const, registrations: [] }
  const source = {
    session,
    revision: 1,
    snapshot: 'fixture-snapshot',
    inputDigest: canonicalJsonDigest(input),
    items: [
      {
        id: 'message',
        kind: 'message' as const,
        body: body.value,
        sourceRefs: [{ kind: 'session' as const, value: session }],
        provenance: { sourceRefs: ['fixture-message'], producer: binding, trustLabels: ['user'] },
        trust: 'user' as const,
        tokenEstimate: 5,
        protected: true,
        toolPairRef: null,
        sourceRanges: [{ session, fromSeq: 1, toSeq: 1, digest: canonicalJsonDigest('fixture-message') }],
      },
    ],
    protectedRefs: [{ kind: 'session' as const, value: session }],
    hooks: { ...hooks, digest: canonicalJsonDigest(hooks) },
  }
  return {
    descriptor,
    configSchema,
    textSource,
    format: 'fixture-text',
    config: config.value,
    factoryContext,
    context,
    request,
    source,
  }
}
export function contextInline(schema: W.SchemaRef, value: unknown): W.DataRef {
  const encoded = boundedCanonicalJson(value, { maxBytes: 16_384, maxDepth: 32, maxMembers: 4096 })
  if (!encoded.ok) throw new Error('Context fixture data is too large')
  return {
    kind: 'inline',
    schema,
    value: encoded.value.json,
    bytes: encoded.value.bytes,
    digest: canonicalJsonDigest(encoded.value.json),
  }
}
export interface ContextContractFixture {
  factory: ProviderFactory<ServiceProvider>
  config: W.DataRef
  dependencies: ScopedDependencies
  factoryContext: FactoryContext
  context: CallContext
  request: W.ServiceQuery
  /** Returns a digest of the original source before/after pure reads. */
  sourceDigest(): W.Digest
  revoke(): void
  cold(): Promise<{
    reply: Outcome<W.QueryReply>
    first: Outcome<W.QueryReply>
    killedPid: number
    restoredPid: number
    revokedReply: Outcome<W.QueryReply>
    revokedPid: number
    signal: 'SIGKILL'
  }>
  close(): Promise<void>
}
function insist(value: unknown, name: string): asserts value {
  if (!value) throw new Error(`Context view contract failed: ${name}`)
}
export async function runContextContractScenario(
  scenario: ScenarioName,
  open: () => Promise<ContextContractFixture>,
) {
  const fixture = await open()
  const provider = await fixture.factory.create(fixture.config, fixture.dependencies, fixture.factoryContext)
  try {
    insist(provider.query, 'query handler')
    insist((await provider.ready(fixture.context)).ok, 'ready')
    const consumer = createTestServiceContainer()
    const requirement: W.ServiceRequirement = {
      contract: 'agh.context',
      major: 1,
      logicalName: 'default',
      features: ['fixed-text-view.v1'],
      scope: 'run',
      optional: false,
    }
    consumer.register({ requirement, binding: fixture.request.target, query: provider.query })
    const selected = consumer.dependencies.get(requirement)
    insist(selected.ok, 'selected service')
    const query = (context = fixture.context) => selected.value.query(fixture.request, context)
    const verify = (reply: Outcome<W.QueryReply>) => {
      insist(reply.ok && reply.value.kind === 'value' && reply.value.output.kind === 'inline', 'view output')
      const output = reply.value.output
      insist(
        canonicalJsonDigest(output.schema) ===
          canonicalJsonDigest(RuntimeMethodSchemaRefs['agh.context'].view.output),
        'official codec',
      )
      const encoded = boundedCanonicalJson(output.value, { maxBytes: 16_384, maxDepth: 32, maxMembers: 4096 })
      insist(
        encoded.ok &&
          encoded.value.bytes === output.bytes &&
          canonicalJsonDigest(encoded.value.json) === output.digest,
        'output content proof',
      )
      const parsed = validateRuntime('ContextView', output.value)
      insist(parsed.ok && parsed.value.items.length > 0, 'nonempty view')
      const { digest, ...content } = parsed.value
      insist(canonicalJsonDigest(content) === digest, 'view digest')
      insist(reply.value.snapshot === fixture.request.snapshot, 'fixed snapshot')
      return canonicalJsonDigest(reply.value)
    }
    const before = fixture.sourceDigest()
    if (scenario === 'select') {
      insist(validateRuntime('ProviderDescriptor', fixture.factory.descriptor).ok, 'descriptor')
      insist(
        fixture.factory.descriptor.operations.length === 1 &&
          fixture.factory.descriptor.operations[0]?.method === 'view',
        'read-only slice',
      )
      verify(await query())
    } else if (scenario === 'normal') verify(await query())
    else if (scenario === 'deny') {
      fixture.revoke()
      insist(!(await query()).ok, 'current revocation')
    } else if (scenario === 'cancel') {
      const controller = new AbortController()
      controller.abort()
      const result = await query({ ...fixture.context, signal: controller.signal })
      insist(!result.ok && result.error.code === 'cancelled', 'cancelled read')
    } else if (scenario === 'recover') {
      const original = verify(await query()),
        cold = await fixture.cold()
      insist(
        cold.signal === 'SIGKILL' &&
          cold.killedPid > 0 &&
          cold.restoredPid > 0 &&
          cold.killedPid !== cold.restoredPid,
        'actual killed process and cold process',
      )
      insist(
        verify(cold.first) === original && verify(cold.reply) === original,
        'original input after cold process',
      )
      insist(
        cold.revokedPid > 0 &&
          cold.revokedPid !== cold.restoredPid &&
          !cold.revokedReply.ok &&
          cold.revokedReply.error.code === 'denied',
        'saved input does not restore revoked current authority',
      )
    } else {
      insist((await provider.drain(fixture.context.deadline, fixture.context)).ok, 'drain')
      insist(!(await query()).ok, 'old selected service after drain')
      await provider.close('shutdown')
      insist(
        !(await query()).ok && !(await provider.ready(fixture.context)).ok,
        'closed service cannot revive',
      )
    }
    insist(fixture.sourceDigest() === before, 'query did not change source')
    return {
      providerDigest: fixture.factory.descriptor.packageDigest,
      configDigest: fixture.config.kind === 'inline' ? fixture.config.digest : fixture.config.blob.digest,
    }
  } finally {
    await provider.close('shutdown')
    await fixture.close()
  }
}

/** Six lifecycle slots for the bounded query slice, not complete prepare/refresh conformance. */
export function registerContextContract(
  harness: ConformanceHarness,
  binding: {
    providerId: string
    build: BuildIdentity
    command: string
    open: () => Promise<ContextContractFixture>
  },
) {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.context',
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run() {
        const evidence = await runContextContractScenario(scenario, binding.open)
        return {
          id: `agh.context/${binding.providerId}/${scenario}/fixed-text-view`,
          ...evidence,
          recipe: 'fixed-text-query-slice',
          features: ['fixed-text-view.v1'],
          build: binding.build,
          consumer: 'selected-context-view-consumer',
          command: binding.command,
          status: 'passed',
          diagnostic: 'Fixed inline query only; prepare/refresh and production State remain unverified',
          releaseSetDigest: canonicalJsonDigest({ providerId: binding.providerId, slice: 'fixed-text-view' }),
          attachmentDigest: null,
          fixture: 'test-service-container',
          sharedEvidenceId: null,
          perImplementation: true,
          gate: null,
        }
      },
    })
}
