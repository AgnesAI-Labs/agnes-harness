import {
  defineGeneratedAuthorSchema,
  type Outcome,
  type PureToolDefinition,
  runtimeAuthorSchemas,
} from '@agnes/extension-api/runtime'
import type { ActionFrame, DataRef, StandardToolOutput, ToolDefinition } from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
} from '@agnes/protocol/runtime'
import { createPureToolAuthorAdapter } from '../../../extension-api/src/runtime/tool-authoring.js'
import type { ToolsContractFixture } from '../../../extension-api/testkit/runtime/contracts/tools.js'
import { createRestrictedEffectsFixture } from '../../../extension-api/testkit/runtime/effects.js'
import { createTestServiceContainer } from '../../../extension-api/testkit/runtime/harness.js'
import { createDefaultToolsFactory, type ToolsDeployment } from '../../src/runtime/providers/tools.js'
import { createTextStatisticsTool } from '../../src/runtime/tools/definitions.js'

export const toolsConfig = defineGeneratedAuthorSchema<Record<string, never>>({
  ownerPackageId: '@fixture/tools',
  name: 'Empty',
  typeId: '@fixture/tools/empty@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/Empty',
    $defs: {
      Empty: { type: 'object', additionalProperties: false, properties: {}, required: [], maxProperties: 0 },
    },
  },
})
export function toolsValue<T>(result: Outcome<T>): T {
  if (!result.ok) throw new Error(result.error.detailCode)
  return result.value
}
export function toolsRef(schema: DataRef['schema'], value: unknown): DataRef {
  const p = RuntimeAuthorCodecPolicy.payload
  const encoded = boundedCanonicalJson(value, {
    maxBytes: p.maxCanonicalJsonBytes,
    maxDepth: p.maxDepth,
    maxMembers: p.maxMembers,
  })
  if (!encoded.ok) throw new Error('Tools fixture budget')
  return {
    kind: 'inline',
    schema,
    value: encoded.value.json,
    bytes: encoded.value.bytes,
    digest: canonicalJsonDigest(encoded.value.json),
  }
}
export async function openToolsFixture(
  kind: 'default' | 'reference' = 'default',
  text = 'hello 皇上\r\n🙂 second',
  overrides: Partial<ToolsDeployment> = {},
): Promise<
  ToolsContractFixture & {
    deployment: ToolsDeployment
    definition: ToolDefinition
    author: PureToolDefinition<StandardToolOutput>
  }
