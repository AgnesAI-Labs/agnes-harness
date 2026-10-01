import type {
  AuthorSchema,
  BoundService,
  EmptyAuthorConfig,
  Outcome,
  PolicyDecision,
  PolicyEvaluateRequest,
  ProviderDescriptor,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import type { PolicyContractFixture } from '@agnes/extension-api/testkit'
import { runPolicyContractScenario } from '@agnes/extension-api/testkit'
import type { PolicyAuthority } from '../../../packages/core/src/runtime/policy/authority.js'
import { createDefaultPolicyFactory } from '../../../packages/core/src/runtime/providers/policy.js'

export const buildPolicy: (
  descriptor: ProviderDescriptor,
  authority: PolicyAuthority,
  schema: AuthorSchema<EmptyAuthorConfig>,
) => ProviderFactory<ServiceProvider> = createDefaultPolicyFactory
export const testPolicy: (fixture: () => Promise<PolicyContractFixture>) => Promise<unknown> = (fixture) =>
  runPolicyContractScenario('recover', fixture)
export function consumeCanonicalDecision(
  input: PolicyEvaluateRequest,
  decision: Outcome<PolicyDecision>,
): string {
  return decision.ok ? `${input.principalRef}/${decision.value.decision}` : decision.error.code
}
export function rejectControlProjection(bound: BoundService): void {
  // @ts-expect-error Host alone owns management dispatch; a client-bound service cannot revoke a grant.
  bound.control
}
