import { type BuildIdentity, type Qualification, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, ConformanceHarness } from '../harness.js'

const HEX = /^[a-f0-9]{64}$/

const FEATURES: Record<ScenarioName, readonly string[]> = {
  select: ['discover'],
  normal: ['discover', 'fetch'],
  deny: ['fetch'],
  cancel: ['fetch'],
  recover: ['fetch'],
  dispose: ['discover'],
}

export interface PackageScenarioEvidence {
  readonly passed: boolean
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly detail: string
}

/** One package source backed by an authorized local snapshot. */
export interface PackageSourcePort {
  readonly recipe: string
  readonly qualification?: Qualification
  readonly scenarios?: readonly ScenarioName[]
  select(): Promise<PackageScenarioEvidence>
  normal(): Promise<PackageScenarioEvidence>
  deny(): Promise<PackageScenarioEvidence>
  cancel(): Promise<PackageScenarioEvidence>
  recover(): Promise<PackageScenarioEvidence>
  dispose(): Promise<PackageScenarioEvidence>
}

export interface PackageSourceConformanceBinding {
  readonly command: string
  readonly build: BuildIdentity
  readonly sources: readonly PackageSourcePort[]
  readonly providerId?: string
}

function complete(evidence: PackageScenarioEvidence): boolean {
  return (
    evidence.passed &&
    evidence.detail !== '' &&
    HEX.test(evidence.providerDigest) &&
    HEX.test(evidence.configDigest) &&
    HEX.test(evidence.releaseSetDigest)
  )
}

/**
 * Register select, normal, deny, cancel, recover, and dispose for each supplied source.
 * The caller chooses the provider token that the harness matches.
 */
export function registerPackageSourceContract(
  harness: ConformanceHarness,
  binding: PackageSourceConformanceBinding,
): void {
  const providerId = binding.providerId ?? 'default'
  for (const source of binding.sources) {
    const scenarios = source.scenarios ?? SCENARIOS
    const qualification = source.qualification ?? 'required'
    for (const scenario of scenarios) {
      harness.registerCase({
        contract: 'agh.package-source',
        scenario,
        qualification,
        providerId,
        async run(context): Promise<AssertionInput> {
          const evidence = await source[context.scenario]()
          return {
            id: `agh.package-source/${context.providerId}/${source.recipe}/${context.scenario}`,
            providerDigest: evidence.providerDigest,
            recipe: source.recipe,
            features: [...FEATURES[context.scenario]],
            build: binding.build,
            consumer: 'package-source-consumer',
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
