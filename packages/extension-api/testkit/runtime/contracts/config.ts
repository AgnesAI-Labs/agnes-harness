import { type BuildIdentity, type ReuseLifecycle, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, ConformanceHarness } from '../harness.js'

const HEX = /^[a-f0-9]{64}$/

const FEATURES: Record<ScenarioName, readonly string[]> = {
  select: ['read'],
  normal: ['read', 'resolve'],
  deny: ['resolve'],
  cancel: ['read'],
  recover: ['read'],
  dispose: ['read'],
}

export interface ConfigScenarioEvidence {
  readonly passed: boolean
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly detail: string
}

/** One default config provider backed by either a file source or a fetch source. */
export interface ConfigSourcePort {
  readonly recipe: 'file' | 'fetch'
  select(): Promise<ConfigScenarioEvidence>
  normal(): Promise<ConfigScenarioEvidence>
  deny(): Promise<ConfigScenarioEvidence>
  cancel(): Promise<ConfigScenarioEvidence>
  recover(): Promise<ConfigScenarioEvidence>
  dispose(): Promise<ConfigScenarioEvidence>
}

export interface ConfigConformanceBinding {
  readonly command: string
  readonly build: BuildIdentity
  readonly sources: readonly ConfigSourcePort[]
  readonly providerId?: string
}

function complete(evidence: ConfigScenarioEvidence): boolean {
  return (
    evidence.passed &&
    evidence.detail !== '' &&
    HEX.test(evidence.providerDigest) &&
    HEX.test(evidence.configDigest) &&
    HEX.test(evidence.releaseSetDigest)
  )
}

function lifecycle(scenario: ScenarioName): ReuseLifecycle {
  if (scenario === 'cancel' || scenario === 'recover' || scenario === 'dispose') return scenario
  return 'call'
}

/**
 * Register select, normal, deny, cancel, recover, and dispose for each supplied source.
 * Callers supply the sources. This registrar does not import a provider implementation.
 */
export function registerConfigContract(harness: ConformanceHarness, binding: ConfigConformanceBinding): void {
  const providerId = binding.providerId ?? 'default'
  for (const source of binding.sources) {
    for (const scenario of SCENARIOS) {
      harness.registerCase({
        contract: 'agh.config',
        scenario,
        qualification: 'required',
        providerId,
        async run(context): Promise<AssertionInput> {
          const evidence = await source[context.scenario]()
          return {
            id: `agh.config/${source.recipe}/${context.scenario}`,
            providerDigest: evidence.providerDigest,
            recipe: source.recipe,
            features: [...FEATURES[context.scenario]],
            build: binding.build,
            consumer: 'default-config-consumer',
            command: binding.command,
            status: complete(evidence) ? 'passed' : 'failed',
            configDigest: evidence.configDigest,
            releaseSetDigest: evidence.releaseSetDigest,
            attachmentDigest: null,
            fixture: null,
            sharedEvidenceId: null,
            reuse: {
              scope: 'deployment',
              methodKind: 'compute',
              lifecycle: lifecycle(context.scenario),
              undeclaredConnection: false,
            },
            perImplementation: true,
            gate: null,
          }
        },
      })
    }
  }
}
