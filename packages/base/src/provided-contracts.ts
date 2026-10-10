import * as gitWorktreeContract from '@agnes/git-worktree-contract'
import * as intelligentUiContract from '@agnes/intelligent-ui-contract'
import * as observabilityContract from '@agnes/observability/contract'
import { registerProvidedExternal } from '@agnes/plugin-runtime/provided-externals'
import * as protocol from '@agnes/protocol'

/** Registers the contract namespaces this process imported. Idempotent for the same objects. */
export function bindProvidedContractModules(): void {
  registerProvidedExternal('@agnes/protocol', protocol)
  registerProvidedExternal('@agnes/observability/contract', observabilityContract)
  registerProvidedExternal('@agnes/git-worktree-contract', gitWorktreeContract)
  registerProvidedExternal('@agnes/intelligent-ui-contract', intelligentUiContract)
}
