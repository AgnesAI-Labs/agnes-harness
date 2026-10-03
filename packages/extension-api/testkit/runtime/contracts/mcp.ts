import { type BuildIdentity, type Qualification, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'

export interface McpScenarioEvidence {
  readonly passed: boolean
  readonly detail: string
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
}
export interface McpPort {
  readonly recipe: string
  readonly features: readonly string[]
  readonly qualification?: Qualification
  readonly scenarios?: readonly ScenarioName[]
  select(): Promise<McpScenarioEvidence>
  normal(): Promise<McpScenarioEvidence>
  deny(): Promise<McpScenarioEvidence>
  cancel(): Promise<McpScenarioEvidence>
  recover(): Promise<McpScenarioEvidence>
  dispose(): Promise<McpScenarioEvidence>
}
export function registerMcpContract(
  harness: ConformanceHarness,
  binding: {
    readonly providerId: string
    readonly command: string
    readonly build: BuildIdentity
    readonly sources: readonly McpPort[]
  },
): void {
  for (const source of binding.sources)
    for (const scenario of source.scenarios ?? SCENARIOS)
      harness.registerCase({
        contract: 'agh.mcp',
        scenario,
        providerId: binding.providerId,
        qualification: source.qualification ?? 'required',
        async run() {
          const evidence = await source[scenario]()
          const passed =
            evidence.passed &&
            evidence.detail.length > 0 &&
            [evidence.providerDigest, evidence.configDigest, evidence.releaseSetDigest].every((value) =>
              /^[a-f0-9]{64}$/.test(value),
            )
          return {
            id: `agh.mcp/${binding.providerId}/${source.recipe}/${scenario}`,
            providerDigest: evidence.providerDigest,
            recipe: source.recipe,
            features: [...source.features],
            build: binding.build,
            consumer: 'mcp-tools-consumer',
            command: binding.command,
            status: passed ? 'passed' : 'failed',
            configDigest: evidence.configDigest,
            releaseSetDigest: evidence.releaseSetDigest,
            attachmentDigest: null,
            fixture: 'restricted-effects',
            sharedEvidenceId: null,
          }
        },
      })
}