> {
  const reference =
    kind === 'reference'
      ? await import(
          new URL('../../../../examples/runtime-reference/src/providers/tools.js', import.meta.url).href
        )
      : null
  const author = (
    reference ? reference.createReferenceTextStatisticsTool() : createTextStatisticsTool()
  ) as PureToolDefinition<StandardToolOutput>
  const configuration = toolsValue(toolsConfig.encode({}))
  const binding = {
    bindingId: 'tools-binding',
    contract: 'agh.tools',
    logicalName: 'default',
    providerId: kind === 'default' ? 'agh.default/tools' : 'fixture.reference/tools',
  }
  const scope = {
    kind: 'action' as const,
    installationId: 'installation',
    runtimeId: 'runtime',
    workspaceId: 'workspace',
    sessionId: 'session',
    runId: 'run',
    actionId: 'action',
  }
  const call = {
    principalRef: 'synthetic-principal',
    authorizationRef: 'synthetic-authorization',
    scope,
    bindingId: binding.bindingId,
    invocationId: 'invocation',
    deadline: '2030-01-01T00:00:00Z',
    traceRef: 'trace',
    signal: new AbortController().signal,
  }
  const input = toolsValue(
    runtimeAuthorSchemas.StandardToolOutput.encode({ content: [{ type: 'text', text }] }),
  )
  const definition: ToolDefinition = {
    resource: {
      resourceId: 'text-statistics',
      version: '1',
      digest: canonicalJsonDigest('fixed-text-statistics-version-1'),
    },
    executor: binding,
    name: 'text-statistics',
    inputSchema: runtimeAuthorSchemas.StandardToolOutput.ref,
    outputSchema: runtimeAuthorSchemas.StandardToolOutput.ref,
    requiredCapabilities: [],
    retrySafety: 'idempotent',
    publicAnnotations: toolsValue(
      runtimeAuthorSchemas.StandardToolOutput.encode({
        content: [{ type: 'text', text: author.description }],
      }),
    ),
    policy: {
      version: '1',
      classifierRef: null,
      defaults: {
        isReadOnly: true,
        isDestructive: false,
        replay: 'idempotent',
        requiresApproval: 'never',
        approvalScopes: [],
      },
    },
    execution: {
      concurrency: 'parallel',
      isOpenWorld: false,
      costHint: null,
      deferLoading: false,
      requiredModelInput: [],
    },
  }
  let authorized = true
  const permitted = async () =>
    authorized
      ? { ok: true as const, value: undefined }
      : {
          ok: false as const,
          error: {
            code: 'denied' as const,
            detailCode: 'tools_fixture_revoked',
            message: 'Synthetic source revoked',
            retryAdvice: { kind: 'never' as const },
            diagnosticId: 'tools-fixture',
          },
        }
  const refs = RuntimeMethodSchemaRefs['agh.tools']
  const deployment: ToolsDeployment = {
    descriptor: {
      providerId: binding.providerId,
      logicalName: binding.logicalName,
      contract: binding.contract,
      major: 1,
      packageVersion: '1.0.0',
      packageDigest: canonicalJsonDigest(kind),
      features: [],
      scope: 'workspace',
      configSchema: toolsConfig.ref,
      requires: [],
      capabilities: [],
      recovery: 'R1',
      isolation: ['trusted-in-process'],
      stateCodecs: [],
      activationMode: 'eager',
      operations: (['describe', 'classify', 'catalog', 'invoke'] as const).map((method) => ({
        method,
        kind: method === 'invoke' ? 'action' : method === 'describe' ? 'query' : 'compute',
        inputSchema: refs[method].input,
        outputSchema: refs[method].output,
        requiredCapabilities: [],
        retrySafety: method === 'invoke' ? 'idempotent' : 'read-only',
      })),
    },
    configuration,
    definition,
    snapshot: 'fixed-snapshot',
    catalogRevision: 1,
    checkCurrent: permitted,
    async verifyCall(invocation) {
      if (invocation.modelContextRef !== null)
        return {
          ok: false,
          error: {
            code: 'incompatible',
            detailCode: 'tools_model_context_source_unavailable',
            message: 'Direct-tool fixture has no model source',
            retryAdvice: { kind: 'never' },
            diagnosticId: 'tools-fixture',
          },
        }
      return permitted()
    },
    createExecutor: (toolCall) =>
      createPureToolAuthorAdapter(author, {
        definition,
        inputDigest: toolCall.input.kind === 'inline' ? toolCall.input.digest : toolCall.input.blob.digest,
        provenance: {
          sourceRefs: ['synthetic-retained-text-source'],
          producer: binding,
          trustLabels: ['derived'],
        },
      }),
    ...overrides,
  }
  const factory = reference
    ? reference.createReferenceToolsFactory(deployment)
    : createDefaultToolsFactory(deployment)
  const policy = {
    ...definition.policy.defaults,
    policyVersion: definition.policy.version,
    classifierDigest: canonicalJsonDigest(definition.policy),
    inputDigest: input.kind === 'inline' ? input.digest : input.blob.digest,
    definitionDigest: canonicalJsonDigest(definition),
  }
  const toolCall = {
    definition,
    input,
    expectedDefinitionDigest: policy.definitionDigest,
    policy: { ...policy, fingerprint: canonicalJsonDigest(policy) },
    batchRef: null,
    modelContextRef: null,
  }
  const actionInput = toolsRef(refs.invoke.input, toolCall),
    { signal: _signal, ...wire } = call
  if (actionInput.kind !== 'inline') throw new Error('Inline Tools fixture')
  const frame: ActionFrame = {
    actionId: 'action',
    parentActionId: null,
    runId: 'run',
    bindingId: binding.bindingId,
    method: 'invoke',
    input: actionInput,
    inputDigest: actionInput.digest,
    attemptId: 'attempt',
    attemptNumber: 1,
    invocationId: call.invocationId,
    requestIdentity: null,
    providerRevision: 0,
    continuation: null,
    signals: { items: [], nextCursor: null, snapshot: 'fixed-snapshot', complete: true },
    receipts: { items: [], nextCursor: null, snapshot: 'fixed-snapshot', complete: true },
    signalHighWater: 0,
    snapshot: 'fixed-snapshot',
    observedAt: '2026-10-05T00:00:00Z',
    context: wire,
    actionTimebox: { defaultTimeoutMs: 60_000, maxDeadline: call.deadline },
  }
  const effects = createRestrictedEffectsFixture()
  const words = text.match(/\S+/gu)?.length ?? 0,
    characters = [...text].length,
    lines = text.length ? text.split(/\r\n|\r|\n/u).length : 0
  return {
    factory,
    configuration,
    dependencies: createTestServiceContainer().dependencies,
    factoryContext: {
      instanceId: 'tools-instance',
      bindingId: binding.bindingId,
      scope: {
        kind: 'workspace',
        installationId: 'installation',
        runtimeId: 'runtime',
        workspaceId: 'workspace',
      },
      signal: new AbortController().signal,
    },
    call,
    frame,
    actionContext: { call, effects: effects.ports, progress: async () => ({ ok: true, value: undefined }) },
    describe: toolsRef(refs.describe.input, { resource: definition.resource }),
    classify: toolsRef(refs.classify.input, { definition, input }),
    catalog: toolsRef(refs.catalog.input, {
      tools: [definition],
      policy: {
        disclosure: 'standard',
        discoveredResourceIds: [],
        compactionAgentCallable: true,
        mainModel: null,
        policyRevision: 1,
      },
    }),
    expected: {
      content: [{ type: 'text', text: `characters=${characters}; words=${words}; lines=${lines}` }],
      structured: { characters, words, lines },
    },
    revoke() {
      authorized = false
    },
    effectsCount: () => effects.calls().length,
    async close() {},
    deployment,
    definition,
    author,
  }
}
