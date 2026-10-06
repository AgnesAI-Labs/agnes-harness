import { contracts } from '@agnes/extension-api/testkit'
import type { BindingRef, StateAuthorityRef } from '@agnes/protocol/runtime'
import type { HostProjectionInstallation } from '../src/runtime/projection-owner.js'

/** Synthetic domain registration with no C14 issuer or backend write/resolve rights. */
export function createProjectionInstallationFixture(
  binding: BindingRef,
  authority: StateAuthorityRef,
): HostProjectionInstallation {
  const fixture = contracts.createProjectionFixture()
  return {
    binding,
    domain: fixture.domain,
    access: fixture.gate,
    reads: {
      query: async () => {
        throw new Error('Fixture has no authorized dependency reads')
      },
      resolveData: async () => {
        throw new Error('Fixture has no authorized data reads')
      },
    },
    owner: {
      namespace: 'fixture',
      authorityId: authority.authorityId,
      aggregate: { typeId: 'fixture/board@1', id: 'board' },
      source: binding,
      stateSchema: fixture.domain.commandStateSchema,
      destination: 'fixture-inbox',
      clock: {
        now: () => new Date().toISOString(),
        newId: () => {
          throw new Error('Fixture has no command issuer')
        },
      },
    },
  }
}
