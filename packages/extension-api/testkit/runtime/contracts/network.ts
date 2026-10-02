import { type BuildIdentity, type Qualification, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, ConformanceHarness } from '../harness.js'

const HEX = /^[a-f0-9]{64}$/

const FEATURES: readonly string[] = ['request']

export interface NetworkScenarioEvidence {
  readonly passed: boolean
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly detail: string
}

export interface NetworkPort {
  readonly recipe: string
  readonly features?: readonly string[]
  readonly qualification?: Qualification
  readonly scenarios?: readonly ScenarioName[]
  select(): Promise<NetworkScenarioEvidence>
  normal(): Promise<NetworkScenarioEvidence>
  deny(): Promise<NetworkScenarioEvidence>
  cancel(): Promise<NetworkScenarioEvidence>
  recover(): Promise<NetworkScenarioEvidence>
  dispose(): Promise<NetworkScenarioEvidence>
}

export interface NetworkConformanceBinding {
  readonly command: string
  readonly build: BuildIdentity
  readonly sources: readonly NetworkPort[]
  readonly providerId?: string
}

function complete(evidence: NetworkScenarioEvidence): boolean {
  return (
    evidence.passed &&
    evidence.detail !== '' &&
    HEX.test(evidence.providerDigest) &&
    HEX.test(evidence.configDigest) &&
    HEX.test(evidence.releaseSetDigest)
  )
}

export function registerNetworkContract(
  harness: ConformanceHarness,
  binding: NetworkConformanceBinding,
): void {
  const providerId = binding.providerId ?? 'default'
  for (const source of binding.sources) {
    const scenarios = source.scenarios ?? SCENARIOS
    const qualification = source.qualification ?? 'required'
    for (const scenario of scenarios) {
      harness.registerCase({
        contract: 'agh.network',
        scenario,
        qualification,
        providerId,
        async run(context): Promise<AssertionInput> {
          const evidence = await source[context.scenario]()
          return {
            id: `agh.network/${context.providerId}/${source.recipe}/${context.scenario}`,
            providerDigest: evidence.providerDigest,
            recipe: source.recipe,
            features: [...(source.features ?? FEATURES)],
            build: binding.build,
            consumer: 'network-consumer',
            command: binding.command,
            status: complete(evidence) ? 'passed' : 'failed',
            configDigest: evidence.configDigest,
            releaseSetDigest: evidence.releaseSetDigest,
            attachmentDigest: null,
            fixture: 'restricted-effects',
            sharedEvidenceId: null,
          }
        },
      })
    }
  }
}
