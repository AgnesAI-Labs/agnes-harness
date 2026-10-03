import { type BuildIdentity, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'

export interface TicketKeyScenarioEvidence {
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
}
export interface ArtifactTicketKeyConformanceBinding {
  readonly command: string
  readonly build: BuildIdentity
  readonly providerId: string
  readonly recipe: string
  readonly run: (scenario: ScenarioName) => Promise<TicketKeyScenarioEvidence>
}
/** Registers Local companion evidence under Secrets; no Wire service is added. */
export function registerArtifactTicketKeyContract(
  harness: ConformanceHarness,
  binding: ArtifactTicketKeyConformanceBinding,
): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.secrets',
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run() {
        const evidence = await binding.run(scenario)
        return {
          id: `agh.secrets/${binding.providerId}/${binding.recipe}/${scenario}`,
          providerDigest: evidence.providerDigest,
          configDigest: evidence.configDigest,
          releaseSetDigest: evidence.releaseSetDigest,
          recipe: binding.recipe,
          features: ['local-artifact-ticket-key'],
          build: binding.build,
          consumer: 'restricted-artifact-issuer',
          command: binding.command,
          status: [evidence.providerDigest, evidence.configDigest, evidence.releaseSetDigest].every((value) =>
            /^[a-f0-9]{64}$/u.test(value),
          )
            ? 'passed'
            : 'failed',
          attachmentDigest: null,
          fixture: 'restricted-effects',
          sharedEvidenceId: null,
        }
      },
    })
}
