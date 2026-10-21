import {
  type SandboxEnforcement,
  type SandboxExecutionPolicy,
  sandboxUnavailable,
} from '@agnes/extension-api'
import { openLoopbackGate } from './loopback-gate.js'

/** Called after tool admission. Only a private transport fd crosses the revocable Host gate. */
export function loopbackActivation(policy: SandboxExecutionPolicy, actual: SandboxEnforcement, os: string) {
  if (policy.network.mode !== 'loopback-serve') return undefined
  if (
    os !== 'darwin' ||
    actual.level !== 'full' ||
    !(['file', 'network', 'process'] as const).every((scope) => actual.scope.includes(scope))
  )
    throw sandboxUnavailable('loopback socket activation requires macOS L1 network enforcement')
  return openLoopbackGate()
}
