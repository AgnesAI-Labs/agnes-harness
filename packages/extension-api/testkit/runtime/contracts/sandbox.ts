import { type BuildIdentity, type Qualification, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, ConformanceHarness } from '../harness.js'

const HEX = /^[a-f0-9]{64}$/

const FEATURES: readonly string[] = ['create', 'stop', 'inspect']

export interface SandboxScenarioEvidence {
  readonly passed: boolean
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly detail: string
}

export interface SandboxPort {
  readonly recipe: string
  readonly features?: readonly string[]
  readonly qualification?: Qualification
  readonly scenarios?: readonly ScenarioName[]
  select(): Promise<SandboxScenarioEvidence>
  normal(): Promise<SandboxScenarioEvidence>
  deny(): Promise<SandboxScenarioEvidence>
  cancel(): Promise<SandboxScenarioEvidence>
  recover(): Promise<SandboxScenarioEvidence>
  dispose(): Promise<SandboxScenarioEvidence>
}

export interface SandboxConformanceBinding {
  readonly command: string
  readonly build: BuildIdentity
  readonly sources: readonly SandboxPort[]
  readonly providerId?: string
}

function complete(evidence: SandboxScenarioEvidence): boolean {
  return (
    evidence.passed &&
    evidence.detail !== '' &&
    HEX.test(evidence.providerDigest) &&
    HEX.test(evidence.configDigest) &&
    HEX.test(evidence.releaseSetDigest)
  )
}

export function registerSandboxContract(
  harness: ConformanceHarness,
  binding: SandboxConformanceBinding,
): void {
  const providerId = binding.providerId ?? 'default'
  for (const source of binding.sources) {
    const scenarios = source.scenarios ?? SCENARIOS
    const qualification = source.qualification ?? 'required'
    for (const scenario of scenarios) {
      harness.registerCase({
        contract: 'agh.sandbox',
        scenario,
        qualification,
        providerId,
        build: binding.build,
        async run(context): Promise<AssertionInput> {
          const evidence = await source[context.scenario]()
          return {
            id: `agh.sandbox/${context.providerId}/${source.recipe}/${context.scenario}`,
            providerDigest: evidence.providerDigest,
            recipe: source.recipe,
            features: [...(source.features ?? FEATURES)],
            build: binding.build,
            consumer: 'sandbox-consumer',
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
