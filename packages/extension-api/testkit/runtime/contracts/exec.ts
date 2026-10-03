import { type BuildIdentity, type Qualification, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, ConformanceHarness } from '../harness.js'

const HEX = /^[a-f0-9]{64}$/

const FEATURES: readonly string[] = ['run', 'reconcile']

export interface ExecScenarioEvidence {
  readonly passed: boolean
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly detail: string
}

export interface ExecPort {
  readonly recipe: string
  readonly features?: readonly string[]
  readonly qualification?: Qualification
  readonly scenarios?: readonly ScenarioName[]
  select(): Promise<ExecScenarioEvidence>
  normal(): Promise<ExecScenarioEvidence>
  deny(): Promise<ExecScenarioEvidence>
  cancel(): Promise<ExecScenarioEvidence>
  recover(): Promise<ExecScenarioEvidence>
  dispose(): Promise<ExecScenarioEvidence>
}

export interface ExecConformanceBinding {
  readonly command: string
  readonly build: BuildIdentity
  readonly sources: readonly ExecPort[]
  readonly providerId?: string
}

function complete(evidence: ExecScenarioEvidence): boolean {
  return (
    evidence.passed &&
    evidence.detail !== '' &&
    HEX.test(evidence.providerDigest) &&
    HEX.test(evidence.configDigest) &&
    HEX.test(evidence.releaseSetDigest)
  )
}

export function registerExecContract(harness: ConformanceHarness, binding: ExecConformanceBinding): void {
  const providerId = binding.providerId ?? 'default'
  for (const source of binding.sources) {
    const scenarios = source.scenarios ?? SCENARIOS
    const qualification = source.qualification ?? 'required'
    for (const scenario of scenarios) {
      harness.registerCase({
        contract: 'agh.exec',
        scenario,
        qualification,
        providerId,
        build: binding.build,
        async run(context): Promise<AssertionInput> {
          const evidence = await source[context.scenario]()
          return {
            id: `agh.exec/${context.providerId}/${source.recipe}/${context.scenario}`,
            providerDigest: evidence.providerDigest,
            recipe: source.recipe,
            features: [...(source.features ?? FEATURES)],
            build: binding.build,
            consumer: 'exec-consumer',
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
