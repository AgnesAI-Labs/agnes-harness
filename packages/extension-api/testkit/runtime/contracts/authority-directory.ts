import { type BuildIdentity, type ReuseLifecycle, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, ConformanceHarness } from '../harness.js'

const HEX = /^[a-f0-9]{64}$/

const FEATURES: Record<ScenarioName, readonly string[]> = {
  select: ['read'],
  normal: ['read', 'compareAndSwap'],
  deny: ['read'],
  cancel: ['read'],
  recover: ['compareAndSwap'],
  dispose: ['read'],
}

export interface AuthorityDirectoryScenarioEvidence {
  readonly passed: boolean
  readonly status?: 'skipped'
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly detail: string
}

/** One authority directory provider. The registrar does not import an implementation. */
export interface AuthorityDirectoryPort {
  readonly recipe: 'default' | 'reference'
  select(): Promise<AuthorityDirectoryScenarioEvidence>
  normal(): Promise<AuthorityDirectoryScenarioEvidence>
  deny(): Promise<AuthorityDirectoryScenarioEvidence>
  cancel(): Promise<AuthorityDirectoryScenarioEvidence>
  recover(): Promise<AuthorityDirectoryScenarioEvidence>
  dispose(): Promise<AuthorityDirectoryScenarioEvidence>
}

export interface AuthorityDirectoryConformanceBinding {
  readonly command: string
  readonly build: BuildIdentity
  readonly port: AuthorityDirectoryPort
  readonly providerId: string
}

function complete(evidence: AuthorityDirectoryScenarioEvidence): boolean {
  return (
    evidence.passed &&
    evidence.detail !== '' &&
    HEX.test(evidence.providerDigest) &&
    HEX.test(evidence.configDigest) &&
    HEX.test(evidence.releaseSetDigest)
  )
}

function lifecycle(scenario: ScenarioName): ReuseLifecycle {
  if (scenario === 'cancel' || scenario === 'recover' || scenario === 'dispose') return scenario
  return 'call'
}

/**
 * Register select, normal, deny, cancel, recover, and dispose.
 * Callers supply the provider. This registrar does not import an implementation.
 */
export function registerAuthorityDirectoryContract(
  harness: ConformanceHarness,
  binding: AuthorityDirectoryConformanceBinding,
): void {
  const port = binding.port
  for (const scenario of SCENARIOS) {
    harness.registerCase({
      contract: 'agh.authority-directory',
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      build: binding.build,
      async run(context): Promise<AssertionInput> {
        const evidence = await port[context.scenario]()
        return {
          id: `agh.authority-directory/${port.recipe}/${context.scenario}`,
          providerDigest: evidence.providerDigest,
          recipe: port.recipe,
          features: [...FEATURES[context.scenario]],
          build: binding.build,
          consumer: 'authority-directory-consumer',
          command: binding.command,
          status: evidence.status === 'skipped' ? 'skipped' : complete(evidence) ? 'passed' : 'failed',
          ...(evidence.status === 'skipped' ? { diagnostic: evidence.detail } : {}),
          configDigest: evidence.configDigest,
          releaseSetDigest: evidence.releaseSetDigest,
          attachmentDigest: null,
          fixture: null,
          sharedEvidenceId: null,
          reuse: {
            scope: 'deployment',
            methodKind: 'maintenance',
            lifecycle: lifecycle(context.scenario),
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
  }
}
