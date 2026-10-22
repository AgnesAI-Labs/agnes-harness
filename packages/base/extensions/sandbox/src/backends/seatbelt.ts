import { seatbeltDenyNetworkArgv } from '../../../../src/sandbox-seatbelt.js'
import type { ClosedNetworkConfineOptions } from './shared.js'
import { validateArgv, validateClosedNetworkOptions } from './shared.js'

/**
 * Compile a closed-network Seatbelt argv. The shared compiler escapes both backslashes and quotes,
 * grants only /dev/null as an implicit writable device (no temp writes), and applies every
 * explicit deny to reads and writes, including the standard device literals.
 */
export function seatbeltConfine(
  argv: readonly string[],
  options: ClosedNetworkConfineOptions,
  jobControl = true,
): string[] {
  const command = validateArgv(argv)
  const policy = validateClosedNetworkOptions(options)
  return seatbeltDenyNetworkArgv(command, {
    allowPaths: policy.allowPaths,
    ...(policy.loopbackServe ? { loopbackServe: true } : {}),
    denyPaths: policy.denyPaths,
    ...(jobControl ? {} : { jobControl: false }),
    ...(policy.readPaths ? { readPaths: policy.readPaths } : {}),
    ...(policy.network ? { network: policy.network } : {}),
  })
}
