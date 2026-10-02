import { type BuildIdentity, type Qualification, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, ConformanceHarness } from '../harness.js'

const HEX = /^[a-f0-9]{64}$/

const FEATURES: Record<ScenarioName, readonly string[]> = {
  select: ['acquire', 'release'],
  normal: ['acquire', 'release'],
  deny: ['acquire'],
  cancel: ['acquire'],
  recover: ['acquire', 'release'],
  dispose: ['acquire'],
}

export interface WorkspaceScenarioEvidence {
  readonly passed: boolean
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly detail: string
}

export interface WorkspacePort {
  readonly recipe: string
  readonly qualification?: Qualification
  readonly scenarios?: readonly ScenarioName[]
  select(): Promise<WorkspaceScenarioEvidence>
  normal(): Promise<WorkspaceScenarioEvidence>
  deny(): Promise<WorkspaceScenarioEvidence>
  cancel(): Promise<WorkspaceScenarioEvidence>
  recover(): Promise<WorkspaceScenarioEvidence>
  dispose(): Promise<WorkspaceScenarioEvidence>
}

export interface WorkspaceConformanceBinding {
  readonly command: string
  readonly build: BuildIdentity
  readonly sources: readonly WorkspacePort[]
  readonly providerId?: string
}

function complete(evidence: WorkspaceScenarioEvidence): boolean {
  return (
    evidence.passed &&
    evidence.detail !== '' &&
    HEX.test(evidence.providerDigest) &&
    HEX.test(evidence.configDigest) &&
    HEX.test(evidence.releaseSetDigest)
  )
}

export function registerWorkspaceContract(
  harness: ConformanceHarness,
  binding: WorkspaceConformanceBinding,
): void {
  const providerId = binding.providerId ?? 'default'
  for (const source of binding.sources) {
    const scenarios = source.scenarios ?? SCENARIOS
    const qualification = source.qualification ?? 'required'
    for (const scenario of scenarios) {
      harness.registerCase({
        contract: 'agh.workspace',
        scenario,
        qualification,
        providerId,
        async run(context): Promise<AssertionInput> {
          const evidence = await source[context.scenario]()
          return {
            id: `agh.workspace/${context.providerId}/${source.recipe}/${context.scenario}`,
            providerDigest: evidence.providerDigest,
            recipe: source.recipe,
            features: [...FEATURES[context.scenario]],
            build: binding.build,
            consumer: 'workspace-consumer',
            command: binding.command,
            status: complete(evidence) ? 'passed' : 'failed',
            configDigest: evidence.configDigest,
            releaseSetDigest: evidence.releaseSetDigest,
            attachmentDigest: null,
            fixture: null,
            sharedEvidenceId: null,
          }
        },
      })
    }
  }
}
