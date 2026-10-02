import { type BuildIdentity, type Qualification, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, ConformanceHarness } from '../harness.js'

const HEX = /^[a-f0-9]{64}$/

const FEATURES: Record<ScenarioName, readonly string[]> = {
  select: ['list'],
  normal: ['read', 'write'],
  deny: ['write'],
  cancel: ['write'],
  recover: ['read', 'write'],
  dispose: ['read'],
}

export interface FilesScenarioEvidence {
  readonly passed: boolean
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly detail: string
}

export interface FilesPort {
  readonly recipe: string
  readonly qualification?: Qualification
  readonly scenarios?: readonly ScenarioName[]
  select(): Promise<FilesScenarioEvidence>
  normal(): Promise<FilesScenarioEvidence>
  deny(): Promise<FilesScenarioEvidence>
  cancel(): Promise<FilesScenarioEvidence>
  recover(): Promise<FilesScenarioEvidence>
  dispose(): Promise<FilesScenarioEvidence>
}

export interface FilesConformanceBinding {
  readonly command: string
  readonly build: BuildIdentity
  readonly sources: readonly FilesPort[]
  readonly providerId?: string
}

function complete(evidence: FilesScenarioEvidence): boolean {
  return (
    evidence.passed &&
    evidence.detail !== '' &&
    HEX.test(evidence.providerDigest) &&
    HEX.test(evidence.configDigest) &&
    HEX.test(evidence.releaseSetDigest)
  )
}

export function registerFilesContract(harness: ConformanceHarness, binding: FilesConformanceBinding): void {
  const providerId = binding.providerId ?? 'default'
  for (const source of binding.sources) {
    const scenarios = source.scenarios ?? SCENARIOS
    const qualification = source.qualification ?? 'required'
    for (const scenario of scenarios) {
      harness.registerCase({
        contract: 'agh.files',
        scenario,
        qualification,
        providerId,
        async run(context): Promise<AssertionInput> {
          const evidence = await source[context.scenario]()
          return {
            id: `agh.files/${context.providerId}/${source.recipe}/${context.scenario}`,
            providerDigest: evidence.providerDigest,
            recipe: source.recipe,
            features: [...FEATURES[context.scenario]],
            build: binding.build,
            consumer: 'files-consumer',
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
