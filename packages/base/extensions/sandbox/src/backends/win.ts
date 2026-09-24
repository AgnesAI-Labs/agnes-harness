import type { ClosedNetworkConfineOptions } from './shared.js'
import { backendCompileFault, validateArgv, validateClosedNetworkOptions } from './shared.js'

/**
 * A Windows restricted token cannot be represented by rewriting argv. Refuse the tempting identity
 * transform: the Host must apply and prove the token/job/network boundary at process creation.
 */
export function winConfine(argv: readonly string[], options: ClosedNetworkConfineOptions): never {
  validateArgv(argv)
  validateClosedNetworkOptions(options)
  throw backendCompileFault(
    'E_SANDBOX_HOST_ENFORCEMENT_REQUIRED',
    'Windows confinement must be applied by HostExec',
  )
}
