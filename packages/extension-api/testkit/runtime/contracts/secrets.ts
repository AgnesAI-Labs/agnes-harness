import { type BuildIdentity, type Qualification, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, ConformanceHarness } from '../harness.js'

const HEX = /^[a-f0-9]{64}$/

const FEATURES: readonly string[] = ['resolve', 'rotate', 'revoke']

export interface SecretsScenarioEvidence {
  readonly passed: boolean
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly detail: string
}

export interface SecretsPort {
  readonly recipe: string
  readonly features?: readonly string[]
  readonly qualification?: Qualification
  readonly scenarios?: readonly ScenarioName[]
  select(): Promise<SecretsScenarioEvidence>
  normal(): Promise<SecretsScenarioEvidence>
  deny(): Promise<SecretsScenarioEvidence>
  cancel(): Promise<SecretsScenarioEvidence>
  recover(): Promise<SecretsScenarioEvidence>
  dispose(): Promise<SecretsScenarioEvidence>
}

export interface SecretsConformanceBinding {
  readonly command: string
  readonly build: BuildIdentity
  readonly sources: readonly SecretsPort[]
  readonly providerId?: string
}

function complete(evidence: SecretsScenarioEvidence): boolean {
  return (
    evidence.passed &&
    evidence.detail !== '' &&
    HEX.test(evidence.providerDigest) &&
    HEX.test(evidence.configDigest) &&
    HEX.test(evidence.releaseSetDigest)
  )
}

export function registerSecretsContract(
  harness: ConformanceHarness,
  binding: SecretsConformanceBinding,
): void {
  const providerId = binding.providerId ?? 'default'
  for (const source of binding.sources) {
    const scenarios = source.scenarios ?? SCENARIOS
    const qualification = source.qualification ?? 'required'
    for (const scenario of scenarios) {
      harness.registerCase({
        contract: 'agh.secrets',
        scenario,
        qualification,
        providerId,
        async run(context): Promise<AssertionInput> {
          const evidence = await source[context.scenario]()
          return {
            id: `agh.secrets/${context.providerId}/${source.recipe}/${context.scenario}`,
            providerDigest: evidence.providerDigest,
            recipe: source.recipe,
            features: [...(source.features ?? FEATURES)],
            build: binding.build,
            consumer: 'secrets-consumer',
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
