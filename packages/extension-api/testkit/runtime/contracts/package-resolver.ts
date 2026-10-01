import { type BuildIdentity, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, ConformanceHarness } from '../harness.js'

const HEX = /^[a-f0-9]{64}$/

const FEATURES: Record<ScenarioName, readonly string[]> = {
  select: ['resolve'],
  normal: ['resolve'],
  deny: ['resolve'],
  cancel: ['resolve'],
  recover: ['resolve'],
  dispose: ['resolve'],
}

export interface PackageResolverEvidence {
  readonly passed: boolean
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly detail: string
}

/** One package resolver that computes a lock from an authorized candidate snapshot. */
export interface PackageResolverPort {
  readonly recipe: string
  select(): Promise<PackageResolverEvidence>
  normal(): Promise<PackageResolverEvidence>
  deny(): Promise<PackageResolverEvidence>
  cancel(): Promise<PackageResolverEvidence>
  recover(): Promise<PackageResolverEvidence>
  dispose(): Promise<PackageResolverEvidence>
}

export interface PackageResolverConformanceBinding {
  readonly command: string
  readonly build: BuildIdentity
  readonly sources: readonly PackageResolverPort[]
  readonly providerId?: string
}

function complete(evidence: PackageResolverEvidence): boolean {
  return (
    evidence.passed &&
    evidence.detail !== '' &&
    HEX.test(evidence.providerDigest) &&
    HEX.test(evidence.configDigest) &&
    HEX.test(evidence.releaseSetDigest)
  )
}

/**
 * Register select, normal, deny, cancel, recover, and dispose for each supplied resolver.
 * The caller chooses the provider token that the harness matches.
 */
export function registerPackageResolverContract(
  harness: ConformanceHarness,
  binding: PackageResolverConformanceBinding,
): void {
  const providerId = binding.providerId ?? 'default'
  for (const source of binding.sources) {
    for (const scenario of SCENARIOS) {
      harness.registerCase({
        contract: 'agh.package-resolver',
        scenario,
        qualification: 'required',
        providerId,
        async run(context): Promise<AssertionInput> {
          const evidence = await source[context.scenario]()
          return {
            id: `agh.package-resolver/${context.providerId}/${source.recipe}/${context.scenario}`,
            providerDigest: evidence.providerDigest,
            recipe: source.recipe,
            features: [...FEATURES[context.scenario]],
            build: binding.build,
            consumer: 'package-resolver-consumer',
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
