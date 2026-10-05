import type {
  ActionContext,
  ActionFrame,
  BindingRef,
  CallContext,
  DataRef,
  FactoryContext,
  LeafActionProvider,
  Outcome,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
  StandardToolOutput,
} from '@agnes/extension-api/runtime'
import { canonicalJsonDigest, RuntimeSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { type BuildIdentity, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'
import { createTestServiceContainer } from '../harness.js'

export const TOOLS_SLICE_COVERAGE = {
  implemented: [
    'fixed-definition',
    'pure-text-statistics',
    'describe',
    'classify',
    'catalog',
    'invoke',
    'cancelled-call',
    'pure-cold-recompute',
  ],
  incomplete: [
    'production-effects-source',
    'durable-receipt-reconcile',
    'cancel-command-receipt',
    'legacy-tools',
    'nested-bridge',
    'plan',
    'compaction-request',
    'authority-transfer',
  ],
} as const
export interface ToolsContractFixture {
  factory: ProviderFactory<ServiceProvider>
  configuration: DataRef
  dependencies: ScopedDependencies
  factoryContext: FactoryContext
  call: CallContext
  describe: DataRef
  classify: DataRef
  catalog: DataRef
  frame: ActionFrame
  actionContext: ActionContext
  expected: StandardToolOutput
  revoke(): void
  effectsCount(): number
  close(): Promise<void>
}
export interface ToolsColdProof {
  firstPid: number
  recoveredPid: number
  original: string
  recovered: string
  inputDigest: string
  configurationDigest: string
}
export interface ToolsContractBinding {
  providerId: 'default' | 'reference'
  providerDigest: string
  build: BuildIdentity
  command: string
  open(): Promise<ToolsContractFixture>
  coldRecover(): Promise<ToolsColdProof>
}
function assert(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`Tools fixed-text contract: ${detail}`)
}
function value<T>(outcome: Outcome<T>): T {
  assert(outcome.ok, outcome.ok ? '' : outcome.error.detailCode)
  return outcome.value
}
export async function runToolsContractScenario(
  scenario: ScenarioName,
  binding: Pick<ToolsContractBinding, 'open' | 'coldRecover'>,
) {
  if (scenario === 'recover') {
    const proof = await binding.coldRecover()
    assert(
      proof.firstPid > 0 && proof.recoveredPid > 0 && proof.firstPid !== proof.recoveredPid,
      'fresh-process',
    )
    assert(
      proof.original === proof.recovered && /^[a-f0-9]{64}$/.test(proof.original),
      'fixed-pure-recomputation',
    )
    assert(
      /^[a-f0-9]{64}$/.test(proof.inputDigest) && /^[a-f0-9]{64}$/.test(proof.configurationDigest),
      'cold-fixed-input-proof',
    )
    return { configDigest: proof.configurationDigest, inputDigest: proof.inputDigest }
  }
  const fixture = await binding.open()
  const provider = await fixture.factory.create(
    fixture.configuration,
    fixture.dependencies,
    fixture.factoryContext,
  )
  let action: LeafActionProvider | undefined
  try {
    value(await provider.ready(fixture.call))
    const target: BindingRef = {
      bindingId: fixture.factoryContext.bindingId,
      contract: 'agh.tools',
      logicalName: fixture.factory.descriptor.logicalName,
      providerId: fixture.factory.descriptor.providerId,
    }
    const container = createTestServiceContainer(),
      requirement = {
        contract: 'agh.tools',
        major: 1,
        logicalName: target.logicalName,
        features: [],
        scope: 'workspace' as const,
        optional: false,
      }
    assert(provider.query && provider.compute, 'read-methods')
    container.register({ binding: target, requirement, query: provider.query, compute: provider.compute })
    const service = value(container.dependencies.get(requirement))
    const describe = () =>
      service.query({ target, method: 'describe', input: fixture.describe }, fixture.call)
    const classify = () =>
      service.compute({ target, method: 'classify', input: fixture.classify }, fixture.call)
    const created = await provider.actions?.invoke?.create({
      instanceId: fixture.factoryContext.instanceId,
      actionId: fixture.frame.actionId,
      runId: fixture.frame.runId,
      bindingId: fixture.frame.bindingId,
      scope: fixture.call.scope,
      signal: fixture.call.signal,
    })
    assert(created?.kind === 'leaf', 'real-leaf-selected')
    action = created
    const execute = (frame = fixture.frame, context = fixture.actionContext) =>
      created.execute(frame, context)
    if (scenario === 'select') {
      assert(validateRuntime('ProviderDescriptor', fixture.factory.descriptor).ok, 'official-descriptor')
      const described = value(await describe())
      assert(
        described.kind === 'value' &&
          described.output.kind === 'inline' &&
          validateRuntime('ToolDefinition', described.output.value).ok,
        'fixed-description',
      )
      const policy = value(await classify())
      assert(
        policy.kind === 'inline' && validateRuntime('ToolPolicySnapshot', policy.value).ok,
        'official-policy',
      )
      const catalog = value(
        await service.compute({ target, method: 'catalog', input: fixture.catalog }, fixture.call),
      )
      assert(catalog.kind === 'inline' && validateRuntime('ToolCatalog', catalog.value).ok, 'fixed-catalog')
    } else if (scenario === 'normal') {
      const result = await execute()
      assert(result.outcome === 'succeeded' && result.result?.kind === 'inline', 'real-tool-success')
      assert(
        canonicalJsonDigest(result.result.schema) === canonicalJsonDigest(RuntimeSchemaRefs.ToolResult),
        'tool-result-schema',
      )
      const parsed = validateRuntime('ToolResult', result.result.value)
      assert(parsed.ok && parsed.value.output.kind === 'inline', 'tool-result-shape')
      assert(
        canonicalJsonDigest(parsed.value.output.value) ===
          canonicalJsonDigest(JSON.parse(JSON.stringify(fixture.expected))),
        'observable-statistics',
      )
      assert(
        parsed.value.details === undefined &&
          canonicalJsonDigest(parsed.value.provenance.trustLabels) === canonicalJsonDigest(['derived']),
        'model-safe-source',
      )
      assert(fixture.effectsCount() === 0 && result.externalRequests.length === 0, 'no-pure-effects')
    } else if (scenario === 'deny') {
      fixture.revoke()
      assert(!(await describe()).ok && !(await classify()).ok, 'revoked-source-refused')
      assert(
        (await execute()).outcome !== 'succeeded' && fixture.effectsCount() === 0,
        'revoked-execution-refused',
      )
    } else if (scenario === 'cancel') {
      const controller = new AbortController()
      controller.abort()
      const call = { ...fixture.call, signal: controller.signal }
      assert(
        !(await service.compute({ target, method: 'classify', input: fixture.classify }, call)).ok,
        'cancelled-read-refused',
      )
      const result = await execute(fixture.frame, { ...fixture.actionContext, call })
      assert(result.outcome === 'cancelled' && fixture.effectsCount() === 0, 'cancelled-execution-refused')
    } else {
      value(await provider.drain(fixture.call.deadline, fixture.call))
      assert(!(await describe()).ok && (await execute()).outcome !== 'succeeded', 'old-handles-after-drain')
      await provider.close('shutdown')
      assert(!(await classify()).ok, 'old-handles-after-close')
    }
    return {
      configDigest:
        fixture.configuration.kind === 'inline'
          ? fixture.configuration.digest
          : fixture.configuration.blob.digest,
      inputDigest: fixture.frame.inputDigest,
    }
  } finally {
    await action?.close('shutdown')
    await provider.close('shutdown')
    await fixture.close()
  }
}
export function registerToolsContract(harness: ConformanceHarness, binding: ToolsContractBinding): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.tools',
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      build: binding.build,
      async run() {
        const proof = await runToolsContractScenario(scenario, binding)
        return {
          id: `tools:fixed-text:${binding.providerId}:${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: 'fixed-text-tools-slice',
          features: ['pure-text-statistics'],
          build: binding.build,
          consumer: 'selected-public-service-and-tools-leaf',
          command: binding.command,
          status: 'passed',
          diagnostic:
            'Fixed pure tools slice only; production Effects/receipt owner and full Tools card remain incomplete',
          configDigest: proof.configDigest,
          releaseSetDigest: proof.inputDigest,
          attachmentDigest: null,
          fixture: 'test-service-container',
          sharedEvidenceId: null,
        }
      },
    })
}
