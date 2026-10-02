import type {
  CallContext,
  DataRef,
  FactoryContext,
  Outcome,
  ProviderFactory,
  ScopedDependencies,
  ServiceOperation,
  ServiceProvider,
  ServiceQuery,
} from '@agnes/extension-api/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  MAX_AUTHOR_INLINE_BYTES,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { type BuildIdentity, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'

export interface PolicyContractFixture {
  readonly factory: ProviderFactory<ServiceProvider>
  readonly config: DataRef
  readonly dependencies: ScopedDependencies
  readonly factoryContext: FactoryContext
  readonly context: CallContext
  readonly evaluate: ServiceOperation
  readonly list: ServiceQuery
  readonly revoke: ServiceOperation
  read(reference: DataRef): Promise<unknown>
  /** Arrange an actual durable authorization denial, rather than returning an expected result. */
  deny(): Promise<void>
  /** Reopen the same persistent owner after the provider has closed. */
  recover(): Promise<PolicyContractFixture>
  finish(): Promise<void>
}
export interface PolicyConformanceBinding {
  readonly providerId: string
  readonly command: string
  readonly build: BuildIdentity
  readonly releaseSetDigest: string
  create(): Promise<PolicyContractFixture>
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Policy conformance failed: ${message}`)
}
async function output(
  fixture: PolicyContractFixture,
  result: Outcome<DataRef>,
  name: 'PolicyDecision' | 'ApprovalGrantRecord',
  method: 'evaluate' | 'revokeGrant',
) {
  assert(result.ok, `${method} did not succeed`)
  const reference = result.value
  const expected = RuntimeMethodSchemaRefs['agh.policy'][method].output
  assert(
    reference.schema.typeId === expected.typeId &&
      reference.schema.revision === expected.revision &&
      reference.schema.digest === expected.digest,
    'noncanonical response identity',
  )
  const value = await fixture.read(reference)
  const limits = RuntimeAuthorCodecPolicy.payload
  const bytes = boundedCanonicalJson(value, {
    maxBytes: reference.kind === 'inline' ? MAX_AUTHOR_INLINE_BYTES : limits.maxCanonicalJsonBytes,
    maxDepth: limits.maxDepth,
    maxMembers: limits.maxMembers,
  })
  const proof = reference.kind === 'inline' ? reference : reference.blob
  assert(
    bytes.ok && bytes.value.bytes === proof.bytes && canonicalJsonDigest(bytes.value.json) === proof.digest,
    'response bytes/digest mismatch',
  )
  const parsed = validateRuntime(name, value)
  assert(parsed.ok, 'response does not satisfy the canonical schema')
  return parsed.value
}

/** Six actual calls/lifecycle scenarios. No implementation-provided `passed` flag is accepted. */
export async function runPolicyContractScenario(
  scenario: ScenarioName,
  create: PolicyConformanceBinding['create'],
): Promise<{ providerDigest: string; configDigest: string }> {
  const fixture = await create()
  let current = fixture
  const provider = await fixture.factory.create(fixture.config, fixture.dependencies, fixture.factoryContext)
  try {
    assert(provider.compute && provider.query && provider.control, 'incomplete Policy method surface')
    if (scenario === 'select') {
      assert((await provider.ready(fixture.context)).ok, 'ready failed')
      assert((await provider.health(fixture.context)).ok, 'health failed')
      const names = fixture.factory.descriptor.operations
        .map((entry) => `${entry.kind}/${entry.method}`)
        .sort()
      assert(
        names.join(',') === 'compute/evaluate,control/revokeGrant,query/listGrants',
        'descriptor does not select exact Policy methods',
      )
    } else if (scenario === 'normal') {
      const verdict = await output(
        fixture,
        await provider.compute(fixture.evaluate, fixture.context),
        'PolicyDecision',
        'evaluate',
      )
      assert('decision' in verdict && verdict.decision === 'allow', 'verified normal input was not allowed')
      const listed = await provider.query(fixture.list, fixture.context)
      assert(listed.ok && listed.value.kind === 'value', 'grant list failed')
      const first = await output(
        fixture,
        await provider.control(fixture.revoke, fixture.context),
        'ApprovalGrantRecord',
        'revokeGrant',
      )
      const repeat = await output(
        fixture,
        await provider.control(fixture.revoke, fixture.context),
        'ApprovalGrantRecord',
        'revokeGrant',
      )
      assert(
        'revokedAt' in first &&
          first.revokedAt !== undefined &&
          JSON.stringify(first) === JSON.stringify(repeat),
        'repeated revoke changed the durable result',
      )
    } else if (scenario === 'deny') {
      await fixture.deny()
      const evaluated = await provider.compute(fixture.evaluate, fixture.context)

      if (evaluated.ok) {
        assert(
          evaluated.value.kind === 'inline' && validateRuntime('PolicyDecision', evaluated.value.value).ok,
          'deny result invalid',
        )
        const denied = validateRuntime('PolicyDecision', evaluated.value.value)
        assert(denied.ok && denied.value.decision === 'deny', 'current deny was overridden')
      }
      assert(
        !(await provider.control(fixture.revoke, fixture.context)).ok,
        'management denial allowed revoke',
      )
    } else if (scenario === 'cancel') {
      const controller = new AbortController()
      controller.abort()
      const context = { ...fixture.context, signal: controller.signal }
      assert(!(await provider.compute(fixture.evaluate, context)).ok, 'cancelled evaluate accepted')
      assert(!(await provider.control(fixture.revoke, context)).ok, 'cancelled revoke accepted')
    } else if (scenario === 'recover') {
      const original = await output(
        fixture,
        await provider.control(fixture.revoke, fixture.context),
        'ApprovalGrantRecord',
        'revokeGrant',
      )
      await provider.close('shutdown')
      current = await fixture.recover()
      const reopened = await current.factory.create(
        current.config,
        current.dependencies,
        current.factoryContext,
      )
      try {
        assert(reopened.control && reopened.compute, 'recovered methods absent')
        const repeated = await output(
          current,
          await reopened.control(current.revoke, current.context),
          'ApprovalGrantRecord',
          'revokeGrant',
        )
        assert(JSON.stringify(original) === JSON.stringify(repeated), 'recovery lost revoke identity')
        await output(
          current,
          await reopened.compute(current.evaluate, current.context),
          'PolicyDecision',
          'evaluate',
        )
      } finally {
        await reopened.close('shutdown')
      }
    } else {
      await provider.drain(fixture.context.deadline, fixture.context)
      assert(
        !(await provider.compute(fixture.evaluate, fixture.context)).ok,
        'draining provider still accepted input',
      )
      await provider.close('shutdown')
      assert(!(await provider.query(fixture.list, fixture.context)).ok, 'closed provider still served grants')
    }
    return {
      providerDigest: fixture.factory.descriptor.packageDigest,
      configDigest: fixture.config.schema.digest,
    }
  } finally {
    await provider.close('shutdown')
    await current.finish()
  }
}

export function registerPolicyContract(harness: ConformanceHarness, binding: PolicyConformanceBinding): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.policy',
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run() {
        const evidence = await runPolicyContractScenario(scenario, binding.create)
        return {
          id: `agh.policy/${binding.providerId}/${scenario}`,
          ...evidence,
          recipe: 'verified-current-facts',
          features: ['evaluate', 'listGrants', 'revokeGrant'],
          build: binding.build,
          consumer: 'policy-public-consumer',
          command: binding.command,
          status: 'passed',
          releaseSetDigest: binding.releaseSetDigest,
          attachmentDigest: null,
          fixture: null,
          sharedEvidenceId: null,
          reuse: {
            scope: 'session',
            methodKind: 'query/compute/control',
            lifecycle:
              scenario === 'cancel' || scenario === 'recover' || scenario === 'dispose' ? scenario : 'call',
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
}
