import { seatbeltDenyNetworkArgv } from '../../../../src/sandbox-seatbelt.js'
import type { ClosedNetworkConfineOptions } from './shared.js'
import { validateArgv, validateClosedNetworkOptions } from './shared.js'

/**
 * Compile a closed-network Seatbelt argv. The shared compiler escapes both backslashes and quotes,
 * never grants /private/tmp or /dev implicitly, and applies every explicit deny to reads and writes.
 */
export function seatbeltConfine(argv: readonly string[], options: ClosedNetworkConfineOptions): string[] {
  const command = validateArgv(argv)
  const policy = validateClosedNetworkOptions(options)
  return seatbeltDenyNetworkArgv(command, {
    allowPaths: policy.allowPaths,
    denyPaths: policy.denyPaths,
  })
}
